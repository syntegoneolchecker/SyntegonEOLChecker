const { loginUser } = require('./lib/auth-manager');
const { generateAuthCookie } = require('./lib/auth-middleware');

/**
 * User Login Endpoint
 * POST /auth-login
 *
 * Request body:
 * {
 *   "email": "user@syntegon.com",
 *   "password": "SecurePassword123"
 * }
 *
 * Response:
 * {
 *   "success": true,
 *   "message": "Login successful",
 *   "token": "jwt-token-here",
 *   "user": {
 *     "id": "user-id",
 *     "email": "user@syntegon.com"
 *   }
 * }
 *
 * Sets auth_token cookie with JWT
 */

exports.handler = async (event) => {
    // Only allow POST requests
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Method not allowed' })
        };
    }

    try {
        const { email, password } = JSON.parse(event.body);

        // Validate input
        if (!email || !password) {
            return {
                statusCode: 400,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    success: false,
                    message: 'Email and password are required'
                })
            };
        }

        // Attempt login
        const result = await loginUser(email, password);

        if (!result.success) {
            return {
                statusCode: 401,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    success: false,
                    message: result.message
                })
            };
        }

        // Set auth cookie
        const authCookie = generateAuthCookie(result.token);

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Set-Cookie': authCookie
            },
            body: JSON.stringify({
                success: true,
                message: result.message,
                token: result.token,
                user: result.user
            })
        };

    } catch (error) {
        console.error('Login error:', error);
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                success: false,
                message: 'Internal server error during login'
            })
        };
    }
};
