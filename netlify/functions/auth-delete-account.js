const logger = require('./lib/logger');
const { getPasswordResetToken, deletePasswordResetToken, deleteUser } = require('./lib/user-storage');

/**
 * Account Deletion Endpoint (for password reset flow)
 * GET /auth-delete-account?token=<token>
 *
 * Validates the password reset token and deletes the user account.
 *
 * Response:
 * {
 *   "success": true/false,
 *   "message": "..."
 * }
 */

exports.handler = async (event) => {
    // Handle CORS preflight
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 204,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type',
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
                'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify({ error: 'Method not allowed' })
        };
    }

    // Extract token from query parameters
    const token = event.queryStringParameters?.token;

    if (!token) {
        return {
            statusCode: 400,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify({
                success: false,
                message: 'No token provided'
            })
        };
    }

    try {
        // Validate token
        const tokenData = await getPasswordResetToken(token);

        if (!tokenData) {
            logger.warn(`Invalid or expired password reset token attempted: ${token.substring(0, 8)}...`);
            return {
                statusCode: 400,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                },
                body: JSON.stringify({
                    success: false,
                    message: 'Invalid or expired password reset link. Please request a new one.'
                })
            };
        }

        // Delete the user account
        const deleted = await deleteUser(tokenData.email);

        if (!deleted) {
            logger.warn(`Password reset token valid but user not found: ${tokenData.email}`);
            // Still delete the token
            await deletePasswordResetToken(token);
            return {
                statusCode: 400,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                },
                body: JSON.stringify({
                    success: false,
                    message: 'Account not found. It may have already been deleted.'
                })
            };
        }

        // Delete the password reset token after successful deletion
        await deletePasswordResetToken(token);

        logger.info(`Account deleted via password reset: ${tokenData.email}`);

        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify({
                success: true,
                message: 'Your account has been deleted. You can now register again with a new password.'
            })
        };

    } catch (error) {
        logger.error('Account deletion error:', error);
        return {
            statusCode: 500,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify({
                success: false,
                message: 'An error occurred while deleting your account'
            })
        };
    }
};
