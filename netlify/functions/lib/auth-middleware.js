const { validateAuthToken } = require('./auth-manager');

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
    const cookies = event.headers.cookie;
    if (cookies) {
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
                    'Access-Control-Allow-Origin': '*'
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
                    'Access-Control-Allow-Origin': '*'
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

module.exports = {
    extractToken,
    requireAuth,
    generateAuthCookie,
    generateLogoutCookie,
    getAuthenticatedUser
};
