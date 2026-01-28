const { generateLogoutCookie } = require('./lib/auth-middleware');
const logger = require('./lib/logger');
const { getCorsOrigin, handleCORSPreflight, methodNotAllowedResponse, errorResponse } = require('./lib/response-builder');

/**
 * User Logout Endpoint
 * POST /auth-logout
 *
 * Logs out the user by clearing the auth cookie
 *
 * Response:
 * {
 *   "success": true,
 *   "message": "Logged out successfully"
 * }
 */

exports.handler = async (event) => {
    // Handle CORS preflight
    const corsResponse = handleCORSPreflight(event, 'POST, GET, OPTIONS');
    if (corsResponse) return corsResponse;

    // Allow POST and GET (for convenience)
    if (event.httpMethod !== 'POST' && event.httpMethod !== 'GET') {
        return methodNotAllowedResponse('POST, GET');
    }

    try {
        // Clear auth cookie
        const logoutCookie = generateLogoutCookie();

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': getCorsOrigin(),
                'Set-Cookie': logoutCookie
            },
            body: JSON.stringify({
                success: true,
                message: 'Logged out successfully'
            })
        };

    } catch (error) {
        logger.error('Logout error:', error);
        return errorResponse('Internal server error during logout');
    }
};
