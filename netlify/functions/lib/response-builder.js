/**
 * Standardized response builders for Netlify Functions
 * Ensures consistent API response format across all endpoints
 */

/**
 * Get CORS origin header value based on ALLOWED_ORIGINS environment variable
 * Falls back to '*' if ALLOWED_ORIGINS is not configured (development mode)
 * @param {Object} event - Netlify function event (optional, used to match request origin)
 * @returns {string} CORS origin value
 */
function getCorsOrigin(event = null) {
    const allowedOrigins = process.env.ALLOWED_ORIGINS;

    // If ALLOWED_ORIGINS not configured, allow all (development mode)
    if (!allowedOrigins) {
        return '*';
    }

    // Parse allowed origins
    const origins = allowedOrigins.split(',').map(o => o.trim());

    // If event provided, match against request origin
    if (event?.headers?.origin) {
        const requestOrigin = event.headers.origin;
        if (origins.includes(requestOrigin)) {
            return requestOrigin;
        }
        // Origin not in allowed list - return first allowed origin
        // (browser will block the request if it doesn't match)
        return origins[0];
    }

    // No event provided, return first allowed origin
    return origins[0];
}

/**
 * Handle CORS preflight (OPTIONS) requests
 * @param {Object} event - Netlify function event
 * @param {string} allowedMethods - Comma-separated list of allowed HTTP methods (default: 'GET, POST, OPTIONS')
 * @returns {Object|null} CORS preflight response or null if not an OPTIONS request
 */
function handleCORSPreflight(event, allowedMethods = 'GET, POST, OPTIONS') {
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 204,
            headers: {
                'Access-Control-Allow-Origin': getCorsOrigin(),
                'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                'Access-Control-Allow-Methods': allowedMethods
            },
            body: ''
        };
    }
    return null;
}

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
            'Access-Control-Allow-Origin': getCorsOrigin(),
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
            'Access-Control-Allow-Origin': getCorsOrigin(),
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
            'Access-Control-Allow-Origin': getCorsOrigin(),
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
 * Build an unauthorized error response (401)
 * @param {string} message - Error message
 * @returns {Object} Netlify function response object
 */
function unauthorizedResponse(message = 'Unauthorized - invalid or missing API key') {
    return errorResponse(message, null, 401);
}

/**
 * Build a rate limit error response (429)
 * @param {string} message - Rate limit message
 * @param {number} retryAfter - Seconds until rate limit resets (optional)
 * @returns {Object} Netlify function response object
 */
function rateLimitResponse(message, retryAfter = null) {
    const headers = {
        'Access-Control-Allow-Origin': getCorsOrigin(),
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
    getCorsOrigin,
    handleCORSPreflight,
    successResponse,
    errorResponse,
    validationErrorResponse,
    notFoundResponse,
    methodNotAllowedResponse,
    unauthorizedResponse,
    rateLimitResponse
};
