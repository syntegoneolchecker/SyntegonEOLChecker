// Fetch a single URL - trigger Render scraping with callback OR use BrowserQL for Cloudflare-protected sites
const { markUrlFetching, saveUrlResult, getJob } = require('./lib/job-storage');
const { scrapeWithBrowserQL } = require('./lib/browserql-scraper');
const { retryWithBackoff } = require('./lib/retry-helpers');
const { triggerFetchUrl, triggerAnalyzeJob } = require('./lib/fire-and-forget');
const config = require('./lib/config');
const logger = require('./lib/logger');

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
        logger.error('Render health check failed:', error.message);
        return false;
    }
}

/**
 * Scrape NBK search page using BrowserQL to extract product URL
 * Step 1 of 2-step process: BrowserQL search (bypasses Cloudflare) → extract product URL
 * Uses same BrowserQL endpoint as shared scraper but with NBK-specific DOM extraction
 */
async function scrapeNBKSearchWithBrowserQL(model) {
    const browserqlApiKey = process.env.BROWSERQL_API_KEY;

    if (!browserqlApiKey) {
        throw new Error('BROWSERQL_API_KEY environment variable not set');
    }

    // Preprocess model name: remove lowercase 'x' and '-'
    const preprocessedModel = model.replaceAll('x', '').replaceAll('-', '');
    logger.info(`NBK BrowserQL: Preprocessed model name: ${model} -> ${preprocessedModel}`);

    const encodedModel = encodeURIComponent(preprocessedModel);
    const searchUrl = `https://www.nbk1560.com/search/?q=${encodedModel}&SelectedLanguage=ja-JP&page=1&imgsize=1&doctype=all&sort=0&pagemax=10&htmlLang=ja`;

    logger.info(`NBK BrowserQL: Searching at ${searchUrl}`);

    // Escape URL for GraphQL by using JSON string literal encoding
    const escapedSearchUrlLiteral = JSON.stringify(searchUrl);

    // BrowserQL GraphQL query with NBK-specific DOM extraction
    // Uses the same pattern as shared scraper (evaluate with JSON stringify)
    const query = `
        mutation ScrapeNBKSearch {
            goto(
                url: ${escapedSearchUrlLiteral}
                waitUntil: networkIdle
            ) {
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
                                    : 'https://www.nbk1560.com' + href;
                            }
                        }

                        return JSON.stringify({
                            hasResults: hasResults,
                            productUrl: productUrl,
                            error: null
                        });
                    } catch (e) {
                        return JSON.stringify({
                            hasResults: false,
                            productUrl: null,
                            error: e?.message ?? String(e)
                        });
                    }
                })()
            """) {
                value
            }
        }
    `;

    const response = await fetch(`https://production-sfo.browserless.io/stealth/bql?token=${browserqlApiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`NBK BrowserQL search failed: ${response.status} - ${errorText}`);
    }

    const result = await response.json();

    if (result.errors) {
        throw new Error(`NBK BrowserQL search errors: ${JSON.stringify(result.errors)}`);
    }

    if (!result.data?.searchInfo) {
        throw new Error('NBK BrowserQL search returned no data');
    }

    const searchInfo = JSON.parse(result.data.searchInfo.value);
    logger.info(`NBK BrowserQL: Search results:`, searchInfo);

    if (searchInfo.error) {
        throw new Error(`NBK search page evaluation error: ${searchInfo.error}`);
    }

    // Append language parameter to force Japanese site
    let productUrl = searchInfo.productUrl;
    if (productUrl) {
        productUrl = productUrl + '?SelectedLanguage=ja-JP';
        logger.info(`NBK BrowserQL: Added language parameter to URL: ${productUrl}`);
    }

    return {
        hasResults: searchInfo.hasResults,
        productUrl: productUrl,
        preprocessedModel: preprocessedModel
    };
}

/**
 * Scrape NBK product page using shared BrowserQL scraper
 * Step 2 of 2-step process: Product page scraping (bypasses Cloudflare)
 * Uses shared scraper like Oriental Motor for consistency
 */
async function scrapeNBKProductWithBrowserQL(productUrl) {
    logger.info(`NBK BrowserQL: Scraping product page: ${productUrl}`);

    // Use shared BrowserQL scraper (same as Oriental Motor)
    const result = await scrapeWithBrowserQL(productUrl);

    if (!result.content) {
        throw new Error('NBK BrowserQL returned empty content');
    }

    logger.info(`NBK BrowserQL: Successfully scraped product page (${result.content.length} characters)`);

    return {
        content: result.content,
        success: true
    };
}

exports.handler = async function(event, context) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const invocationTimestamp = new Date().toISOString();

    try {
        const requestBody = JSON.parse(event.body);
        logger.info(`[FETCH-URL DEBUG] ===== INVOCATION START ===== Time: ${invocationTimestamp}`);
        logger.info(`[FETCH-URL DEBUG] Raw request body:`, JSON.stringify(requestBody, null, 2));

        const { jobId, urlIndex, url, title, snippet, scrapingMethod, model, jpUrl, usUrl, fallbackUrl } = requestBody;

        logger.info(`[FETCH-URL DEBUG] Fetching URL ${urlIndex} for job ${jobId}: ${url} (method: ${scrapingMethod || 'render'})`);
        logger.info(`[FETCH-URL DEBUG] Extracted values: jpUrl=${jpUrl}, usUrl=${usUrl}, model=${model}, fallbackUrl=${fallbackUrl}`);

        const baseUrl = constructBaseUrl(event.headers);

        // Mark as fetching
        logger.info(`[FETCH-URL DEBUG] About to mark URL ${urlIndex} as fetching for job ${jobId}`);
        await markUrlFetching(jobId, urlIndex, context);
        logger.info(`[FETCH-URL DEBUG] URL ${urlIndex} marked as fetching for job ${jobId}`);

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
            fallbackUrl,
            baseUrl,
            context
        };

        // Use strategy pattern based on scraping method
        const methodHandlers = {
            'keyence_interactive': handleKeyenceInteractive,
            'idec_dual_site': handleIdecDualSite,
            'nbk_interactive': handleNbkInteractive,
            'omron_dual_page': handleOmronDualPage,
            'browserql': handleBrowserQL,
            'default': handleRenderDefault
        };

        const handler = methodHandlers[scrapingMethod] || methodHandlers.default;
        return await handler(handlerParams);

    } catch (error) {
        logger.error('Fetch URL error:', error);
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

    logger.info(`Saving error result for ${method} URL ${urlIndex}`);

    const errorMessage = error.message.includes('503') || error.message.includes('Service restarting')
        ? `[Render service was restarting - this URL will be retried on next check]`
        : `[${method} failed: ${error.message}]`;

    const allDone = await saveUrlResult(jobId, urlIndex, {
        url,
        title: null,
        snippet,
        fullContent: errorMessage
    }, context);

    logger.info(`Error result saved for ${method} URL ${urlIndex}. All done: ${allDone}`);

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
            logger.info(`All URLs complete (with errors) for job ${jobId}, triggering analysis`);
            await triggerAnalysis(jobId, baseUrl);
        } else {
            logger.info(`All URLs complete but analysis already started (status: ${job?.status}), skipping duplicate trigger`);
        }
    } else {
        const job = await getJob(jobId, context);
        if (job) {
            const nextUrl = job.urls.find(u => u.status === 'pending');
            if (nextUrl) {
                logger.info(`Triggering next URL ${nextUrl.index} after error`);
                await triggerFetch(jobId, nextUrl, baseUrl);
            }
        }
    }
}

async function handleRenderServiceCall(params) {
    const { payload, serviceUrl, endpoint, methodName } = params;

    logger.info(`Calling ${methodName} service: ${serviceUrl}/${endpoint}`);

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
        timeoutMs: config.RENDER_SERVICE_CALL_TIMEOUT_MS,
        breakOnTimeout: true
    });
}

// Strategy handlers
async function handleKeyenceInteractive(params) {
    const { jobId, urlIndex, model, baseUrl } = params;
    logger.info(`Using KEYENCE interactive search for model: ${model}`);

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
    logger.info(`Using IDEC dual-site search for model: ${model}`);

    const callbackUrl = `${baseUrl}/.netlify/functions/scraping-callback`;
    const scrapingServiceUrl = process.env.SCRAPING_SERVICE_URL || 'https://eolscrapingservice.onrender.com';

    const jpProxyUrl = process.env.JP_PROXY;
    const usProxyUrl = process.env.US_PROXY;

    if (!jpProxyUrl || !usProxyUrl) {
        logger.error('IDEC proxy environment variables not set');

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

    logger.info(`IDEC payload: model=${model}, jpUrl=${jpUrl}, usUrl=${usUrl}`);

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
    logger.info(`Using NBK full BrowserQL scraping for model: ${model}`);

    try {
        const searchResult = await scrapeNBKSearchWithBrowserQL(model);

        if (!searchResult.hasResults || !searchResult.productUrl) {
            logger.info(`NBK: No results found for model ${model}`);
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

        logger.info(`NBK: Product URL found, scraping with BrowserQL: ${searchResult.productUrl}`);
        const productResult = await scrapeNBKProductWithBrowserQL(searchResult.productUrl);

        if (!productResult.success || !productResult.content) {
            throw new Error('NBK product page scraping returned no content');
        }

        logger.info(`NBK: Successfully scraped product page (${productResult.content.length} characters)`);
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
        logger.error(`NBK search failed:`, error);
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

    logger.info(`NBK: No results saved for URL ${urlIndex}. All done: ${allDone}`);

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

    logger.info(`NBK: Product page saved for URL ${urlIndex}. All done: ${allDone}`);

    await continuePipelineAfterError({ jobId, urlIndex, allDone, baseUrl, context });

    return {
        statusCode: 200,
        body: JSON.stringify({ success: true, method: 'nbk_browserql_complete' })
    };
}

/**
 * Handle Omron dual-page scraping via Render service with Japanese proxy
 *
 * Omron website requires proxy access due to regional restrictions (403 errors without proxy).
 * The Render service must implement 'scrape-omron-dual' endpoint with the following logic:
 *
 * 1. Scrape primaryUrl through jpProxyUrl
 * 2. Check if page contains: '大変申し訳ございませんお探しのページが見つかりませんでした'
 * 3. If error message found, scrape fallbackUrl through jpProxyUrl
 * 4. Return successful page content via callback
 *
 * @param {Object} params - Handler parameters including jobId, urlIndex, url, etc.
 */
async function handleOmronDualPage(params) {
    const { jobId, urlIndex, url, title, snippet, baseUrl, context } = params;
    logger.info(`Using Omron dual-page strategy for job ${jobId}, URL ${urlIndex}`);

    const callbackUrl = `${baseUrl}/.netlify/functions/scraping-callback`;
    const scrapingServiceUrl = process.env.SCRAPING_SERVICE_URL || 'https://eolscrapingservice.onrender.com';

    const jpProxyUrl = process.env.JP_PROXY;

    if (!jpProxyUrl) {
        logger.error('JP_PROXY environment variable not set');

        const allDone = await saveUrlResult(jobId, urlIndex, {
            url: url,
            title: null,
            snippet,
            fullContent: '[Omron proxy configuration error - JP_PROXY environment variable not set]'
        }, context);

        if (allDone) {
            await triggerAnalysis(jobId, baseUrl);
        }

        return {
            statusCode: 500,
            body: JSON.stringify({
                success: false,
                error: 'JP_PROXY environment variable not set',
                method: 'omron_config_error'
            })
        };
    }

    // Get fallback URL from job data
    const job = await getJob(jobId, context);
    const urlData = job.urls.find(u => u.index === urlIndex);
    const fallbackUrl = urlData?.fallbackUrl;

    if (!fallbackUrl) {
        logger.error('Omron fallback URL not found in job data');
        return await handleCommonError({
            ...params,
            error: new Error('Fallback URL not found in job data'),
            method: 'omron_missing_fallback'
        });
    }

    const omronPayload = {
        callbackUrl,
        jobId,
        urlIndex,
        title,
        snippet,
        extractionMode: 'omron_dual_page',
        jpProxyUrl: jpProxyUrl,
        primaryUrl: url,
        fallbackUrl: fallbackUrl
    };

    logger.info(`Omron payload: primaryUrl=${url}, fallbackUrl=${fallbackUrl}`);

    const omronResult = await handleRenderServiceCall({
        payload: omronPayload,
        serviceUrl: scrapingServiceUrl,
        endpoint: 'scrape-omron-dual',
        jobId,
        urlIndex,
        methodName: 'Omron dual-page'
    });

    return handleRenderServiceResult(omronResult, 'omron_dual_page');
}

async function handleBrowserQL(params) {
    const { jobId, urlIndex, url, snippet, baseUrl, context } = params;
    logger.info(`[BROWSERQL DEBUG] Using BrowserQL for URL ${urlIndex} in job ${jobId}`);

    try {
        logger.info(`[BROWSERQL DEBUG] Starting BrowserQL scrape for ${url}`);
        const result = await scrapeWithBrowserQL(url);
        logger.info(`[BROWSERQL DEBUG] BrowserQL scrape completed, content length: ${result.content.length}`);

        logger.info(`[BROWSERQL DEBUG] Saving URL result for job ${jobId}, URL ${urlIndex}`);
        const allDone = await saveUrlResult(jobId, urlIndex, {
            url,
            title: result.title,
            snippet,
            fullContent: result.content
        }, context);

        logger.info(`[BROWSERQL DEBUG] BrowserQL scraping complete for URL ${urlIndex}. All done: ${allDone}`);

        logger.info(`[BROWSERQL DEBUG] Calling continuePipelineAfterSuccess with allDone=${allDone}`);
        await continuePipelineAfterSuccess({ jobId, urlIndex, allDone, baseUrl, context });
        logger.info(`[BROWSERQL DEBUG] continuePipelineAfterSuccess completed`);

        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                method: 'browserql',
                contentLength: result.content.length
            })
        };

    } catch (error) {
        logger.error(`[BROWSERQL DEBUG] BrowserQL scraping failed for URL ${urlIndex}:`, error);
        return await handleCommonError({
            ...params,
            error,
            method: 'browserql'
        });
    }
}

async function continuePipelineAfterSuccess(params) {
    const { jobId, allDone, baseUrl, context } = params;

    logger.info(`[PIPELINE DEBUG] continuePipelineAfterSuccess called for job ${jobId}, allDone=${allDone}`);

    if (allDone) {
        logger.info(`[PIPELINE DEBUG] All URLs complete for job ${jobId}, triggering analysis`);
        await triggerAnalysis(jobId, baseUrl);
        logger.info(`[PIPELINE DEBUG] Analysis triggered for job ${jobId}`);
    } else {
        logger.info(`[PIPELINE DEBUG] Checking for next pending URL...`);
        const job = await getJob(jobId, context);

        if (job) {
            logger.info(`[PIPELINE DEBUG] Job retrieved, checking for pending URLs. Total URLs: ${job.urls?.length}`);
            const nextUrl = job.urls.find(u => u.status === 'pending');
            if (nextUrl) {
                logger.info(`[PIPELINE DEBUG] Found pending URL ${nextUrl.index}: ${nextUrl.url}, triggering fetch`);
                await triggerFetch(jobId, nextUrl, baseUrl);
                logger.info(`[PIPELINE DEBUG] Next URL ${nextUrl.index} triggered`);
            } else {
                logger.info(`[PIPELINE DEBUG] No more pending URLs found`);
            }
        } else {
            logger.warn(`[PIPELINE DEBUG] Failed to retrieve job ${jobId}`);
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

    logger.info('Checking Render service health...');
    const isHealthy = await checkRenderHealth(scrapingServiceUrl);

    if (!isHealthy) {
        logger.warn('Render service unhealthy, waiting 10s for recovery...');
        await new Promise(resolve => setTimeout(resolve, 10000));

        const isHealthyRetry = await checkRenderHealth(scrapingServiceUrl);
        if (!isHealthyRetry) {
            logger.error('Render service still unhealthy after retry');
            return await handleCommonError({
                ...params,
                error: new Error('Render service unavailable'),
                method: 'render_service_unavailable'
            });
        }
        logger.info('Render service recovered after retry');
    }

    const renderPayload = {
        url,
        callbackUrl,
        jobId,
        urlIndex,
        title,
        snippet
    };

    logger.info(`Calling Render scraping service for URL ${urlIndex}: ${scrapingServiceUrl}/scrape`);

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

// Helper function to trigger next URL fetch (with retry logic)
async function triggerFetch(jobId, urlInfo, baseUrl) {
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

    // Use fire-and-forget helper with retry logic
    await triggerFetchUrl(baseUrl, payload);
}

// Helper function to trigger LLM analysis (with retry logic)
async function triggerAnalysis(jobId, baseUrl) {
    logger.info(`[TRIGGER DEBUG] triggerAnalysis called for job ${jobId}`);
    // Use fire-and-forget helper with retry logic
    await triggerAnalyzeJob(baseUrl, jobId);
    logger.info(`[TRIGGER DEBUG] triggerAnalyzeJob completed for job ${jobId}`);
}
