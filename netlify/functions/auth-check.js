const { getAuthenticatedUser } = require('./lib/auth-middleware');
const logger = require('./lib/logger');
const { handleCORSPreflight, successResponse, errorResponse, methodNotAllowedResponse } = require('./lib/response-builder');

/**
 * Authentication Check Endpoint
 * GET /auth-check
 *
 * Checks if the current request is authenticated
 * Used by frontend to verify authentication status
 *
 * Response:
 * {
 *   "authenticated": true,
 *   "user": {
 *     "id": "user-id",
 *     "email": "user@syntegon.com"
 *   }
 * }
 */

exports.handler = async (event) => {
    // Handle CORS preflight
    const corsResponse = handleCORSPreflight(event, 'GET, OPTIONS');
    if (corsResponse) return corsResponse;

    // Only allow GET requests
    if (event.httpMethod !== 'GET') {
        return methodNotAllowedResponse('GET');
    }

    try {
        const user = await getAuthenticatedUser(event);

        if (!user) {
            return successResponse({ authenticated: false });
        }

        return successResponse({ authenticated: true, user });

    } catch (error) {
        logger.error('Auth check error:', error);
        return errorResponse('Internal server error', { authenticated: false });
    }
};
