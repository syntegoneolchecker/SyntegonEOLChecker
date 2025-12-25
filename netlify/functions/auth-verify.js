const { verifyEmail } = require('./lib/auth-manager');

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
    // Only allow GET requests
    if (event.httpMethod !== 'GET') {
        return {
            statusCode: 405,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Method not allowed' })
        };
    }

    try {
        const token = event.queryStringParameters?.token;

        if (!token) {
            return {
                statusCode: 400,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    success: false,
                    message: 'Verification token is required'
                })
            };
        }

        // Verify email
        const result = await verifyEmail(token);

        if (!result.success) {
            return {
                statusCode: 400,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(result)
            };
        }

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(result)
        };

    } catch (error) {
        console.error('Verification error:', error);
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                success: false,
                message: 'Internal server error during verification'
            })
        };
    }
};
