const { verifyEmail } = require('./lib/auth-manager');
const logger = require('./lib/logger');
const { handleCORSPreflight, successResponse, errorResponse, methodNotAllowedResponse, validationErrorResponse } = require('./lib/response-builder');

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
    const corsResponse = handleCORSPreflight(event, 'GET, OPTIONS');
    if (corsResponse) return corsResponse;

    // Only allow GET requests
    if (event.httpMethod !== 'GET') {
        return methodNotAllowedResponse('GET');
    }

    try {
        const token = event.queryStringParameters?.token;

        if (!token) {
            return validationErrorResponse(['Verification token is required']);
        }

        // Verify email
        const result = await verifyEmail(token);

        if (!result.success) {
            return errorResponse(result.message, null, 400);
        }

        return successResponse(result);

    } catch (error) {
        logger.error('Verification error:', error);
        return errorResponse('Internal server error during verification');
    }
};
