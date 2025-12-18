/**
 * Retry helpers for network operations with exponential backoff
 * Eliminates 150+ lines of duplicate retry logic across the codebase
 */

const config = require('./config');

/**
 * Execute an async operation with retry logic and exponential backoff
 *
 * @param {Object} options - Configuration options
 * @param {Function} options.operation - Async function to execute (should return a promise)
 * @param {string} options.operationName - Name for logging (e.g., "KEYENCE invocation")
 * @param {number} [options.maxRetries=3] - Maximum number of retry attempts
 * @param {number} [options.timeoutMs=10000] - Timeout per attempt in milliseconds
 * @param {Function} [options.shouldRetry] - Optional function to determine if error is retryable (error => boolean)
 * @param {Function} [options.onError] - Optional callback for each error (error, attempt) => void
 * @param {Function} [options.onSuccess] - Optional callback on success (attempt) => void
 * @param {boolean} [options.breakOnTimeout=true] - If true, break retry loop on timeout (assume background processing)
 *
 * @returns {Promise<{success: boolean, result: any, error: Error|null, timedOut: boolean}>}
 *
 * @example
 * const result = await retryWithBackoff({
 *   operation: async () => {
 *     const response = await fetch(url, options);
 *     if (!response.ok) throw new Error(`HTTP ${response.status}`);
 *     return response;
 *   },
 *   operationName: 'KEYENCE scraping',
 *   maxRetries: 3,
 *   timeoutMs: 10000
 * });
 *
 * if (result.success) {
 *   console.log('Operation succeeded:', result.result);
 * } else if (result.timedOut) {
 *   console.log('Operation timed out (processing in background)');
 * } else {
 *   console.error('Operation failed:', result.error);
 * }
 */
async function retryWithBackoff(options) {
    const {
        operation,
        operationName,
        maxRetries = config.CALLBACK_MAX_RETRIES || 3,
        timeoutMs = 10000,
        shouldRetry = () => true,
        onError = null,
        onSuccess = null,
        breakOnTimeout = true
    } = options;

    let lastError = null;
    let isRenderRestarting = false;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        console.log(`${operationName} attempt ${attempt}/${maxRetries}`);

        try {
            // Create timeout promise
            const timeoutPromise = new Promise((resolve) =>
                setTimeout(() => resolve({ timedOut: true }), timeoutMs)
            );

            // Race between operation and timeout
            const operationPromise = operation();
            const result = await Promise.race([operationPromise, timeoutPromise]);

            // Handle timeout
            if (result && result.timedOut) {
                console.log(`${operationName} - timeout after ${timeoutMs}ms${breakOnTimeout ? ' (assuming background processing)' : ''}`);
                if (breakOnTimeout) {
                    return { success: false, result: null, error: null, timedOut: true };
                } else {
                    lastError = new Error(`Timeout after ${timeoutMs}ms`);
                    // Continue to retry
                }
            } else {
                // Operation completed before timeout
                // Check if it's an HTTP response that needs validation
                if (result && typeof result === 'object' && 'status' in result && 'ok' in result) {
                    // This is an HTTP Response object
                    console.log(`${operationName} responded with status: ${result.status}`);

                    if (!result.ok) {
                        const text = await result.text();
                        console.error(`${operationName} error response on attempt ${attempt}: ${result.status} - ${text}`);

                        // Detect 503 Service Unavailable (Render restarting)
                        if (result.status === 503) {
                            isRenderRestarting = true;
                            console.warn(`⚠️  Render service is restarting (503 response)`);
                        }

                        lastError = new Error(`${operationName} returned error: ${result.status} - ${text}`);
                        // Continue to retry
                    } else {
                        // Success!
                        console.log(`${operationName} succeeded on attempt ${attempt}`);
                        if (onSuccess) onSuccess(attempt);
                        return { success: true, result, error: null, timedOut: false };
                    }
                } else {
                    // Not an HTTP response, assume success if no error was thrown
                    console.log(`${operationName} succeeded on attempt ${attempt}`);
                    if (onSuccess) onSuccess(attempt);
                    return { success: true, result, error: null, timedOut: false };
                }
            }
        } catch (error) {
            console.error(`${operationName} failed on attempt ${attempt}:`, error.message);
            lastError = error;

            if (onError) onError(error, attempt);

            // Check if error is retryable
            if (shouldRetry && !shouldRetry(error)) {
                console.log(`Error is not retryable, stopping retry loop`);
                break;
            }
        }

        // Backoff before next retry (if not last attempt)
        if (attempt < maxRetries) {
            let backoffMs;

            if (isRenderRestarting) {
                // For Render restart: wait 15s, then 30s (enough time for restart to complete)
                backoffMs = attempt === 1 ? 15000 : 30000;
                console.log(`Render is restarting, using longer backoff: ${backoffMs}ms (attempt ${attempt})`);
            } else {
                // Standard exponential backoff: 1s, 2s, 4s
                backoffMs = Math.pow(2, attempt) * (config.CALLBACK_RETRY_BASE_MS || 1000);
            }

            console.log(`Retrying ${operationName} in ${backoffMs}ms...`);
            await new Promise(resolve => setTimeout(resolve, backoffMs));
        }
    }

    // All retries failed
    console.error(`All ${maxRetries} ${operationName} attempts failed`);
    return { success: false, result: null, error: lastError, timedOut: false };
}

/**
 * Simpler retry function without timeout (for database operations, etc.)
 *
 * @param {Function} operation - Async function to execute
 * @param {number} maxRetries - Maximum number of retry attempts
 * @param {string} operationName - Name for logging
 * @returns {Promise<any>} - Result of the operation
 * @throws {Error} - Last error if all retries fail
 */
async function simpleRetry(operation, maxRetries, operationName) {
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const result = await operation();
            if (attempt > 1) {
                console.log(`${operationName} succeeded on attempt ${attempt}`);
            }
            return result;
        } catch (error) {
            lastError = error;
            console.error(`${operationName} failed on attempt ${attempt}/${maxRetries}:`, error.message);

            if (attempt < maxRetries) {
                const backoffMs = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
                console.log(`Retrying ${operationName} in ${backoffMs}ms...`);
                await new Promise(resolve => setTimeout(resolve, backoffMs));
            }
        }
    }

    throw lastError;
}

module.exports = {
    retryWithBackoff,
    simpleRetry
};
