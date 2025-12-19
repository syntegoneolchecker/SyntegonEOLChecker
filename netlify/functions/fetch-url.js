// Fetch a single URL - trigger Render scraping with callback OR use BrowserQL for Cloudflare-protected sites
const { markUrlFetching, saveUrlResult, getJob } = require('./lib/job-storage');
const { scrapeWithBrowserQL } = require('./lib/browserql-scraper');
const { retryWithBackoff } = require('./lib/retry-helpers');
const config = require('./lib/config');

/**
 * Check if Render scraping service is healthy
 */
async function checkRenderHealth(scrapingServiceUrl) {
    try {
        const response = await fetch(`${scrapingServiceUrl}/health`, {
            signal: AbortSignal.timeout(5000)
        });
        return response.ok;
    } catch (error) {
        console.error('Render health check failed:', error.message);
        return false;
    }
}

/**
 * Scrape NBK search page using BrowserQL to extract product URL
 * Step 1 of 2-step hybrid process: BrowserQL search (bypasses Cloudflare) → Render with language parameter (forces Japanese site)
 * Appends ?SelectedLanguage=ja-JP to force Japanese content
 */
async function scrapeNBKSearchWithBrowserQL(model) {
    const browserqlApiKey = process.env.BROWSERQL_API_KEY;

    if (!browserqlApiKey) {
        throw new Error('BROWSERQL_API_KEY environment variable not set');
    }

    // Preprocess model name: remove lowercase 'x' and '-'
    const preprocessedModel = model.replaceAll('x', '').replaAll('-'/g, '');
    console.log(`NBK BrowserQL: Preprocessed model name: ${model} -> ${preprocessedModel}`);

    const encodedModel = encodeURIComponent(preprocessedModel);
    const searchUrl = `https://www.nbk1560.com/search/?q=${encodedModel}&SelectedLanguage=ja-JP&page=1&imgsize=1&doctype=all&sort=0&pagemax=10&htmlLang=ja`;

    console.log(`NBK BrowserQL: Searching at ${searchUrl}`);

    // BrowserQL mutation to search page (extract product URL only)
    const searchQuery = `
        mutation NBKSearch($searchUrl: String!) {
            goto(url: $searchUrl, waitUntil: networkIdle) {
                status
            }

            searchInfo: evaluate(content: """
            (() => {
                try {
                    const bodyDiv = document.querySelector('.topListSection-body');
                    const items = bodyDiv ? bodyDiv.querySelectorAll('._item') : [];
                    const hasResults = items.length > 0;

                    let productUrl = null;
                    if (hasResults) {
                        const firstItem = items[0];
                        const linkElement = firstItem.querySelector('a._link');
                        if (linkElement) {
                            const href = linkElement.getAttribute('href') || '';
                            productUrl = href.startsWith('http')
                                ? href
                                : \`https://www.nbk1560.com\${href}\`;
                        }
                    }

                    return JSON.stringify({
                        hasResults,
                        productUrl,
                        error: null
                    });
                } catch (e) {
                    return JSON.stringify({
                        hasResults: false,
                        productUrl: null,
                        error: (e?.message ?? String(e))
                    });
                }
            })()
            """) {
                value
            }
        }
    `;

    const searchResponse = await fetch(`https://production-sfo.browserless.io/stealth/bql?token=${browserqlApiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            query: searchQuery,
            variables: { searchUrl }
        })
    });

    if (!searchResponse.ok) {
        const errorText = await searchResponse.text();
        throw new Error(`NBK BrowserQL search failed: ${searchResponse.status} - ${errorText}`);
    }

    const searchResult = await searchResponse.json();

    if (searchResult.errors) {
        throw new Error(`NBK BrowserQL search errors: ${JSON.stringify(searchResult.errors)}`);
    }

    if (!searchResult.data?.searchInfo) {
        throw new Error('NBK BrowserQL search returned no data');
    }

    // Parse search results
    const searchInfo = JSON.parse(searchResult.data.searchInfo.value);
    console.log(`NBK BrowserQL: Search results:`, searchInfo);

    if (searchInfo.error) {
        throw new Error(`NBK search page evaluation error: ${searchInfo.error}`);
    }

    // Append language parameter to force Japanese site
    let productUrl = searchInfo.productUrl;
    if (productUrl) {
        productUrl = productUrl + '?SelectedLanguage=ja-JP';
        console.log(`NBK BrowserQL: Added language parameter to URL: ${productUrl}`);
    }

    return {
        hasResults: searchInfo.hasResults,
        productUrl: productUrl,
        preprocessedModel: preprocessedModel
    };
}

/**
 * Scrape NBK product page using BrowserQL (with language parameter)
 * Step 2 of 2-step process: Product page scraping (bypasses Cloudflare)
 */
async function scrapeNBKProductWithBrowserQL(productUrl) {
    const browserqlApiKey = process.env.BROWSERQL_API_KEY;

    if (!browserqlApiKey) {
        throw new Error('BROWSERQL_API_KEY environment variable not set');
    }

    console.log(`NBK BrowserQL: Scraping product page: ${productUrl}`);

    // BrowserQL mutation to scrape product page
    const productQuery = `
        mutation NBKProductPage($productUrl: String!) {
            goto(url: $productUrl, waitUntil: networkIdle) {
                status
            }
            productContent: text(selector: "body") {
                text
            }
        }
    `;

    const productResponse = await fetch(`https://production-sfo.browserless.io/stealth/bql?token=${browserqlApiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            query: productQuery,
            variables: { productUrl }
        })
    });

    if (!productResponse.ok) {
        const errorText = await productResponse.text();
        throw new Error(`NBK BrowserQL product page failed: ${productResponse.status} - ${errorText}`);
    }

    const productResult = await productResponse.json();

    if (productResult.errors) {
        throw new Error(`NBK BrowserQL product errors: ${JSON.stringify(productResult.errors)}`);
    }

    if (!productResult.data?.productContent) {
        throw new Error('NBK BrowserQL product page returned no data');
    }

    const content = productResult.data.productContent.text;

    if (!content) {
        throw new Error('NBK BrowserQL returned empty content');
    }

    console.log(`NBK BrowserQL: Successfully scraped product page (${content.length} characters)`);

    return {
        content,
        success: true
    };
}

