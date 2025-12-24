// Receive results from Render scraping service and save them
const { saveUrlResult, getJob } = require('./lib/job-storage');
const logger = require('./lib/logger');

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
        logger.error('Failed to trigger next fetch:', error);
    }
}


/**
 * Retry helper for Blobs operations with exponential backoff
 * Handles transient network errors and blob storage propagation delays
 */
async function retryBlobsOperation(operationName, operation, maxRetries = 5) {
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            logger.info(`${operationName}: attempt ${attempt}/${maxRetries}`);
            const result = await operation();
            if (attempt > 1) {
                logger.info(`✓ ${operationName} succeeded on attempt ${attempt}`);
            }
            return result;
        } catch (error) {
            lastError = error;
            const isSocketError = error.code === 'UND_ERR_SOCKET' ||
                                 error.message?.includes('socket') ||
                                 error.message?.includes('ECONNRESET') ||
                                 error.message?.includes('ETIMEDOUT');

            // Also retry on "Job not found" errors (blob storage propagation delay)
            const isJobNotFound = error.message?.includes('Job') && error.message?.includes('not found');

            logger.error(`${operationName} failed on attempt ${attempt}/${maxRetries}:`, {
                message: error.message,
                code: error.code,
                isSocketError,
                isJobNotFound
            });

            if (attempt < maxRetries && (isSocketError || isJobNotFound)) {
                const backoffMs = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
                logger.info(`Retrying ${operationName} in ${backoffMs}ms...`);
                await new Promise(resolve => setTimeout(resolve, backoffMs));
            }
        }
    }

    // All retries failed
    logger.error(`❌ ${operationName} failed after ${maxRetries} attempts`);
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
    const invocationTimestamp = new Date().toISOString();
    let jobId, urlIndex;

    try {
        const { jobId: _jobId, urlIndex: _urlIndex, content, title, snippet, url } = JSON.parse(event.body);
        jobId = _jobId;
        urlIndex = _urlIndex;

        logger.info(`[CALLBACK DEBUG] ===== CALLBACK START ===== Time: ${invocationTimestamp}`);
        logger.info(`[CALLBACK DEBUG] Job ${jobId}, URL ${urlIndex} (${content?.length || 0} chars)`);

        // Construct base URL from request headers
        const protocol = event.headers['x-forwarded-proto'] || 'https';
        const host = event.headers['host'];
        const baseUrl = `${protocol}://${host}`;

        // Save the result WITH RETRY LOGIC
        let allDone;
        try {
            logger.info(`[CALLBACK DEBUG] Attempting to save URL result for job ${jobId}, URL ${urlIndex}`);
            allDone = await retryBlobsOperation(
                `saveUrlResult(${jobId}, ${urlIndex})`,
                async () => await saveUrlResult(jobId, urlIndex, {
                    url,
                    title,
                    snippet,
                    fullContent: content
                }, context)
            );
            logger.info(`[CALLBACK DEBUG] URL result saved successfully. All URLs done: ${allDone}`);
        } catch (error) {
            logger.error(`[CALLBACK DEBUG] CRITICAL: Failed to save URL result after retries:`, error);
            return {
                statusCode: 500,
                body: JSON.stringify({
                    error: 'Failed to save result to storage after retries',
                    details: error.message
                })
            };
        }

        // Get job for next URL triggering
        logger.info(`[CALLBACK DEBUG] Retrieving job ${jobId} to check for next steps`);
        const job = await getJob(jobId, context);

        // Continue pipeline: trigger next URL or let polling loop handle analysis
        if (allDone) {
            // All URLs complete - let polling loop detect and trigger analysis
            // We don't trigger analysis here to avoid 30s timeout (analyze-job can take 30-60s waiting for Groq tokens)
            logger.info(`[CALLBACK DEBUG] ✓ All URLs complete for job ${jobId}. Polling loop will trigger analysis.`);
        } else {
            // Find and trigger next pending URL
            logger.info(`[CALLBACK DEBUG] Checking for next pending URL...`);

            if (job) {
                logger.info(`[CALLBACK DEBUG] Job retrieved. Total URLs: ${job.urls?.length}`);
                const nextUrl = job.urls.find(u => u.status === 'pending');

                if (nextUrl) {
                    logger.info(`[CALLBACK DEBUG] Found pending URL ${nextUrl.index}: ${nextUrl.url}. Triggering fetch.`);
                    await triggerFetch(jobId, nextUrl, baseUrl);
                    logger.info(`[CALLBACK DEBUG] Next URL ${nextUrl.index} triggered successfully`);
                } else {
                    logger.warn(`[CALLBACK DEBUG] No more pending URLs found (this should not happen)`);
                }
            } else {
                logger.error(`[CALLBACK DEBUG] Failed to get job ${jobId} for next URL trigger`);
            }
        }

        const duration = Date.now() - startTime;
        logger.info(`[CALLBACK END] Job ${jobId}, URL ${urlIndex} - Success in ${duration}ms`);

        return {
            statusCode: 200,
            body: JSON.stringify({ success: true })
        };

    } catch (error) {
        const duration = Date.now() - startTime;
        logger.error(`[CALLBACK ERROR] Job ${jobId}, URL ${urlIndex} - Failed in ${duration}ms:`, {
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
