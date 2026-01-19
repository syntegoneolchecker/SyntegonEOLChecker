const crypto = require('node:crypto');
const nodemailer = require('nodemailer');
const logger = require('./lib/logger');
const { checkRateLimit, recordAttempt } = require('./lib/rate-limiter');
const { findUserByEmail, storePasswordResetToken, normalizeEmail } = require('./lib/user-storage');

/**
 * Password Reset Request Endpoint
 * POST /auth-password-reset
 *
 * Request body:
 * {
 *   "email": "user@syntegon.com"
 * }
 *
 * Response (always the same to prevent account enumeration):
 * {
 *   "success": true,
 *   "message": "If an account exists with this email, a password reset link has been sent."
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

    // Parse and validate input
    let email;
    try {
        const body = JSON.parse(event.body);
        email = body.email;
    } catch {
        return {
            statusCode: 400,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify({
                success: false,
                message: 'Invalid JSON in request body'
            })
        };
    }

    if (!email) {
        return {
            statusCode: 400,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify({
                success: false,
                message: 'Email is required'
            })
        };
    }

    // Normalize email for consistent rate limiting
    const normalizedEmail = normalizeEmail(email);

    // Check rate limit per email (15 min cooldown)
    const rateLimit = await checkRateLimit('password-reset', normalizedEmail);

    if (!rateLimit.allowed) {
        logger.warn(`Password reset rate limit exceeded for email: ${normalizedEmail}`);
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

    try {
        // Record the attempt (always, regardless of whether account exists)
        await recordAttempt('password-reset', normalizedEmail);

        // Check if user exists (don't reveal this in response)
        const user = await findUserByEmail(email);

        if (user && user.verified) {
            // Generate password reset token
            const token = crypto.randomBytes(32).toString('hex');
            const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(); // 48 hours

            // Store token
            await storePasswordResetToken(token, {
                email: normalizedEmail,
                expiresAt
            });

            // Generate deletion URL
            const siteUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || 'http://localhost:8888';
            const deletionUrl = `${siteUrl}/delete-account.html?token=${token}`;

            // Send password reset email
            await sendPasswordResetEmail(normalizedEmail, deletionUrl);
        } else {
            // User doesn't exist or is not verified - don't reveal this
            // Just log for monitoring purposes
            logger.info(`Password reset requested for non-existent or unverified account: ${normalizedEmail}`);
        }

        // Always return the same response to prevent account enumeration
        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify({
                success: true,
                message: 'If an account exists with this email, a password reset link has been sent.'
            })
        };

    } catch (error) {
        logger.error('Password reset error:', error);
        return {
            statusCode: 500,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify({
                success: false,
                message: 'An error occurred while processing your request'
            })
        };
    }
};

/**
 * Generate HTML email template for password reset
 * @param {string} deletionUrl - Account deletion URL
 * @returns {string} HTML email content
 */
function getPasswordResetEmailHtml(deletionUrl) {
    return `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #333;">Password Reset Request</h2>
            <p>You requested to reset your password for the Syntegon EOL Checker.</p>
            <p style="color: #d9534f; font-weight: bold;">
                Important: Clicking the button below will DELETE your account.
                You will need to register again with a new password.
            </p>
            <div style="margin: 30px 0;">
                <a href="${deletionUrl}"
                   style="background: #d9534f; color: white; padding: 12px 30px;
                          text-decoration: none; border-radius: 4px; display: inline-block;">
                    Delete My Account
                </a>
            </div>
            <p style="color: #666; font-size: 14px;">Or copy and paste this URL into your browser:</p>
            <p style="background: #f5f5f5; padding: 10px; border-radius: 4px; word-break: break-all;">
                ${deletionUrl}
            </p>
            <p style="color: #999; font-size: 12px; margin-top: 30px;">
                This link will expire in 48 hours.<br>
                If you didn't request this password reset, please ignore this email. Your account will remain unchanged.
            </p>
        </div>
    `;
}

/**
 * Send password reset email via Gmail SMTP
 * @param {string} email - Recipient email
 * @param {string} deletionUrl - Account deletion URL
 * @returns {Promise<boolean>} True if email was sent
 */
async function sendPasswordResetEmail(email, deletionUrl) {
    const user = process.env.EMAIL_USER;
    const pass = process.env.EMAIL_PASSWORD;

    if (!user || !pass) {
        logger.error('Gmail credentials not configured:', {
            EMAIL_USER: user ? 'set' : 'MISSING',
            EMAIL_PASSWORD: pass ? 'set' : 'MISSING'
        });
        return false;
    }

    try {
        const transporter = nodemailer.createTransport({
            host: 'smtp.gmail.com',
            port: 587,
            secure: false, // Use STARTTLS
            requireTLS: true, // Enforce TLS upgrade - reject if TLS fails
            auth: { user, pass }
        });

        const mailOptions = {
            from: process.env.FROM_EMAIL || user,
            to: email,
            subject: 'Password Reset - EOL Checker',
            html: getPasswordResetEmailHtml(deletionUrl)
        };

        await transporter.sendMail(mailOptions);
        logger.info(`Password reset email sent successfully to ${email} via Gmail SMTP`);
        return true;
    } catch (error) {
        logger.error('Failed to send password reset email via Gmail SMTP:', error);
        return false;
    }
}
