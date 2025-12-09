// Receive results from Render scraping service and save them
const { saveUrlResult, getJob } = require('./lib/job-storage');

/**
 * Trigger fetch-url for the next pending URL
 * Must be awaited to ensure the HTTP request completes before function terminates
 */
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

/**
 * Retry helper for Blobs operations with exponential backoff
 * Handles transient network errors (socket closures, timeouts, etc.)
 */
async function retryBlobsOperation(operationName, operation, maxRetries = 3) {
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`${operationName}: attempt ${attempt}/${maxRetries}`);
            const result = await operation();
            if (attempt > 1) {
                console.log(`✓ ${operationName} succeeded on attempt ${attempt}`);
            }
            return result;
        } catch (error) {
            lastError = error;
            const isSocketError = error.code === 'UND_ERR_SOCKET' ||
                                 error.message?.includes('socket') ||
                                 error.message?.includes('ECONNRESET') ||
                                 error.message?.includes('ETIMEDOUT');

            console.error(`${operationName} failed on attempt ${attempt}/${maxRetries}:`, {
                message: error.message,
                code: error.code,
                isSocketError
            });

            if (attempt < maxRetries) {
                const backoffMs = Math.pow(2, attempt) * 500; // 1s, 2s, 4s
                console.log(`Retrying ${operationName} in ${backoffMs}ms...`);
                await new Promise(resolve => setTimeout(resolve, backoffMs));
            }
        }
    }

    // All retries failed
    console.error(`❌ ${operationName} failed after ${maxRetries} attempts`);
    throw lastError;
}

/**
 * IMPORTANT: This function must complete within Netlify's 30s timeout
 * - We await triggerFetch to ensure next URL is triggered (fast, < 1s)
 * - We skip triggering analysis (let polling loop handle it)
 * - This prevents timeouts when analyze-job waits for Groq token reset (30-60s)
 */
exports.handler = async function(event, context) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const startTime = Date.now();
    let jobId, urlIndex;

    try {
        const { jobId: _jobId, urlIndex: _urlIndex, content, title, snippet, url } = JSON.parse(event.body);
        jobId = _jobId;
        urlIndex = _urlIndex;

        console.log(`[CALLBACK START] Job ${jobId}, URL ${urlIndex} (${content?.length || 0} chars)`);

        // Construct base URL from request headers
        const protocol = event.headers['x-forwarded-proto'] || 'https';
        const host = event.headers['host'];
        const baseUrl = `${protocol}://${host}`;

        // Save the result WITH RETRY LOGIC
        let allDone;
        try {
            allDone = await retryBlobsOperation(
                `saveUrlResult(${jobId}, ${urlIndex})`,
                async () => await saveUrlResult(jobId, urlIndex, {
                    url,
                    title,
                    snippet,
                    fullContent: content
                }, context)
            );
        } catch (error) {
            console.error(`CRITICAL: Failed to save URL result after retries:`, error);
            return {
                statusCode: 500,
                body: JSON.stringify({
                    error: 'Failed to save result to storage after retries',
                    details: error.message
                })
            };
        }

        console.log(`Result saved. All URLs done: ${allDone}`);

        // Continue pipeline: trigger next URL or let polling loop handle analysis
        if (allDone) {
            // All URLs complete - let polling loop detect and trigger analysis
            // We don't trigger analysis here to avoid 30s timeout (analyze-job can take 30-60s waiting for Groq tokens)
            console.log(`✓ All URLs complete for job ${jobId}. Polling loop will trigger analysis.`);
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
                    console.log(`No more pending URLs found (this should not happen)`);
                }
            } else {
                console.error(`Failed to get job ${jobId} for next URL trigger`);
            }
        }

        const duration = Date.now() - startTime;
        console.log(`[CALLBACK END] Job ${jobId}, URL ${urlIndex} - Success in ${duration}ms`);

        return {
            statusCode: 200,
            body: JSON.stringify({ success: true })
        };

    } catch (error) {
        const duration = Date.now() - startTime;
        console.error(`[CALLBACK ERROR] Job ${jobId}, URL ${urlIndex} - Failed in ${duration}ms:`, {
            message: error.message,
            code: error.code,
            stack: error.stack
        });

        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};
