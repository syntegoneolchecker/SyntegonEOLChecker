const { getAuthenticatedUser } = require('./lib/auth-middleware');

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
    // Only allow GET requests
    if (event.httpMethod !== 'GET') {
        return {
            statusCode: 405,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Method not allowed' })
        };
    }

    try {
        const user = await getAuthenticatedUser(event);

        if (!user) {
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    authenticated: false
                })
            };
        }

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                authenticated: true,
                user
            })
        };

    } catch (error) {
        console.error('Auth check error:', error);
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                authenticated: false,
                error: 'Internal server error'
            })
        };
    }
};
