// Receive results from Render scraping service and save them
const { saveUrlResult, getJob } = require('./lib/job-storage');

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
 * - We use fire-and-forget for triggerAnalysis/triggerFetch (no await)
 * - This prevents timeouts when analyze-job waits for Groq token reset (30-60s)
 * - The polling in auto-eol-check-background will detect when analysis completes
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

        // SIMPLIFIED: Just save the result and return
        // The polling loop in auto-eol-check-background will detect completion and trigger analysis
        if (allDone) {
            console.log(`✓ All URLs complete for job ${jobId}. Polling loop will trigger analysis.`);
        } else {
            console.log(`⚠️  Job ${jobId} has more URLs pending, but we don't support multiple URLs per job yet.`);
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
