const { registerUser } = require('./lib/auth-manager');
const nodemailer = require('nodemailer');
const logger = require('./lib/logger');
const { recordAttempt } = require('./lib/rate-limiter');
const { validateAuthRequest } = require('./lib/auth-helpers');

/**
 * Construct base URL from request headers (works correctly for branch deploys)
 * @param {Object} headers - Request headers
 * @returns {string} Base URL
 */
function constructBaseUrl(headers) {
    const protocol = headers['x-forwarded-proto'] || 'https';
    const host = headers['host'];
    return `${protocol}://${host}`;
}

/**
 * User Registration Endpoint
 * POST /auth-register
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
 *   "message": "Account created. Please check your email to verify your account.",
 *   "verificationUrl": "https://your-site.com/verify?token=..."
 * }
 */

exports.handler = async (event) => {
    // Validate request and handle common errors
    const validation = await validateAuthRequest(event, 'register');
    if (validation.error) {
        return validation.error;
    }

    const { email, password, clientIP } = validation;

    try {
        // Register user
        const result = await registerUser(email, password);

        if (!result.success) {
            // Record failed attempt for rate limiting
            await recordAttempt('register', clientIP);

            return {
                statusCode: 400,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                },
                body: JSON.stringify(result)
            };
        }

        // Generate verification URL from request headers (works correctly for branch deploys)
        const siteUrl = constructBaseUrl(event.headers);
        const verificationUrl = `${siteUrl}/verify.html?token=${result.verificationToken}`;

        // Send verification email via Gmail SMTP
        const emailSent = await sendVerificationEmail(email, verificationUrl);

        // Inform user about email delivery status
        const message = emailSent
            ? result.message
            : 'Account created, but verification email could not be sent. Please contact administrator.';

        return {
            statusCode: 201,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify({
                success: true,
                message,
                emailSent,
                // SECURITY: Never expose verification URL in response
                // User must receive it via email only
            })
        };

    } catch (error) {
        logger.error('Registration error:', error);
        return {
            statusCode: 500,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify({
                success: false,
                message: 'Internal server error during registration'
            })
        };
    }
};

/**
 * Generate HTML email template for verification
 * @param {string} verificationUrl - Verification URL
 * @returns {string} HTML email content
 */
function getVerificationEmailHtml(verificationUrl) {
    return `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #333;">Welcome to Syntegon EOL Checker</h2>
            <p>Please verify your email address by clicking the button below:</p>
            <div style="margin: 30px 0;">
                <a href="${verificationUrl}"
                   style="background: #007bff; color: white; padding: 12px 30px;
                          text-decoration: none; border-radius: 4px; display: inline-block;">
                    Verify Email Address
                </a>
            </div>
            <p style="color: #666; font-size: 14px;">Or copy and paste this URL into your browser:</p>
            <p style="background: #f5f5f5; padding: 10px; border-radius: 4px; word-break: break-all;">
                ${verificationUrl}
            </p>
            <p style="color: #999; font-size: 12px; margin-top: 30px;">
                This link will expire in 48 hours.<br>
                If you didn't create this account, please ignore this email.
            </p>
        </div>
    `;
}

/**
 * Send verification email via Gmail SMTP
 * @param {string} email - Recipient email
 * @param {string} verificationUrl - Verification URL
 * @returns {Promise<boolean>} True if email was sent
 */
async function sendVerificationEmail(email, verificationUrl) {
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
            subject: 'Verify your EOL Checker account',
            html: getVerificationEmailHtml(verificationUrl)
        };

        await transporter.sendMail(mailOptions);
        logger.info(`Verification email sent successfully to ${email} via Gmail SMTP`);
        return true;
    } catch (error) {
        logger.error('Failed to send email via Gmail SMTP:', error);
        return false;
    }
}
