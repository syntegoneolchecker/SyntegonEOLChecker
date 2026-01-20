// Receive results from Render scraping service and save them
const { saveUrlResult, getJob } = require('./lib/job-storage');
const { errorResponse, methodNotAllowedResponse} = require('./lib/response-builder');
const { triggerFetchUrl } = require('./lib/fire-and-forget');
const logger = require('./lib/logger');


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
 * Build payload for triggering next URL fetch
 */
function buildNextUrlPayload(jobId, nextUrl) {
    const payload = {
        jobId,
        urlIndex: nextUrl.index,
        url: nextUrl.url,
        title: nextUrl.title,
        snippet: nextUrl.snippet,
        scrapingMethod: nextUrl.scrapingMethod
    };
    // Pass model for interactive searches (KEYENCE)
    if (nextUrl.model) {
        payload.model = nextUrl.model;
    }
    return payload;
}

/**
 * Trigger the next pending URL in the job
 */
async function triggerNextPendingUrl(job, jobId, baseUrl) {
    if (!job) {
        logger.error(`[CALLBACK] Failed to get job ${jobId} for next URL trigger`);
        return;
    }

    logger.debug(`[CALLBACK] Job retrieved. Total URLs: ${job.urls?.length}`);
    const nextUrl = job.urls.find(u => u.status === 'pending');

    if (!nextUrl) {
        logger.warn(`[CALLBACK] No more pending URLs found (this should not happen)`);
        return;
    }

    logger.debug(`[CALLBACK] Found pending URL ${nextUrl.index}: ${nextUrl.url}. Triggering fetch.`);
    const payload = buildNextUrlPayload(jobId, nextUrl);
    await triggerFetchUrl(baseUrl, payload);
    logger.debug(`[CALLBACK] Next URL ${nextUrl.index} triggered successfully`);
}

/**
 * IMPORTANT: This function must complete within Netlify's 30s timeout
 * - We await triggerFetchUrl (fire-and-forget helper with retry) to ensure next URL is triggered (fast, < 1s)
 * - We skip triggering analysis (let polling loop handle it)
 * - This prevents timeouts when analyze-job waits for Groq token reset (30-60s)
 */
exports.handler = async function(event, context) {
    if (event.httpMethod !== 'POST') {
        return methodNotAllowedResponse();
    }

    const startTime = Date.now();
    const invocationTimestamp = new Date().toISOString();
    let jobId, urlIndex;

    try {
        const { jobId: _jobId, urlIndex: _urlIndex, content, title, snippet, url } = JSON.parse(event.body);
        jobId = _jobId;
        urlIndex = _urlIndex;

        logger.debug(`[CALLBACK] ===== CALLBACK START ===== Time: ${invocationTimestamp}`);
        logger.debug(`[CALLBACK] Job ${jobId}, URL ${urlIndex} (${content?.length || 0} chars)`);

        // Construct base URL from request headers
        const protocol = event.headers['x-forwarded-proto'] || 'https';
        const host = event.headers['host'];
        const baseUrl = `${protocol}://${host}`;

        // Save the result WITH RETRY LOGIC
        let allDone;
        try {
            logger.debug(`[CALLBACK] Attempting to save URL result for job ${jobId}, URL ${urlIndex}`);
            allDone = await retryBlobsOperation(
                `saveUrlResult(${jobId}, ${urlIndex})`,
                async () => await saveUrlResult(jobId, urlIndex, {
                    url,
                    title,
                    snippet,
                    fullContent: content
                }, context)
            );
            logger.debug(`[CALLBACK] URL result saved successfully. All URLs done: ${allDone}`);
        } catch (error) {
            logger.error(`[CALLBACK] CRITICAL: Failed to save URL result after retries:`, error);
            return errorResponse('Failed to save result to storage after retries', error.message);
        }

        // Get job for next URL triggering
        logger.debug(`[CALLBACK] Retrieving job ${jobId} to check for next steps`);
        const job = await getJob(jobId, context);

        // Continue pipeline: trigger next URL or let polling loop handle analysis
        if (allDone) {
            logger.debug(`[CALLBACK] ✓ All URLs complete for job ${jobId}. Polling loop will trigger analysis.`);
        } else {
            logger.debug(`[CALLBACK] Checking for next pending URL...`);
            await triggerNextPendingUrl(job, jobId, baseUrl);
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

        return errorResponse(error.message);
    }
};
