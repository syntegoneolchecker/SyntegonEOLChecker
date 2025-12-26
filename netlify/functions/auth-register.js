const { registerUser, ALLOWED_EMAIL_DOMAIN } = require('./lib/auth-manager');
const nodemailer = require('nodemailer');

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

        // Register user
        const result = await registerUser(email, password);

        if (!result.success) {
            return {
                statusCode: 400,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(result)
            };
        }

        // Generate verification URL
        const siteUrl = process.env.URL || process.env.DEPLOY_PRIME_URL || 'http://localhost:8888';
        const verificationUrl = `${siteUrl}/verify.html?token=${result.verificationToken}`;

        // TODO: Send verification email
        // For now, we'll return the URL for manual testing
        // In production, you would send this via email service (SendGrid, AWS SES, etc.)
        console.log(`Verification URL for ${email}: ${verificationUrl}`);

        // Attempt to send email if configured
        const emailSent = await sendVerificationEmail(email, verificationUrl);

        return {
            statusCode: 201,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                success: true,
                message: result.message,
                emailSent,
                // SECURITY: Never expose verification URL in response
                // User must receive it via email only
            })
        };

    } catch (error) {
        console.error('Registration error:', error);
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                success: false,
                message: 'Internal server error during registration'
            })
        };
    }
};

/**
 * Send verification email
 * This is a placeholder - implement with your email service
 * @param {string} email - Recipient email
 * @param {string} verificationUrl - Verification URL
 * @returns {Promise<boolean>} True if email was sent
 */
async function sendVerificationEmail(email, verificationUrl) {
    // Check if email service is configured
    const emailApiKey = process.env.EMAIL_API_KEY;
    const emailService = process.env.EMAIL_SERVICE;

    // Debug logging (safe - doesn't expose the actual key)
    console.log('Email service config check:', {
        emailService: emailService || 'NOT SET',
        hasApiKey: !!emailApiKey,
        apiKeyLength: emailApiKey ? emailApiKey.length : 0,
        apiKeyPrefix: emailApiKey ? emailApiKey.substring(0, 3) : 'N/A'
    });

    if (!emailApiKey || !emailService) {
        console.error('Email service not configured. Missing:', {
            EMAIL_SERVICE: !emailService ? 'MISSING' : 'set',
            EMAIL_API_KEY: !emailApiKey ? 'MISSING' : 'set'
        });
        console.log('Verification URL:', verificationUrl);
        return false;
    }

    // Resend integration (recommended - free forever)
    if (emailService === 'resend') {
        try {
            const response = await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${emailApiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    from: process.env.FROM_EMAIL || `noreply@${ALLOWED_EMAIL_DOMAIN}`,
                    to: [email],
                    subject: 'Verify your EOL Checker account',
                    html: `
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
                    `
                })
            });

            if (response.ok) {
                console.log(`Verification email sent successfully to ${email}`);
                return true;
            } else {
                const errorData = await response.json();
                console.error('Resend API error:', errorData);
                return false;
            }
        } catch (error) {
            console.error('Failed to send email via Resend:', error);
            return false;
        }
    }

    // SendGrid integration (legacy - free tier now limited to 60 days)
    if (emailService === 'sendgrid') {
        try {
            const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${emailApiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    personalizations: [{
                        to: [{ email }]
                    }],
                    from: {
                        email: process.env.FROM_EMAIL || `noreply@${ALLOWED_EMAIL_DOMAIN}`
                    },
                    subject: 'Verify your EOL Checker account',
                    content: [{
                        type: 'text/html',
                        value: `
                            <h2>Welcome to Syntegon EOL Checker</h2>
                            <p>Please verify your email address by clicking the link below:</p>
                            <p><a href="${verificationUrl}">Verify Email</a></p>
                            <p>Or copy and paste this URL into your browser:</p>
                            <p>${verificationUrl}</p>
                            <p>This link will expire in 48 hours.</p>
                            <p>If you didn't create this account, please ignore this email.</p>
                        `
                    }]
                })
            });

            return response.ok;
        } catch (error) {
            console.error('Failed to send email via SendGrid:', error);
            return false;
        }
    }

    // Gmail SMTP integration (free forever, 500 emails/day)
    if (emailService === 'gmail') {
        try {
            const user = process.env.EMAIL_USER;
            const pass = process.env.EMAIL_PASSWORD;

            if (!user || !pass) {
                console.error('Gmail credentials not configured:', {
                    EMAIL_USER: !user ? 'MISSING' : 'set',
                    EMAIL_PASSWORD: !pass ? 'MISSING' : 'set'
                });
                return false;
            }

            // Create transporter
            const transporter = nodemailer.createTransport({
                host: 'smtp.gmail.com',
                port: 587,
                secure: false, // Use STARTTLS
                auth: {
                    user: user,
                    pass: pass
                }
            });

            // Email content
            const mailOptions = {
                from: process.env.FROM_EMAIL || user,
                to: email,
                subject: 'Verify your EOL Checker account',
                html: `
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
                `
            };

            // Send email
            await transporter.sendMail(mailOptions);
            console.log(`Verification email sent successfully to ${email} via Gmail SMTP`);
            return true;

        } catch (error) {
            console.error('Failed to send email via Gmail SMTP:', error);
            return false;
        }
    }

    console.warn(`Unknown email service: ${emailService}`);
    return false;
}
