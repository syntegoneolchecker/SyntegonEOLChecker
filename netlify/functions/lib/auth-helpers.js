const logger = require('./logger');
const { checkRateLimit, getClientIP } = require('./rate-limiter');
const { getCorsOrigin } = require('./response-builder');

/**
 * Shared authentication request validation
 * Handles CORS, method validation, input validation, and rate limiting
 *
 * @param {Object} event - Netlify function event object
 * @param {string} action - Action type ('login' or 'register') for rate limiting
 * @returns {Promise<Object>} - { error: null, email, password, clientIP } on success
 *                   - { error: response } on failure (return this response immediately)
 */
async function validateAuthRequest(event, action) {
    // Handle CORS preflight
    if (event.httpMethod === 'OPTIONS') {
        return {
            error: {
                statusCode: 204,
                headers: {
                    'Access-Control-Allow-Origin': getCorsOrigin(),
                    'Access-Control-Allow-Headers': 'Content-Type',
                    'Access-Control-Allow-Methods': 'POST, OPTIONS'
                },
                body: ''
            }
        };
    }

    // Only allow POST requests
    if (event.httpMethod !== 'POST') {
        return {
            error: {
                statusCode: 405,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': getCorsOrigin()
                },
                body: JSON.stringify({ error: 'Method not allowed' })
            }
        };
    }

    // Parse and validate input
    let email, password;
    try {
        const body = JSON.parse(event.body);
        email = body.email;
        password = body.password;
    } catch {
        return {
            error: {
                statusCode: 400,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': getCorsOrigin()
                },
                body: JSON.stringify({
                    success: false,
                    message: 'Invalid JSON in request body'
                })
            }
        };
    }

    if (!email || !password) {
        return {
            error: {
                statusCode: 400,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': getCorsOrigin()
                },
                body: JSON.stringify({
                    success: false,
                    message: 'Email and password are required'
                })
            }
        };
    }

    // Check rate limit
    const clientIP = getClientIP(event);
    const rateLimit = await checkRateLimit(action, clientIP);

    if (!rateLimit.allowed) {
        logger.warn(`Rate limit exceeded for ${action} from IP: ${clientIP}`);
        return {
            error: {
                statusCode: 429,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': getCorsOrigin(),
                    'Retry-After': rateLimit.retryAfter.toString()
                },
                body: JSON.stringify({
                    success: false,
                    message: rateLimit.message,
                    retryAfter: rateLimit.retryAfter
                })
            }
        };
    }

    // All validation passed
    return {
        error: null,
        email,
        password,
        clientIP
    };
}

module.exports = {
    validateAuthRequest
};
