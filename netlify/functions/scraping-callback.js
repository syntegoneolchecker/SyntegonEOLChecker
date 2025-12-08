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

        if (allDone) {
            // All URLs fetched - trigger LLM analysis
            console.log(`✓ All URLs complete for job ${jobId}, triggering analysis`);
            await triggerAnalysis(jobId, baseUrl);
        } else {
            // SEQUENTIAL EXECUTION: Trigger next pending URL (Render free tier = 1 concurrent request)
            console.log(`URL ${urlIndex} complete, checking for next pending URL...`);

            let job;
            try {
                job = await retryBlobsOperation(
                    `getJob(${jobId})`,
                    async () => await getJob(jobId, context)
                );
            } catch (error) {
                console.error(`CRITICAL: Failed to get job after retries:`, error);
                return {
                    statusCode: 500,
                    body: JSON.stringify({
                        error: 'Failed to retrieve job from storage after retries',
                        details: error.message
                    })
                };
            }

            if (job) {
                // Find next pending URL
                const nextUrl = job.urls.find(u => u.status === 'pending');

                if (nextUrl) {
                    console.log(`➡️  Triggering next URL ${nextUrl.index}: ${nextUrl.url}`);
                    await triggerFetch(jobId, nextUrl, baseUrl);
                } else {
                    // FALLBACK: No pending URLs, but allDone was false - verify job state
                    console.warn(`⚠️  No pending URLs found, but allDone=false. Verifying job state...`);

                    const allComplete = job.urls.every(u => u.status === 'complete');
                    const pendingCount = job.urls.filter(u => u.status === 'pending').length;
                    const fetchingCount = job.urls.filter(u => u.status === 'fetching').length;
                    const completeCount = job.urls.filter(u => u.status === 'complete').length;

                    console.log(`Job state: ${completeCount}/${job.urls.length} complete, ${fetchingCount} fetching, ${pendingCount} pending`);

                    if (allComplete) {
                        console.log(`🔧 RECOVERY: All URLs are actually complete, triggering analysis`);
                        await triggerAnalysis(jobId, baseUrl);
                    } else {
                        console.error(`⚠️  Job stuck: Some URLs are still fetching or in unknown state`);
                        console.error(`URLs status:`, job.urls.map(u => ({ index: u.index, status: u.status })));
                    }
                }
            } else {
                console.error(`CRITICAL: Job ${jobId} not found in storage`);
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

// Trigger next URL fetch with response validation
async function triggerFetch(jobId, urlInfo, baseUrl) {
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`Triggering fetch-url (attempt ${attempt}/${maxRetries}) for URL ${urlInfo.index}`);
            const response = await fetch(`${baseUrl}/.netlify/functions/fetch-url`, {
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

            if (!response.ok) {
                const errorText = await response.text().catch(() => 'Could not read response');
                console.error(`fetch-url returned HTTP ${response.status} on attempt ${attempt}:`, errorText);

                if (attempt < maxRetries) {
                    const backoffMs = 1000 * Math.pow(2, attempt);
                    console.log(`Retrying fetch-url in ${backoffMs}ms...`);
                    await new Promise(resolve => setTimeout(resolve, backoffMs));
                    continue;
                } else {
                    throw new Error(`fetch-url failed with HTTP ${response.status}`);
                }
            }

            console.log(`✓ fetch-url triggered successfully for URL ${urlInfo.index}`);
            return;
        } catch (error) {
            console.error(`fetch-url attempt ${attempt} failed:`, error.message);
            if (attempt === maxRetries) {
                console.error(`❌ Failed to trigger next fetch after ${maxRetries} attempts`);
                throw error;
            }
            const backoffMs = 1000 * Math.pow(2, attempt);
            await new Promise(resolve => setTimeout(resolve, backoffMs));
        }
    }
}

// Trigger LLM analysis with response validation
async function triggerAnalysis(jobId, baseUrl) {
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`Triggering analyze-job (attempt ${attempt}/${maxRetries}) for job ${jobId}`);
            const response = await fetch(`${baseUrl}/.netlify/functions/analyze-job`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jobId })
            });

            if (!response.ok) {
                const errorText = await response.text().catch(() => 'Could not read response');
                console.error(`analyze-job returned HTTP ${response.status} on attempt ${attempt}:`, errorText);

                if (attempt < maxRetries) {
                    const backoffMs = 1000 * Math.pow(2, attempt);
                    console.log(`Retrying analyze-job in ${backoffMs}ms...`);
                    await new Promise(resolve => setTimeout(resolve, backoffMs));
                    continue;
                } else {
                    throw new Error(`analyze-job failed with HTTP ${response.status}`);
                }
            }

            console.log(`✓ analyze-job triggered successfully for job ${jobId}`);
            return;
        } catch (error) {
            console.error(`analyze-job attempt ${attempt} failed:`, error.message);
            if (attempt === maxRetries) {
                console.error(`❌ Failed to trigger analysis after ${maxRetries} attempts`);
                throw error;
            }
            const backoffMs = 1000 * Math.pow(2, attempt);
            await new Promise(resolve => setTimeout(resolve, backoffMs));
        }
    }
}
