// Fetch a single URL - trigger Render scraping with callback OR use BrowserQL for Cloudflare-protected sites
const { markUrlFetching, saveUrlResult, getJob } = require('./lib/job-storage');

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
 * Scrape URL using BrowserQL (for Cloudflare-protected sites)
 * This is a synchronous scraping method that returns content directly
 */
async function scrapeWithBrowserQL(url) {
    const browserqlApiKey = process.env.BROWSERQL_API_KEY;

    if (!browserqlApiKey) {
        throw new Error('BROWSERQL_API_KEY environment variable not set');
    }

    console.log(`Scraping with BrowserQL: ${url}`);

    // BrowserQL GraphQL mutation using evaluate() to match Render's extraction
    // This uses the exact same JavaScript code as the Render scraping service
    // Note: waitUntil is an enum (not quoted), url is a string (quoted)
    const query = `
        mutation ScrapeUrl {
            goto(
                url: "${url}"
                waitUntil: networkIdle
            ) {
                status
            }

            pageContent: evaluate(content: """
                (() => {
                    try {
                        const scripts = document.querySelectorAll('script, style, noscript');
                        scripts.forEach(el => el.remove());
                        return JSON.stringify({ text: document.body.innerText, error: null });
                    } catch (e) {
                        return JSON.stringify({ text: null, error: e?.message ?? String(e) });
                    }
                })()
            """) {
                value
            }
        }
    `;

    // Use stealth endpoint with token as query parameter (not Authorization header)
    const response = await fetch(`https://production-sfo.browserless.io/stealth/bql?token=${browserqlApiKey}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            query
        })
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`BrowserQL API error: ${response.status} - ${errorText}`);
    }

    const result = await response.json();

    if (result.errors) {
        throw new Error(`BrowserQL GraphQL errors: ${JSON.stringify(result.errors)}`);
    }

    if (!result.data || !result.data.pageContent) {
        throw new Error('BrowserQL returned no data');
    }

    // Parse the JSON-wrapped response from evaluate()
    const evaluateResult = JSON.parse(result.data.pageContent.value);

    if (evaluateResult.error) {
        throw new Error(`BrowserQL evaluation error: ${evaluateResult.error}`);
    }

    const content = evaluateResult.text;
    const title = null; // Can extract title separately if needed

    if (!content) {
        throw new Error('BrowserQL returned empty content');
    }

    console.log(`BrowserQL scraped successfully: ${content.length} characters`);

    return {
        content,
        title,
        success: true
    };
}

exports.handler = async function(event, context) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const { jobId, urlIndex, url, title, snippet, scrapingMethod, model } = JSON.parse(event.body);

        console.log(`Fetching URL ${urlIndex} for job ${jobId}: ${url} (method: ${scrapingMethod || 'render'})`);

        // Construct base URL from request headers
        const protocol = event.headers['x-forwarded-proto'] || 'https';
        const host = event.headers['host'];
        const baseUrl = `${protocol}://${host}`;

        // Mark as fetching
        await markUrlFetching(jobId, urlIndex, context);

        // Branch based on scraping method
        if (scrapingMethod === 'keyence_interactive') {
            // Use KEYENCE interactive search (special Render endpoint)
            console.log(`Using KEYENCE interactive search for model: ${model}`);

            const callbackUrl = `${baseUrl}/.netlify/functions/scraping-callback`;
            const scrapingServiceUrl = process.env.SCRAPING_SERVICE_URL || 'https://eolscrapingservice.onrender.com';

            const keyencePayload = {
                model: model,
                callbackUrl,
                jobId,
                urlIndex
            };

            console.log(`Calling KEYENCE scraping service: ${scrapingServiceUrl}/scrape-keyence`);

            // Retry logic for Render invocation (KEYENCE endpoint)
            const maxRetries = 3;
            let lastError = null;
            let isRenderRestarting = false;

            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                console.log(`KEYENCE invocation attempt ${attempt}/${maxRetries}`);

                try {
                    const timeoutPromise = new Promise((resolve) =>
                        setTimeout(() => resolve({ timedOut: true }), 10000)
                    );

                    const fetchPromise = fetch(`${scrapingServiceUrl}/scrape-keyence`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(keyencePayload)
                    });

                    const result = await Promise.race([fetchPromise, timeoutPromise]);

                    if (result.timedOut) {
                        console.log(`KEYENCE call - timeout after 10s (Render processing in background)`);
                        break;
                    } else {
                        const response = result;
                        console.log(`KEYENCE call responded with status: ${response.status}`);

                        if (!response.ok) {
                            const text = await response.text();
                            console.error(`KEYENCE error response on attempt ${attempt}: ${response.status} - ${text}`);

                            // Detect 503 Service Unavailable (Render restarting)
                            if (response.status === 503) {
                                isRenderRestarting = true;
                                console.warn(`⚠️  Render service is restarting (503 response)`);
                            }

                            lastError = new Error(`KEYENCE scraping returned error: ${response.status} - ${text}`);
                        } else {
                            console.log(`KEYENCE successfully invoked on attempt ${attempt}`);
                            break;
                        }
                    }
                } catch (error) {
                    console.error(`KEYENCE call failed on attempt ${attempt}:`, error.message);
                    lastError = error;
                }

                if (attempt < maxRetries) {
                    // Use longer backoff for 503 errors (Render restart takes ~30 seconds)
                    let backoffMs;
                    if (isRenderRestarting) {
                        // For Render restart: wait 15s, 30s on retries (enough time for restart to complete)
                        backoffMs = attempt === 1 ? 15000 : 30000;
                        console.log(`Render is restarting, using longer backoff: ${backoffMs}ms (attempt ${attempt})`);
                    } else {
                        // Standard exponential backoff for other errors
                        backoffMs = Math.pow(2, attempt) * 500; // 1s, 2s, 4s
                    }
                    console.log(`Retrying KEYENCE call in ${backoffMs}ms...`);
                    await new Promise(resolve => setTimeout(resolve, backoffMs));
                }
            }

            if (lastError) {
                console.error(`All ${maxRetries} KEYENCE invocation attempts failed`);
                console.log(`Saving error result and continuing pipeline to prevent job from hanging...`);

                // Determine if this is a Render restart (503 error)
                const isRenderRestart = lastError.message.includes('503') || lastError.message.includes('Service restarting');
                const errorMessage = isRenderRestart
                    ? '[Render service was restarting - this KEYENCE search will be retried on next check]'
                    : `[KEYENCE search failed after ${maxRetries} attempts: ${lastError.message}]`;

                // Save error result to prevent job from hanging
                const allDone = await saveUrlResult(jobId, urlIndex, {
                    url,
                    title: null,
                    snippet,
                    fullContent: errorMessage
                }, context);

                console.log(`Error result saved for KEYENCE URL ${urlIndex}. All done: ${allDone}`);

                // Continue pipeline even on error - check if analysis already started
                if (allDone) {
                    const job = await getJob(jobId, context);
                    if (job && job.status !== 'analyzing' && job.status !== 'complete') {
                        console.log(`All URLs complete (with errors) for job ${jobId}, triggering analysis`);
                        await triggerAnalysis(jobId, baseUrl);
                    } else {
                        console.log(`All URLs complete but analysis already started (status: ${job?.status}), skipping duplicate trigger`);
                    }
                } else {
                    // Find and trigger next pending URL
                    const job = await getJob(jobId, context);
                    if (job) {
                        const nextUrl = job.urls.find(u => u.status === 'pending');
                        if (nextUrl) {
                            console.log(`Triggering next URL ${nextUrl.index} after KEYENCE error`);
                            await triggerFetch(jobId, nextUrl, baseUrl);
                        }
                    }
                }

                return {
                    statusCode: 500,
                    body: JSON.stringify({
                        success: false,
                        error: `KEYENCE invocation failed after ${maxRetries} attempts: ${lastError.message}`,
                        method: 'keyence_failed',
                        pipelineContinued: true
                    })
                };
            }

            return {
                statusCode: 202,
                body: JSON.stringify({ success: true, method: 'keyence_pending' })
            };
        }

        if (scrapingMethod === 'browserql') {
            // Use BrowserQL for Cloudflare-protected sites (synchronous)
            console.log(`Using BrowserQL for URL ${urlIndex}`);

            try {
                const result = await scrapeWithBrowserQL(url);

                // Save result directly (no callback needed)
                const allDone = await saveUrlResult(jobId, urlIndex, {
                    url,
                    title: result.title,
                    snippet,
                    fullContent: result.content
                }, context);

                console.log(`BrowserQL scraping complete for URL ${urlIndex}. All done: ${allDone}`);

                // Continue pipeline: trigger analysis or next URL fetch
                if (allDone) {
                    // All URLs fetched - trigger LLM analysis
                    console.log(`All URLs complete for job ${jobId}, triggering analysis`);
                    await triggerAnalysis(jobId, baseUrl);
                } else {
                    // Find and trigger next pending URL
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

                // Save error result
                const allDone = await saveUrlResult(jobId, urlIndex, {
                    url,
                    title: null,
                    snippet,
                    fullContent: `[BrowserQL scraping failed: ${error.message}]`
                }, context);

                console.log(`BrowserQL error saved for URL ${urlIndex}. All done: ${allDone}`);

                // Continue pipeline even on error
                if (allDone) {
                    console.log(`All URLs complete (with errors) for job ${jobId}, triggering analysis`);
                    await triggerAnalysis(jobId, baseUrl);
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

                return {
                    statusCode: 500,
                    body: JSON.stringify({
                        success: false,
                        error: error.message,
                        method: 'browserql_failed'
                    })
                };
            }
        }

        if (scrapingMethod === 'idec_search_extraction') {
            // IDEC search with product extraction and scraping via Render + proxies
            console.log(`Using IDEC search extraction for model: ${model}`);

            const callbackUrl = `${baseUrl}/.netlify/functions/scraping-callback`;
            const scrapingServiceUrl = process.env.SCRAPING_SERVICE_URL || 'https://eolscrapingservice.onrender.com';

            // Get proxy URLs from environment variables
            const jpProxyUrl = process.env.IDEC_JP_PROXY;
            const usProxyUrl = process.env.IDEC_US_PROXY;

            if (!jpProxyUrl || !usProxyUrl) {
                console.error('IDEC proxy environment variables not set');
                // Fall back to Tavily search by saving error and continuing
                const allDone = await saveUrlResult(jobId, urlIndex, {
                    url,
                    title: null,
                    snippet,
                    fullContent: '[IDEC proxy environment variables (IDEC_JP_PROXY, IDEC_US_PROXY) not configured - falling back to Tavily search]'
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
                url,
                callbackUrl,
                jobId,
                urlIndex,
                title,
                snippet,
                extractionMode: 'idec',
                model: model,
                jpProxyUrl: jpProxyUrl,
                usProxyUrl: usProxyUrl
            };

            console.log(`Calling IDEC extraction service: ${scrapingServiceUrl}/scrape`);

            // Retry logic for Render invocation (IDEC endpoint)
            const maxRetries = 3;
            let lastError = null;
            let isRenderRestarting = false;

            for (let attempt = 1; attempt <= maxRetries; attempt++) {
                console.log(`IDEC invocation attempt ${attempt}/${maxRetries}`);

                try {
                    const timeoutPromise = new Promise((resolve) =>
                        setTimeout(() => resolve({ timedOut: true }), 10000)
                    );

                    const fetchPromise = fetch(`${scrapingServiceUrl}/scrape`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(idecPayload)
                    });

                    const result = await Promise.race([fetchPromise, timeoutPromise]);

                    if (result.timedOut) {
                        console.log(`IDEC call - timeout after 10s (Render processing in background)`);
                        break;
                    } else {
                        const response = result;
                        console.log(`IDEC call responded with status: ${response.status}`);

                        if (!response.ok) {
                            const text = await response.text();
                            console.error(`IDEC error response on attempt ${attempt}: ${response.status} - ${text}`);

                            // Detect 503 Service Unavailable (Render restarting)
                            if (response.status === 503) {
                                isRenderRestarting = true;
                                console.warn(`⚠️  Render service is restarting (503 response)`);
                            }

                            lastError = new Error(`IDEC extraction returned error: ${response.status} - ${text}`);
                        } else {
                            console.log(`IDEC successfully invoked on attempt ${attempt}`);
                            break;
                        }
                    }
                } catch (error) {
                    console.error(`IDEC call failed on attempt ${attempt}:`, error.message);
                    lastError = error;
                }

                if (attempt < maxRetries) {
                    // Use longer backoff for 503 errors (Render restart takes ~30 seconds)
                    let backoffMs;
                    if (isRenderRestarting) {
                        backoffMs = attempt === 1 ? 15000 : 30000;
                        console.log(`Render is restarting, using longer backoff: ${backoffMs}ms (attempt ${attempt})`);
                    } else {
                        backoffMs = Math.pow(2, attempt) * 500; // 1s, 2s, 4s
                    }
                    console.log(`Retrying IDEC call in ${backoffMs}ms...`);
                    await new Promise(resolve => setTimeout(resolve, backoffMs));
                }
            }

            if (lastError) {
                console.error(`All ${maxRetries} IDEC invocation attempts failed`);
                console.log(`Saving error result and continuing pipeline to prevent job from hanging...`);

                const isRenderRestart = lastError.message.includes('503') || lastError.message.includes('Service restarting');
                const errorMessage = isRenderRestart
                    ? '[Render service was restarting - this IDEC search will be retried on next check]'
                    : `[IDEC extraction failed after ${maxRetries} attempts: ${lastError.message}]`;

                // Save error result to prevent job from hanging
                const allDone = await saveUrlResult(jobId, urlIndex, {
                    url,
                    title: null,
                    snippet,
                    fullContent: errorMessage
                }, context);

                console.log(`Error result saved for IDEC URL ${urlIndex}. All done: ${allDone}`);

                // Continue pipeline even on error
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
                            console.log(`Triggering next URL ${nextUrl.index} after IDEC error`);
                            await triggerFetch(jobId, nextUrl, baseUrl);
                        }
                    }
                }

                return {
                    statusCode: 500,
                    body: JSON.stringify({
                        success: false,
                        error: `IDEC invocation failed after ${maxRetries} attempts: ${lastError.message}`,
                        method: 'idec_failed',
                        pipelineContinued: true
                    })
                };
            }

            return {
                statusCode: 202,
                body: JSON.stringify({ success: true, method: 'idec_pending' })
            };
        }

        // Default: Call Render scraping service with callback URL (asynchronous)
        const callbackUrl = `${baseUrl}/.netlify/functions/scraping-callback`;
        const scrapingServiceUrl = process.env.SCRAPING_SERVICE_URL || 'https://eolscrapingservice.onrender.com';

        // Check if Render is healthy before calling
        console.log('Checking Render service health...');
        const isHealthy = await checkRenderHealth(scrapingServiceUrl);

        if (!isHealthy) {
            console.warn('Render service unhealthy, waiting 10s for recovery...');
            await new Promise(resolve => setTimeout(resolve, 10000));

            // Retry health check
            const isHealthyRetry = await checkRenderHealth(scrapingServiceUrl);
            if (!isHealthyRetry) {
                console.error('Render service still unhealthy after retry');
                // Save error result and continue pipeline
                const allDone = await saveUrlResult(jobId, urlIndex, {
                    url,
                    title: null,
                    snippet,
                    fullContent: '[Render service unavailable - will retry later]'
                }, context);

                if (allDone) {
                    await triggerAnalysis(jobId, baseUrl);
                } else {
                    // Find and trigger next pending URL
                    const job = await getJob(jobId, context);
                    if (job) {
                        const nextUrl = job.urls.find(u => u.status === 'pending');
                        if (nextUrl) {
                            await triggerFetch(jobId, nextUrl, baseUrl);
                        }
                    }
                }

                return {
                    statusCode: 503,
                    body: JSON.stringify({
                        success: false,
                        error: 'Render service unavailable'
                    })
                };
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

        // Retry logic for Render invocation
        const maxRetries = 3;
        let lastError = null;
        let isRenderRestarting = false;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            console.log(`Render invocation attempt ${attempt}/${maxRetries} for URL ${urlIndex}`);

            try {
                // Call Render with a timeout - wait max 10s to ensure invocation, then continue
                // Render will call back when done (which may take 30-60s)
                const timeoutPromise = new Promise((resolve) =>
                    setTimeout(() => resolve({ timedOut: true }), 10000)
                );

                const fetchPromise = fetch(`${scrapingServiceUrl}/scrape`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(renderPayload)
                });

                const result = await Promise.race([fetchPromise, timeoutPromise]);

                if (result.timedOut) {
                    console.log(`Render call for URL ${urlIndex} - timeout after 10s (Render processing in background)`);
                    // Assume success - Render will callback
                    break;
                } else {
                    const response = result;
                    console.log(`Render call for URL ${urlIndex} responded with status: ${response.status}`);

                    if (!response.ok) {
                        const text = await response.text();
                        console.error(`Render error response on attempt ${attempt}: ${response.status} - ${text}`);

                        // Detect 503 Service Unavailable (Render restarting)
                        if (response.status === 503) {
                            isRenderRestarting = true;
                            console.warn(`⚠️  Render service is restarting (503 response)`);
                        }

                        lastError = new Error(`Render returned error: ${response.status} - ${text}`);
                        // Continue to retry
                    } else {
                        console.log(`Render successfully invoked for URL ${urlIndex} on attempt ${attempt}`);
                        // Success - exit retry loop
                        break;
                    }
                }
            } catch (error) {
                console.error(`Render call failed on attempt ${attempt}:`, error.message);
                lastError = error;
                // Continue to retry
            }

            // If not last attempt, wait before retrying
            if (attempt < maxRetries) {
                // Use longer backoff for 503 errors (Render restart takes ~30 seconds)
                let backoffMs;
                if (isRenderRestarting) {
                    // For Render restart: wait 15s, 30s on retries (enough time for restart to complete)
                    backoffMs = attempt === 1 ? 15000 : 30000;
                    console.log(`Render is restarting, using longer backoff: ${backoffMs}ms (attempt ${attempt})`);
                } else {
                    // Standard exponential backoff for other errors
                    backoffMs = Math.pow(2, attempt) * 500; // 1s, 2s, 4s
                }
                console.log(`Retrying Render call in ${backoffMs}ms...`);
                await new Promise(resolve => setTimeout(resolve, backoffMs));
            }
        }

        // If all retries failed, save error result and continue pipeline
        if (lastError) {
            console.error(`All ${maxRetries} Render invocation attempts failed for URL ${urlIndex}`);
            console.log(`Saving error result and continuing pipeline to prevent job from hanging...`);

            // Determine if this is a Render restart (503 error)
            const isRenderRestart = lastError.message.includes('503') || lastError.message.includes('Service restarting');
            const errorMessage = isRenderRestart
                ? '[Render service was restarting - this URL will be retried on next check]'
                : `[Scraping failed after ${maxRetries} attempts: ${lastError.message}]`;

            // Save error result to prevent job from hanging
            const allDone = await saveUrlResult(jobId, urlIndex, {
                url,
                title: null,
                snippet,
                fullContent: errorMessage
            }, context);

            console.log(`Error result saved for URL ${urlIndex}. All done: ${allDone}`);

            // Continue pipeline even on error - check if analysis already started
            if (allDone) {
                const job = await getJob(jobId, context);
                if (job && job.status !== 'analyzing' && job.status !== 'complete') {
                    console.log(`All URLs complete (with errors) for job ${jobId}, triggering analysis`);
                    await triggerAnalysis(jobId, baseUrl);
                } else {
                    console.log(`All URLs complete but analysis already started (status: ${job?.status}), skipping duplicate trigger`);
                }
            } else {
                // Find and trigger next pending URL
                const job = await getJob(jobId, context);
                if (job) {
                    const nextUrl = job.urls.find(u => u.status === 'pending');
                    if (nextUrl) {
                        console.log(`Triggering next URL ${nextUrl.index} after error`);
                        await triggerFetch(jobId, nextUrl, baseUrl);
                    }
                }
            }

            return {
                statusCode: 500,
                body: JSON.stringify({
                    success: false,
                    error: `Render invocation failed after ${maxRetries} attempts: ${lastError.message}`,
                    method: 'render_failed',
                    pipelineContinued: true
                })
            };
        }

        return {
            statusCode: 202, // Accepted
            body: JSON.stringify({ success: true, method: 'render_pending' })
        };

    } catch (error) {
        console.error('Fetch URL error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};

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
