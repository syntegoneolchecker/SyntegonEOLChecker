const { verifyEmail } = require('./lib/auth-manager');
const logger = require('./lib/logger');
const { getCorsOrigin } = require('./lib/response-builder');

/**
 * Email Verification Endpoint
 * GET /auth-verify?token=...
 *
 * Query parameters:
 * - token: Verification token from email
 *
 * Response:
 * {
 *   "success": true,
 *   "message": "Email verified successfully. You can now log in."
 * }
 */

exports.handler = async (event) => {
    // Handle CORS preflight
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 204,
            headers: {
                'Access-Control-Allow-Origin': getCorsOrigin(),
                'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                'Access-Control-Allow-Methods': 'GET, OPTIONS'
            },
            body: ''
        };
    }

    // Only allow GET requests
    if (event.httpMethod !== 'GET') {
        return {
            statusCode: 405,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': getCorsOrigin()
            },
            body: JSON.stringify({
                success: false,
                message: 'Method not allowed'
            })
        };
    }

    try {
        const token = event.queryStringParameters?.token;

        if (!token) {
            return {
                statusCode: 400,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': getCorsOrigin()
                },
                body: JSON.stringify({
                    success: false,
                    message: 'Verification token is required'
                })
            };
        }

        // Verify email
        const result = await verifyEmail(token);

        return {
            statusCode: result.success ? 200 : 400,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': getCorsOrigin()
            },
            body: JSON.stringify(result)
        };

    } catch (error) {
        logger.error('Verification error:', error);
        return {
            statusCode: 500,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': getCorsOrigin()
            },
            body: JSON.stringify({
                success: false,
                message: 'Internal server error during verification'
            })
        };
    }
};
