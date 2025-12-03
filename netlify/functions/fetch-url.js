// Fetch a single URL - trigger Render scraping with callback OR use BrowserQL for Cloudflare-protected sites
const { markUrlFetching, saveUrlResult, getJob } = require('./lib/job-storage');

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
                waitUntil: networkidle
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
        const { jobId, urlIndex, url, title, snippet, scrapingMethod } = JSON.parse(event.body);

        console.log(`Fetching URL ${urlIndex} for job ${jobId}: ${url} (method: ${scrapingMethod || 'render'})`);

        // Construct base URL from request headers
        const protocol = event.headers['x-forwarded-proto'] || 'https';
        const host = event.headers['host'];
        const baseUrl = `${protocol}://${host}`;

        // Mark as fetching
        await markUrlFetching(jobId, urlIndex, context);

        // Branch based on scraping method
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

        // Default: Call Render scraping service with callback URL (asynchronous)
        const callbackUrl = `${baseUrl}/.netlify/functions/scraping-callback`;
        const scrapingServiceUrl = process.env.SCRAPING_SERVICE_URL || 'https://eolscrapingservice.onrender.com';

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

            // If not last attempt, wait before retrying (exponential backoff)
            if (attempt < maxRetries) {
                const backoffMs = Math.pow(2, attempt) * 500; // 1s, 2s, 4s
                console.log(`Retrying Render call in ${backoffMs}ms...`);
                await new Promise(resolve => setTimeout(resolve, backoffMs));
            }
        }

        // If all retries failed, return error
        if (lastError) {
            console.error(`All ${maxRetries} Render invocation attempts failed for URL ${urlIndex}`);
            return {
                statusCode: 500,
                body: JSON.stringify({
                    success: false,
                    error: `Render invocation failed after ${maxRetries} attempts: ${lastError.message}`,
                    method: 'render_failed'
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
        await fetch(`${baseUrl}/.netlify/functions/fetch-url`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jobId,
                urlIndex: urlInfo.index,
                url: urlInfo.url,
                title: urlInfo.title,
                snippet: urlInfo.snippet,
                scrapingMethod: urlInfo.scrapingMethod
            })
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
