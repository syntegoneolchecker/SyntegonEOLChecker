const { generateLogoutCookie } = require('./lib/auth-middleware');

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
    // Allow POST and GET (for convenience)
    if (event.httpMethod !== 'POST' && event.httpMethod !== 'GET') {
        return {
            statusCode: 405,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Method not allowed' })
        };
    }

    try {
        // Clear auth cookie
        const logoutCookie = generateLogoutCookie();

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Set-Cookie': logoutCookie
            },
            body: JSON.stringify({
                success: true,
                message: 'Logged out successfully'
            })
        };

    } catch (error) {
        console.error('Logout error:', error);
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                success: false,
                message: 'Internal server error during logout'
            })
        };
    }
};
