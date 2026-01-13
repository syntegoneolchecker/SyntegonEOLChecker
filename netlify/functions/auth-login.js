const { loginUser } = require('./lib/auth-manager');
const { generateAuthCookie } = require('./lib/auth-middleware');
const logger = require('./lib/logger');
const { recordAttempt, clearRateLimit } = require('./lib/rate-limiter');
const { validateAuthRequest } = require('./lib/auth-helpers');

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
    // Validate request and handle common errors
    const validation = await validateAuthRequest(event, 'login');
    if (validation.error) {
        return validation.error;
    }

    const { email, password, clientIP } = validation;

    try {
        // Attempt login
        const result = await loginUser(email, password);

        if (!result.success) {
            // Record failed attempt for rate limiting
            await recordAttempt('login', clientIP);

            return {
                statusCode: 401,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                },
                body: JSON.stringify({
                    success: false,
                    message: result.message
                })
            };
        }

        // Clear rate limit on successful login
        await clearRateLimit('login', clientIP);

        // Set auth cookie
        const authCookie = generateAuthCookie(result.token);

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
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
        logger.error('Login error:', error);
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
