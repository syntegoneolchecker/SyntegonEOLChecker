/**
 * Standardized response builders for Netlify Functions
 * Ensures consistent API response format across all endpoints
 */

/**
 * Build a successful response
 * @param {any} data - Response data
 * @param {number} statusCode - HTTP status code (default: 200)
 * @returns {Object} Netlify function response object
 */
function successResponse(data, statusCode = 200) {
    return {
        statusCode,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            success: true,
            data
        })
    };
}

/**
 * Build an error response
 * @param {string} message - Error message
 * @param {any} details - Additional error details (optional)
 * @param {number} statusCode - HTTP status code (default: 500)
 * @returns {Object} Netlify function response object
 */
function errorResponse(message, details = null, statusCode = 500) {
    const errorBody = {
        success: false,
        error: {
            message,
            timestamp: new Date().toISOString()
        }
    };

    if (details) {
        errorBody.error.details = details;
    }

    return {
        statusCode,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(errorBody)
    };
}

/**
 * Build a validation error response (400)
 * @param {Array<string>} errors - Array of validation error messages
 * @returns {Object} Netlify function response object
 */
function validationErrorResponse(errors) {
    return errorResponse('Validation failed', { errors }, 400);
}

/**
 * Build a not found error response (404)
 * @param {string} resource - Name of the resource that wasn't found
 * @returns {Object} Netlify function response object
 */
function notFoundResponse(resource = 'Resource') {
    return errorResponse(`${resource} not found`, null, 404);
}

/**
 * Build a method not allowed response (405)
 * @param {string} allowedMethods - Comma-separated list of allowed methods
 * @returns {Object} Netlify function response object
 */
function methodNotAllowedResponse(allowedMethods = 'POST') {
    return {
        statusCode: 405,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Content-Type': 'application/json',
            'Allow': allowedMethods
        },
        body: JSON.stringify({
            success: false,
            error: {
                message: 'Method not allowed',
                allowedMethods,
                timestamp: new Date().toISOString()
            }
        })
    };
}

/**
 * Build a rate limit error response (429)
 * @param {string} message - Rate limit message
 * @param {number} retryAfter - Seconds until rate limit resets (optional)
 * @returns {Object} Netlify function response object
 */
function rateLimitResponse(message, retryAfter = null) {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
    };

    if (retryAfter) {
        headers['Retry-After'] = retryAfter.toString();
    }

    return {
        statusCode: 429,
        headers,
        body: JSON.stringify({
            success: false,
            error: {
                message,
                retryAfter,
                timestamp: new Date().toISOString()
            }
        })
    };
}

module.exports = {
    successResponse,
    errorResponse,
    validationErrorResponse,
    notFoundResponse,
    methodNotAllowedResponse,
    rateLimitResponse
};
