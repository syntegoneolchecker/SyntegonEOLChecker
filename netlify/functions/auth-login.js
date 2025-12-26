const { loginUser } = require('./lib/auth-manager');
const { generateAuthCookie } = require('./lib/auth-middleware');
const logger = require('./lib/logger');
const { checkRateLimit, recordAttempt, clearRateLimit, getClientIP } = require('./lib/rate-limiter');

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
    // Handle CORS preflight
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 204,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Allow-Methods': 'POST, OPTIONS'
            },
            body: ''
        };
    }

    // Only allow POST requests
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify({ error: 'Method not allowed' })
        };
    }

    try {
        const { email, password } = JSON.parse(event.body);

        // Validate input
        if (!email || !password) {
            return {
                statusCode: 400,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                },
                body: JSON.stringify({
                    success: false,
                    message: 'Email and password are required'
                })
            };
        }

        // Check rate limit
        const clientIP = getClientIP(event);
        const rateLimit = await checkRateLimit('login', clientIP);

        if (!rateLimit.allowed) {
            logger.warn(`Rate limit exceeded for login from IP: ${clientIP}`);
            return {
                statusCode: 429,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                    'Retry-After': rateLimit.retryAfter.toString()
                },
                body: JSON.stringify({
                    success: false,
                    message: rateLimit.message,
                    retryAfter: rateLimit.retryAfter
                })
            };
        }

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