exports.handler = async function(event, context) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const requestBody = JSON.parse(event.body);
        console.log(`[FETCH-URL DEBUG] Raw request body:`, JSON.stringify(requestBody, null, 2));

        const { jobId, urlIndex, url, title, snippet, scrapingMethod, model, jpUrl, usUrl } = requestBody;

        console.log(`Fetching URL ${urlIndex} for job ${jobId}: ${url} (method: ${scrapingMethod || 'render'})`);
        console.log(`[FETCH-URL DEBUG] Extracted values: jpUrl=${jpUrl}, usUrl=${usUrl}, model=${model}`);

        const baseUrl = constructBaseUrl(event.headers);
        
        // Mark as fetching
        await markUrlFetching(jobId, urlIndex, context);

        // Prepare common params for all handlers
        const handlerParams = {
            jobId, 
            urlIndex, 
            url, 
            title, 
            snippet, 
            model, 
            jpUrl, 
            usUrl, 
            baseUrl, 
            context
        };

        // Use strategy pattern based on scraping method
        const methodHandlers = {
            'keyence_interactive': handleKeyenceInteractive,
            'idec_dual_site': handleIdecDualSite,
            'nbk_interactive': handleNbkInteractive,
            'browserql': handleBrowserQL,
            'default': handleRenderDefault
        };

        const handler = methodHandlers[scrapingMethod] || methodHandlers.default;
        return await handler(handlerParams);

    } catch (error) {
        console.error('Fetch URL error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};

// Helper functions
function constructBaseUrl(headers) {
    const protocol = headers['x-forwarded-proto'] || 'https';
    const host = headers['host'];
    return `${protocol}://${host}`;
}

async function handleCommonError(params) {
    const { 
        jobId, 
        urlIndex, 
        url, 
        snippet, 
        error, 
        method, 
        baseUrl, 
        context, 
        continuePipeline = true 
    } = params;

    console.log(`Saving error result for ${method} URL ${urlIndex}`);

    const errorMessage = error.message.includes('503') || error.message.includes('Service restarting')
        ? `[Render service was restarting - this URL will be retried on next check]`
        : `[${method} failed: ${error.message}]`;

    const allDone = await saveUrlResult(jobId, urlIndex, {
        url,
        title: null,
        snippet,
        fullContent: errorMessage
    }, context);

    console.log(`Error result saved for ${method} URL ${urlIndex}. All done: ${allDone}`);

    if (!continuePipeline) {
        return {
            statusCode: 500,
            body: JSON.stringify({
                success: false,
                error: error.message,
                method: `${method}_failed`,
                pipelineContinued: false
            })
        };
    }

    await continuePipelineAfterError({ jobId, urlIndex, allDone, baseUrl, context });
    
    return {
        statusCode: 500,
        body: JSON.stringify({
            success: false,
            error: error.message,
            method: `${method}_failed`,
            pipelineContinued: true
        })
    };
}

async function continuePipelineAfterError(params) {
    const { jobId, allDone, baseUrl, context } = params;
    
    if (allDone) {
        const job = await getJob(jobId, context);
        if (job && job.status !== 'analyzing' && job.status !== 'complete') {
            console.log(`All URLs complete (with errors) for job ${jobId}, triggering analysis`);
            await triggerAnalysis(jobId, baseUrl);
        } else {
            console.log(`All URLs complete but analysis already started (status: ${job?.status}), skipping duplicate trigger`);
        }
    } else {
        const job = await getJob(jobId, context);
        if (job) {
            const nextUrl = job.urls.find(u => u.status === 'pending');
            if (nextUrl) {
                console.log(`Triggering next URL ${nextUrl.index} after error`);
                await triggerFetch(jobId, nextUrl, baseUrl);
            }
        }
    }
}

async function handleRenderServiceCall(params) {
    const { payload, serviceUrl, endpoint, methodName } = params;
    
    console.log(`Calling ${methodName} service: ${serviceUrl}/${endpoint}`);

    return await retryWithBackoff({
        operation: async () => {
            return fetch(`${serviceUrl}/${endpoint}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        },
        operationName: methodName,
        maxRetries: config.CALLBACK_MAX_RETRIES,
        timeoutMs: config.HEALTH_CHECK_TIMEOUT_MS * 2,
        breakOnTimeout: true
    });
}

// Strategy handlers
async function handleKeyenceInteractive(params) {
    const { jobId, urlIndex, model, baseUrl } = params;
    console.log(`Using KEYENCE interactive search for model: ${model}`);

    const callbackUrl = `${baseUrl}/.netlify/functions/scraping-callback`;
    const scrapingServiceUrl = process.env.SCRAPING_SERVICE_URL || 'https://eolscrapingservice.onrender.com';

    const keyencePayload = {
        model: model,
        callbackUrl,
        jobId,
        urlIndex
    };

    const keyenceResult = await handleRenderServiceCall({
        payload: keyencePayload,
        serviceUrl: scrapingServiceUrl,
        endpoint: 'scrape-keyence',
        jobId,
        urlIndex,
        methodName: 'KEYENCE invocation'
    });

    return handleRenderServiceResult(keyenceResult, 'keyence');
}

async function handleIdecDualSite(params) {
    const { jobId, urlIndex, model, jpUrl, usUrl, baseUrl, title, snippet, context } = params;
    console.log(`Using IDEC dual-site search for model: ${model}`);

    const callbackUrl = `${baseUrl}/.netlify/functions/scraping-callback`;
    const scrapingServiceUrl = process.env.SCRAPING_SERVICE_URL || 'https://eolscrapingservice.onrender.com';

    const jpProxyUrl = process.env.IDEC_JP_PROXY;
    const usProxyUrl = process.env.IDEC_US_PROXY;

    if (!jpProxyUrl || !usProxyUrl) {
        console.error('IDEC proxy environment variables not set');
        
        const allDone = await saveUrlResult(jobId, urlIndex, {
            url: params.url,
            title: null,
            snippet,
            fullContent: '[IDEC proxy configuration error - environment variables not set]'
        }, context);

        if (allDone) {
            await triggerAnalysis(jobId, baseUrl);
        }

        return {
            statusCode: 500,
            body: JSON.stringify({
                success: false,
                error: 'IDEC proxy environment variables not set',
                method: 'idec_config_error'
            })
        };
    }

    const idecPayload = {
        callbackUrl,
        jobId,
        urlIndex,
        title,
        snippet,
        extractionMode: 'idec_dual_site',
        model: model,
        jpProxyUrl: jpProxyUrl,
        usProxyUrl: usProxyUrl,
        jpUrl: jpUrl,
        usUrl: usUrl
    };

    console.log(`IDEC payload: model=${model}, jpUrl=${jpUrl}, usUrl=${usUrl}`);

    const idecResult = await handleRenderServiceCall({
        payload: idecPayload,
        serviceUrl: scrapingServiceUrl,
        endpoint: 'scrape-idec-dual',
        jobId,
        urlIndex,
        methodName: 'IDEC dual-site'
    });

    return handleRenderServiceResult(idecResult, 'idec_dual_site');
}

async function handleNbkInteractive(params) {
    const { jobId, urlIndex, model, url, snippet, baseUrl, context } = params;
    console.log(`Using NBK full BrowserQL scraping for model: ${model}`);

    try {
        const searchResult = await scrapeNBKSearchWithBrowserQL(model);

        if (!searchResult.hasResults || !searchResult.productUrl) {
            console.log(`NBK: No results found for model ${model}`);
            return await handleNbkNoResults({
                jobId, 
                urlIndex, 
                url, 
                snippet, 
                model, 
                preprocessedModel: searchResult.preprocessedModel, 
                baseUrl, 
                context
            });
        }

        console.log(`NBK: Product URL found, scraping with BrowserQL: ${searchResult.productUrl}`);
        const productResult = await scrapeNBKProductWithBrowserQL(searchResult.productUrl);

        if (!productResult.success || !productResult.content) {
            throw new Error('NBK product page scraping returned no content');
        }

        console.log(`NBK: Successfully scraped product page (${productResult.content.length} characters)`);
        return await handleNbkSuccess({
            jobId, 
            urlIndex, 
            productUrl: searchResult.productUrl, 
            snippet, 
            content: productResult.content, 
            baseUrl, 
            context
        });

    } catch (error) {
        console.error(`NBK search failed:`, error);
        return await handleCommonError({
            ...params,
            error,
            method: 'nbk_search'
        });
    }
}

async function handleNbkNoResults(params) {
    const { 
        jobId, 
        urlIndex, 
        url, 
        snippet, 
        model, 
        preprocessedModel, 
        baseUrl, 
        context 
    } = params;

    const allDone = await saveUrlResult(jobId, urlIndex, {
        url,
        title: 'NBK Search - No Results',
        snippet,
        fullContent: `[NBK Search: No results found for model "${model}". Preprocessed search term: "${preprocessedModel}"]`
    }, context);

    console.log(`NBK: No results saved for URL ${urlIndex}. All done: ${allDone}`);

    await continuePipelineAfterError({ jobId, urlIndex, allDone, baseUrl, context });

    return {
        statusCode: 200,
        body: JSON.stringify({
            success: true,
            method: 'nbk_no_results',
            noResults: true
        })
    };
}

async function handleNbkSuccess(params) {
    const { 
        jobId, 
        urlIndex, 
        productUrl, 
        snippet, 
        content, 
        baseUrl, 
        context 
    } = params;

    const allDone = await saveUrlResult(jobId, urlIndex, {
        url: productUrl,
        title: 'NBK Product Page',
        snippet,
        fullContent: content
    }, context);

    console.log(`NBK: Product page saved for URL ${urlIndex}. All done: ${allDone}`);

    await continuePipelineAfterError({ jobId, urlIndex, allDone, baseUrl, context });

    return {
        statusCode: 200,
        body: JSON.stringify({ success: true, method: 'nbk_browserql_complete' })
    };
}

async function handleBrowserQL(params) {
    const { jobId, urlIndex, url, snippet, baseUrl, context } = params;
    console.log(`Using BrowserQL for URL ${urlIndex}`);

    try {
        const result = await scrapeWithBrowserQL(url);

        const allDone = await saveUrlResult(jobId, urlIndex, {
            url,
            title: result.title,
            snippet,
            fullContent: result.content
        }, context);

        console.log(`BrowserQL scraping complete for URL ${urlIndex}. All done: ${allDone}`);

        await continuePipelineAfterSuccess({ jobId, urlIndex, allDone, baseUrl, context });

        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                method: 'browserql',
                contentLength: result.content.length
            })
        };

    } catch (error) {
        console.error(`BrowserQL scraping failed for URL ${urlIndex}:`, error);
        return await handleCommonError({
            ...params,
            error,
            method: 'browserql'
        });
    }
}

async function continuePipelineAfterSuccess(params) {
    const { jobId, allDone, baseUrl, context } = params;
    
    if (allDone) {
        console.log(`All URLs complete for job ${jobId}, triggering analysis`);
        await triggerAnalysis(jobId, baseUrl);
    } else {
        console.log(`Checking for next pending URL...`);
        const job = await getJob(jobId, context);

        if (job) {
            const nextUrl = job.urls.find(u => u.status === 'pending');
            if (nextUrl) {
                console.log(`Triggering next URL ${nextUrl.index}: ${nextUrl.url}`);
                await triggerFetch(jobId, nextUrl, baseUrl);
            } else {
                console.log(`No more pending URLs found`);
            }
        }
    }
}

function handleRenderServiceResult(serviceResult, methodPrefix) {
    if (serviceResult.timedOut) {
        return {
            statusCode: 202,
            body: JSON.stringify({ success: true, method: `${methodPrefix}_pending` })
        };
    }

    if (!serviceResult.success) {
        throw new Error(`Render invocation failed: ${serviceResult.error?.message || 'Unknown error'}`);
    }

    return {
        statusCode: 202,
        body: JSON.stringify({ success: true, method: `${methodPrefix}_pending` })
    };
}

async function handleRenderDefault(params) {
    const { jobId, urlIndex, url, title, snippet, baseUrl } = params;
    
    const callbackUrl = `${baseUrl}/.netlify/functions/scraping-callback`;
    const scrapingServiceUrl = process.env.SCRAPING_SERVICE_URL || 'https://eolscrapingservice.onrender.com';

    console.log('Checking Render service health...');
    const isHealthy = await checkRenderHealth(scrapingServiceUrl);

    if (!isHealthy) {
        console.warn('Render service unhealthy, waiting 10s for recovery...');
        await new Promise(resolve => setTimeout(resolve, 10000));

        const isHealthyRetry = await checkRenderHealth(scrapingServiceUrl);
        if (!isHealthyRetry) {
            console.error('Render service still unhealthy after retry');
            return await handleCommonError({
                ...params,
                error: new Error('Render service unavailable'),
                method: 'render_service_unavailable'
            });
        }
        console.log('Render service recovered after retry');
    }

    const renderPayload = {
        url,
        callbackUrl,
        jobId,
        urlIndex,
        title,
        snippet
    };

    console.log(`Calling Render scraping service for URL ${urlIndex}: ${scrapingServiceUrl}/scrape`);

    const renderResult = await handleRenderServiceCall({
        payload: renderPayload,
        serviceUrl: scrapingServiceUrl,
        endpoint: 'scrape',
        jobId,
        urlIndex,
        methodName: `Render invocation for URL ${urlIndex}`
    });

    return handleRenderServiceResult(renderResult, 'render');
}

// Helper function to trigger next URL fetch
async function triggerFetch(jobId, urlInfo, baseUrl) {
    try {
        const payload = {
            jobId,
            urlIndex: urlInfo.index,
            url: urlInfo.url,
            title: urlInfo.title,
            snippet: urlInfo.snippet,
            scrapingMethod: urlInfo.scrapingMethod
        };

        // Pass model for interactive searches (KEYENCE)
        if (urlInfo.model) {
            payload.model = urlInfo.model;
        }

        // Pass jpUrl and usUrl for IDEC dual-site
        if (urlInfo.jpUrl) {
            payload.jpUrl = urlInfo.jpUrl;
        }
        if (urlInfo.usUrl) {
            payload.usUrl = urlInfo.usUrl;
        }

        await fetch(`${baseUrl}/.netlify/functions/fetch-url`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
    } catch (error) {
        console.error('Failed to trigger next fetch:', error);
    }
}

// Helper function to trigger LLM analysis
async function triggerAnalysis(jobId, baseUrl) {
    try {
        await fetch(`${baseUrl}/.netlify/functions/analyze-job`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobId })
        });
    } catch (error) {
        console.error('Failed to trigger analysis:', error);
    }
}
