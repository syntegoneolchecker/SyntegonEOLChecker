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
        onError = null,
        onSuccess = null,
        breakOnTimeout = true
    } = options;

    let lastError = null;
    let isRenderRestarting = false;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        console.log(`${operationName} attempt ${attempt}/${maxRetries}`);

        const result = await executeOperationWithTimeout(
            operation, operationName, timeoutMs, breakOnTimeout
        );

        if (result.timedOut && breakOnTimeout) {
            return { success: false, result: null, error: null, timedOut: true };
        }

        if (result.success) {
            return handleSuccess(result.data, operationName, attempt, onSuccess);
        }

        const errorResult = await handleOperationError(
            result, operationName, attempt, onError
        );

        lastError = errorResult.lastError;
        isRenderRestarting = errorResult.isRenderRestarting;

        if (errorResult.shouldStop) {
            break;
        }

        if (attempt < maxRetries) {
            await backoffBeforeRetry(
                attempt, operationName, isRenderRestarting, maxRetries
            );
        }
    }

    console.error(`All ${maxRetries} ${operationName} attempts failed`);
    return { success: false, result: null, error: lastError, timedOut: false };
}

async function executeOperationWithTimeout(operation, operationName, timeoutMs, breakOnTimeout) {
    const timeoutPromise = new Promise((resolve) =>
        setTimeout(() => resolve({ timedOut: true }), timeoutMs)
    );

    const operationPromise = operation();
    
    try {
        const result = await Promise.race([operationPromise, timeoutPromise]);

        if (result?.timedOut) {
            console.log(`${operationName} - timeout after ${timeoutMs}ms${breakOnTimeout ? ' (assuming background processing)' : ''}`);
            return { timedOut: true, success: false };
        }

        return { data: result, timedOut: false, success: true };
    } catch (error) {
        return { error, timedOut: false, success: false };
    }
}

function handleSuccess(result, operationName, attempt, onSuccess) {
    console.log(`${operationName} succeeded on attempt ${attempt}`);
    
    if (onSuccess) {
        onSuccess(attempt);
    }
    
    return { success: true, result, error: null, timedOut: false };
}

async function handleOperationError(result, operationName, attempt, onError) {
    const response = {
        lastError: null,
        isRenderRestarting: false,
        shouldStop: false
    };

    if (result.timedOut) {
        response.lastError = new Error(`${operationName} operation timed out`);
        return response;
    }

    if (result.error) {
        return handleExceptionError(result.error, operationName, attempt, onError);
    }

    return handleHttpResponseError(result.data, operationName, attempt);
}

function handleExceptionError(error, operationName, attempt, onError) {
    console.error(`${operationName} failed on attempt ${attempt}:`, error.message);
    
    if (onError) {
        onError(error, attempt);
    }

    return {
        lastError: error,
        isRenderRestarting: false,
        shouldStop: false
    };
}

async function handleHttpResponseError(httpResponse, operationName, attempt) {
    console.log(`${operationName} responded with status: ${httpResponse.status}`);

    if (httpResponse.ok) {
        throw new Error('HTTP response should not be OK in error handler');
    }

    const text = await httpResponse.text();
    console.error(`${operationName} error response on attempt ${attempt}: ${httpResponse.status} - ${text}`);

    const isRenderRestarting = httpResponse.status === 503;
    if (isRenderRestarting) {
        console.warn(`⚠️  Render service is restarting (503 response)`);
    }

    return {
        lastError: new Error(`${operationName} returned error: ${httpResponse.status} - ${text}`),
        isRenderRestarting,
        shouldStop: false
    };
}

async function backoffBeforeRetry(attempt, operationName, isRenderRestarting, _maxRetries) {
    let backoffMs;

    if (isRenderRestarting) {
        backoffMs = attempt === 1 ? 15000 : 30000;
        console.log(`Render is restarting, using longer backoff: ${backoffMs}ms (attempt ${attempt})`);
    } else {
        backoffMs = Math.pow(2, attempt) * (config.CALLBACK_RETRY_BASE_MS || 1000);
    }

    console.log(`Retrying ${operationName} in ${backoffMs}ms...`);
    await new Promise(resolve => setTimeout(resolve, backoffMs));
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
