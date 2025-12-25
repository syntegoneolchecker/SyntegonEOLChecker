const { registerUser, ALLOWED_EMAIL_DOMAIN } = require('./lib/auth-manager');

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
        const verificationUrl = `${siteUrl}/verify?token=${result.verificationToken}`;

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
                // In production, don't include verificationUrl in response
                // Only include it here for development/testing
                ...(process.env.CONTEXT !== 'production' && { verificationUrl }),
                emailSent
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
    const emailService = process.env.EMAIL_SERVICE; // 'sendgrid', 'ses', etc.

    if (!emailApiKey || !emailService) {
        console.log('Email service not configured. Verification URL:', verificationUrl);
        return false;
    }

    // Example: SendGrid integration
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
            console.error('Failed to send email:', error);
            return false;
        }
    }

    // Add other email service integrations here (AWS SES, etc.)

    return false;
}
