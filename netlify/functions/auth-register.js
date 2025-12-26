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

        // Send verification email (supports Resend, SendGrid, Gmail SMTP)
        console.log(`Verification URL for ${email}: ${verificationUrl}`);
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
 * Send email via Resend API
 */
async function sendViaResend(email, verificationUrl, apiKey) {
    try {
        const response = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                from: process.env.FROM_EMAIL || `noreply@${ALLOWED_EMAIL_DOMAIN}`,
                to: [email],
                subject: 'Verify your EOL Checker account',
                html: getVerificationEmailHtml(verificationUrl)
            })
        });

        if (response.ok) {
            console.log(`Verification email sent successfully to ${email}`);
            return true;
        }

        const errorData = await response.json();
        console.error('Resend API error:', errorData);
        return false;
    } catch (error) {
        console.error('Failed to send email via Resend:', error);
        return false;
    }
}

/**
 * Send email via SendGrid API
 */
async function sendViaSendGrid(email, verificationUrl, apiKey) {
    try {
        const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
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
                    value: getVerificationEmailHtml(verificationUrl)
                }]
            })
        });

        return response.ok;
    } catch (error) {
        console.error('Failed to send email via SendGrid:', error);
        return false;
    }
}

/**
 * Send email via Gmail SMTP
 */
async function sendViaGmail(email, verificationUrl) {
    const user = process.env.EMAIL_USER;
    const pass = process.env.EMAIL_PASSWORD;

    if (!user || !pass) {
        console.error('Gmail credentials not configured:', {
            EMAIL_USER: !user ? 'MISSING' : 'set',
            EMAIL_PASSWORD: !pass ? 'MISSING' : 'set'
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
        console.log(`Verification email sent successfully to ${email} via Gmail SMTP`);
        return true;
    } catch (error) {
        console.error('Failed to send email via Gmail SMTP:', error);
        return false;
    }
}

/**
 * Send verification email using configured email service
 * @param {string} email - Recipient email
 * @param {string} verificationUrl - Verification URL
 * @returns {Promise<boolean>} True if email was sent
 */
async function sendVerificationEmail(email, verificationUrl) {
    const emailApiKey = process.env.EMAIL_API_KEY;
    const emailService = process.env.EMAIL_SERVICE;

    console.log('Email service config check:', {
        emailService: emailService || 'NOT SET',
        hasApiKey: !!emailApiKey
    });

    if (!emailApiKey || !emailService) {
        console.error('Email service not configured. Missing:', {
            EMAIL_SERVICE: !emailService ? 'MISSING' : 'set',
            EMAIL_API_KEY: !emailApiKey ? 'MISSING' : 'set'
        });
        console.log('Verification URL:', verificationUrl);
        return false;
    }

    // Route to appropriate email service handler
    const handlers = {
        'resend': () => sendViaResend(email, verificationUrl, emailApiKey),
        'sendgrid': () => sendViaSendGrid(email, verificationUrl, emailApiKey),
        'gmail': () => sendViaGmail(email, verificationUrl)
    };

    const handler = handlers[emailService];
    if (!handler) {
        console.warn(`Unknown email service: ${emailService}`);
        return false;
    }

    return await handler();
}
