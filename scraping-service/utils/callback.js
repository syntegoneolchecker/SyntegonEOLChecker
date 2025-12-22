// Callback handling utilities
const { isValidCallbackUrl } = require('./validation');
const { getShutdownState } = require('./memory');

/**
 * Send callback unconditionally (with retry logic and response validation)
 * @param {string} callbackUrl - URL to send callback to
 * @param {Object} payload - Callback payload
 * @param {number} maxRetries - Maximum retry attempts (default: 3)
 * @returns {Promise<void>}
 */
async function sendCallback(callbackUrl, payload, maxRetries = 3) {
    if (!callbackUrl) return;
    
    validateCallbackUrl(callbackUrl);
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            await attemptCallback(callbackUrl, payload, attempt, maxRetries);
            return; // Success - exit function
        } catch (error) {
            const isLastAttempt = attempt === maxRetries;
            
            if (isLastAttempt) {
                console.error(`❌ All ${maxRetries} callback attempts failed - callback lost`);
                throw error; // Propagate error so scraping endpoint can handle it
            }
            
            await handleRetry(error, attempt);
        }
    }
}

/**
 * Validate callback URL for SSRF protection
 * @param {string} callbackUrl - URL to validate
 * @throws {Error} if URL is invalid
 */
function validateCallbackUrl(callbackUrl) {
    const callbackValidation = isValidCallbackUrl(callbackUrl);
    if (!callbackValidation.valid) {
        console.error(`SSRF protection: Blocked unsafe callback URL in sendCallback: ${callbackUrl} - ${callbackValidation.reason}`);
        throw new Error(`Invalid callback URL: ${callbackValidation.reason}`);
    }
}

/**
 * Attempt to send a single callback
 * @param {string} callbackUrl - URL to send callback to
 * @param {Object} payload - Callback payload
 * @param {number} attempt - Current attempt number
 * @param {number} maxRetries - Maximum retry attempts
 * @returns {Promise<void>}
 */
async function attemptCallback(callbackUrl, payload, attempt, maxRetries) {
    console.log(`Sending callback (attempt ${attempt}/${maxRetries}): ${callbackUrl}`);
    
    // NOSONAR javascript:S5144 - SSRF: Callback URLs use whitelist validation via ALLOWED_ORIGINS.
    // Only trusted backend domains (configured in environment) are permitted for callbacks.
    // Defense-in-depth: validation at endpoint level + immediate pre-fetch validation above.
    const response = await fetch(callbackUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        await handleFailedResponse(response, attempt, maxRetries);
    }
    
    // Success!
    console.log(`✓ Callback successful (HTTP ${response.status})`);
}

/**
 * Handle a failed HTTP response
 * @param {Response} response - Fetch response object
 * @param {number} attempt - Current attempt number
 * @param {number} maxRetries - Maximum retry attempts
 * @throws {Error} with appropriate message
 */
async function handleFailedResponse(response, attempt, maxRetries) {
    const errorText = await response.text().catch(() => 'Could not read response body');
    console.error(`Callback returned HTTP ${response.status} on attempt ${attempt}/${maxRetries}:`, errorText);

    if (attempt < maxRetries) {
        const backoffMs = calculateBackoff(attempt);
        console.log(`Retrying callback in ${backoffMs}ms${getShutdownState() ? ' (restart pending)' : ''}...`);
        await delay(backoffMs);
        throw new Error(`Retry after HTTP ${response.status}`); // Trigger retry loop
    } else {
        throw new Error(`Callback failed with HTTP ${response.status}: ${errorText}`);
    }
}

/**
 * Handle retry logic after a failed attempt
 * @param {Error} error - The error that occurred
 * @param {number} attempt - Current attempt number
 * @returns {Promise<void>}
 */
async function handleRetry(error, attempt) {
    console.error(`Callback attempt ${attempt} failed:`, error.message);
    
    const backoffMs = calculateBackoff(attempt);
    console.log(`Retrying callback in ${backoffMs}ms${getShutdownState() ? ' (restart pending)' : ''}...`);
    await delay(backoffMs);
}

/**
 * Calculate backoff time for retries
 * @param {number} attempt - Current attempt number
 * @returns {number} Backoff time in milliseconds
 */
function calculateBackoff(attempt) {
    const baseBackoffMs = 1000 * Math.pow(2, attempt); // 2s, 4s, 8s
    return getShutdownState() ? baseBackoffMs + 3000 : baseBackoffMs; // Add 3s during shutdown
}

/**
 * Delay execution for specified time
 * @param {number} ms - Milliseconds to delay
 * @returns {Promise<void>}
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
    sendCallback
};
