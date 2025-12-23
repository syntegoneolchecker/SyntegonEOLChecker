/**
 * Fire-and-forget helper with retry logic and proper error handling
 * Used for triggering asynchronous operations that should not block the current request
 */

const appConfig = require('./config');

/**
 * Fire-and-forget fetch with retry logic
 * @param {string} url - URL to fetch
 * @param {Object} options - Fetch options (method, headers, body)
 * @param {Object} config - Configuration
 * @param {number} config.maxRetries - Maximum retry attempts (default: from config)
 * @param {number} config.retryDelayMs - Delay between retries in ms (default: from config)
 * @param {string} config.operationName - Name for logging (default: 'fetch')
 * @returns {Promise<void>} Resolves when fetch completes (or all retries fail)
 */
async function fireAndForgetFetch(url, options = {}, config = {}) {
    const {
        maxRetries = appConfig.FIRE_AND_FORGET_MAX_RETRIES,
        retryDelayMs = appConfig.FIRE_AND_FORGET_RETRY_DELAY_MS,
        operationName = 'fetch'
    } = config;

    let lastError = null;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetch(url, {
                ...options,
                signal: AbortSignal.timeout(appConfig.FIRE_AND_FORGET_TIMEOUT_MS)
            });

            if (response.ok) {
                console.log(`✓ ${operationName} succeeded (attempt ${attempt + 1}/${maxRetries + 1})`);
                return;
            }

            // Non-OK response
            const errorText = await response.text().catch(() => 'Unable to read response');
            lastError = new Error(`HTTP ${response.status}: ${errorText}`);
            console.warn(`⚠️  ${operationName} failed with status ${response.status} (attempt ${attempt + 1}/${maxRetries + 1})`);

        } catch (error) {
            lastError = error;
            console.warn(`⚠️  ${operationName} error: ${error.message} (attempt ${attempt + 1}/${maxRetries + 1})`);
        }

        // Don't retry on last attempt
        if (attempt < maxRetries) {
            console.log(`Retrying ${operationName} in ${retryDelayMs}ms...`);
            await new Promise(resolve => setTimeout(resolve, retryDelayMs));
        }
    }

    // All retries failed
    console.error(`❌ ${operationName} failed after ${maxRetries + 1} attempts:`, lastError?.message || 'Unknown error');
    console.error(`   URL: ${url}`);
    console.error(`   This operation will not be retried. Manual intervention may be required.`);
}

/**
 * Trigger fetch-url function (fire-and-forget)
 * @param {string} baseUrl - Base URL for the Netlify function
 * @param {Object} payload - Payload for fetch-url
 */
async function triggerFetchUrl(baseUrl, payload) {
    const url = `${baseUrl}/.netlify/functions/fetch-url`;

    await fireAndForgetFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    }, {
        operationName: `fetch-url for job ${payload.jobId}, URL ${payload.urlIndex}`,
        maxRetries: 2,
        retryDelayMs: 2000
    });
}

/**
 * Trigger analyze-job function (fire-and-forget)
 * @param {string} baseUrl - Base URL for the Netlify function
 * @param {string} jobId - Job ID to analyze
 */
async function triggerAnalyzeJob(baseUrl, jobId) {
    const url = `${baseUrl}/.netlify/functions/analyze-job`;

    await fireAndForgetFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jobId })
    }, {
        operationName: `analyze-job for job ${jobId}`,
        maxRetries: 2,
        retryDelayMs: 2000
    });
}

module.exports = {
    fireAndForgetFetch,
    triggerFetchUrl,
    triggerAnalyzeJob
};
