const { validateAuthToken } = require('./auth-manager');
const { getCorsOrigin } = require('./response-builder');

/**
 * Authentication Middleware
 * Provides utilities to protect Netlify Functions with authentication
 */

/**
 * Extract JWT token from request
 * Checks Authorization header and cookies
 * @param {Object} event - Netlify function event
 * @returns {string|null} JWT token or null
 */
function extractToken(event) {
    // Check Authorization header (Bearer token)
    const authHeader = event.headers.authorization || event.headers.Authorization;
    if (authHeader?.startsWith('Bearer ')) {
        return authHeader.substring(7);
    }

    // Check cookies
    const cookies = event.headers?.cookie;
    if (cookies && typeof cookies === 'string') {
        const tokenCookie = cookies.split(';').find(c => c.trim().startsWith('auth_token='));
        if (tokenCookie) {
            return tokenCookie.split('=')[1];
        }
    }

    return null;
}

/**
 * Require authentication for a function
 * Returns 401 if not authenticated, otherwise calls the handler
 * @param {Function} handler - Function handler to protect
 * @returns {Function} Protected handler
 */
function requireAuth(handler) {
    return async (event, context) => {
        const token = extractToken(event);

        if (!token) {
            return {
                statusCode: 401,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': getCorsOrigin()
                },
                body: JSON.stringify({
                    error: 'Authentication required',
                    message: 'Please log in to access this resource'
                })
            };
        }

        const validation = await validateAuthToken(token);

        if (!validation.valid) {
            return {
                statusCode: 401,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': getCorsOrigin()
                },
                body: JSON.stringify({
                    error: 'Invalid authentication',
                    message: validation.message || 'Invalid or expired token'
                })
            };
        }

        // Add user to event for use in handler
        event.user = validation.user;

        // Call the original handler
        return await handler(event, context);
    };
}

/**
 * Generate secure cookie header for setting auth token
 * @param {string} token - JWT token
 * @param {number} maxAge - Cookie max age in seconds (default: 7 days)
 * @returns {string} Set-Cookie header value
 */
function generateAuthCookie(token, maxAge = 7 * 24 * 60 * 60) {
    const isProduction = process.env.CONTEXT === 'production' || process.env.NODE_ENV === 'production';

    const cookieParts = [
        `auth_token=${token}`,
        `Max-Age=${maxAge}`,
        'Path=/',
        'HttpOnly', // Prevent JavaScript access
        'SameSite=Strict' // CSRF protection
    ];

    // Only set Secure flag in production (requires HTTPS)
    if (isProduction) {
        cookieParts.push('Secure');
    }

    return cookieParts.join('; ');
}

/**
 * Generate cookie header for clearing auth token
 * @returns {string} Set-Cookie header value
 */
function generateLogoutCookie() {
    return 'auth_token=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict';
}

/**
 * Check if request is authenticated (non-blocking)
 * Returns user info if authenticated, null otherwise
 * @param {Object} event - Netlify function event
 * @returns {Promise<Object|null>} User object or null
 */
async function getAuthenticatedUser(event) {
    const token = extractToken(event);
    if (!token) return null;

    const validation = await validateAuthToken(token);
    return validation.valid ? validation.user : null;
}

/**
 * Validate internal API key from request header
 * Used for server-to-server calls (background functions, scheduled tasks)
 * @param {Object} event - Netlify function event
 * @returns {boolean} True if API key is valid
 */
function validateInternalApiKey(event) {
    const expectedKey = process.env.INTERNAL_API_KEY;
    if (!expectedKey) {
        return false;
    }
    const providedKey = event.headers['x-internal-key'];
    return providedKey === expectedKey;
}

/**
 * Require hybrid authentication for a function
 * Allows access if EITHER:
 * - Valid JWT token (for frontend calls)
 * - Valid INTERNAL_API_KEY header (for background/server calls)
 * @param {Function} handler - Function handler to protect
 * @returns {Function} Protected handler
 */
function requireHybridAuth(handler) {
    return async (event, context) => {
        // Check internal API key first (for server-to-server calls)
        if (validateInternalApiKey(event)) {
            // Mark as internal call (no user object)
            event.isInternalCall = true;
            return await handler(event, context);
        }

        // Fall back to JWT authentication (for frontend calls)
        const token = extractToken(event);

        if (!token) {
            return {
                statusCode: 401,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': getCorsOrigin()
                },
                body: JSON.stringify({
                    error: 'Authentication required',
                    message: 'Please log in to access this resource'
                })
            };
        }

        const validation = await validateAuthToken(token);

        if (!validation.valid) {
            return {
                statusCode: 401,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': getCorsOrigin()
                },
                body: JSON.stringify({
                    error: 'Invalid authentication',
                    message: validation.message || 'Invalid or expired token'
                })
            };
        }

        // Add user to event for use in handler
        event.user = validation.user;

        // Call the original handler
        return await handler(event, context);
    };
}

module.exports = {
    extractToken,
    requireAuth,
    requireHybridAuth,
    validateInternalApiKey,
    generateAuthCookie,
    generateLogoutCookie,
    getAuthenticatedUser
};
