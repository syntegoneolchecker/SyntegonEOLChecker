const nodemailer = require("nodemailer");
const { loginUser } = require("./lib/auth-manager");
const { generateAuthCookie } = require("./lib/auth-middleware");
const { getCorsOrigin } = require("./lib/response-builder");
const logger = require("./lib/logger");
const { recordAttempt, clearRateLimit } = require("./lib/rate-limiter");
const { validateAuthRequest } = require("./lib/auth-helpers");

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
	// Validate request and handle common errors
	const validation = await validateAuthRequest(event, "login");
	if (validation.error) {
		return validation.error;
	}

	const { email, password, clientIP } = validation;

	try {
		// Attempt login
		const result = await loginUser(email, password);

		if (!result.success) {
			// If account needs verification, send a new verification email
			if (result.needsVerification) {
				const siteUrl = constructBaseUrl(event.headers);
				const verificationUrl = `${siteUrl}/verify.html?token=${result.verificationToken}`;

				const emailSent = await sendVerificationEmail(result.email, verificationUrl);
				const message = emailSent
					? result.message
					: "Your account is not yet verified, but the verification email could not be sent. Please contact administrator.";

				return {
					statusCode: 403,
					headers: {
						"Content-Type": "application/json",
						"Access-Control-Allow-Origin": getCorsOrigin()
					},
					body: JSON.stringify({
						success: false,
						needsVerification: true,
						message,
						emailSent
					})
				};
			}

			// Record failed attempt for rate limiting
			await recordAttempt("login", clientIP);

			return {
				statusCode: 401,
				headers: {
					"Content-Type": "application/json",
					"Access-Control-Allow-Origin": getCorsOrigin()
				},
				body: JSON.stringify({
					success: false,
					message: result.message
				})
			};
		}

		// Clear rate limit on successful login
		await clearRateLimit("login", clientIP);

		// Set auth cookie
		const authCookie = generateAuthCookie(result.token);

		return {
			statusCode: 200,
			headers: {
				"Content-Type": "application/json",
				"Access-Control-Allow-Origin": getCorsOrigin(),
				"Set-Cookie": authCookie
			},
			body: JSON.stringify({
				success: true,
				message: result.message,
				token: result.token,
				user: result.user
			})
		};
	} catch (error) {
		logger.error("Login error:", error);
		return {
			statusCode: 500,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				success: false,
				message: "Internal server error during login"
			})
		};
	}
};

/**
 * Construct base URL from request headers (works correctly for branch deploys)
 * @param {Object} headers - Request headers
 * @returns {string} Base URL
 */
function constructBaseUrl(headers) {
	const protocol = headers["x-forwarded-proto"] || "https";
	const host = headers["host"];
	return `${protocol}://${host}`;
}

/**
 * Generate HTML email template for verification
 * @param {string} verificationUrl - Verification URL
 * @returns {string} HTML email content
 */
function getVerificationEmailHtml(verificationUrl) {
	return `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #333;">Verify your Syntegon EOL Checker Account</h2>
            <p>You attempted to log in but your email is not yet verified. Please verify your email address by clicking the button below:</p>
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
                If you didn't attempt to log in, please ignore this email.
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
		logger.error("Gmail credentials not configured:", {
			EMAIL_USER: user ? "set" : "MISSING",
			EMAIL_PASSWORD: pass ? "set" : "MISSING"
		});
		return false;
	}

	try {
		const transporter = nodemailer.createTransport({
			host: "smtp.gmail.com",
			port: 587,
			secure: false,
			requireTLS: true,
			auth: { user, pass }
		});

		const mailOptions = {
			from: process.env.FROM_EMAIL || user,
			to: email,
			subject: "Verify your EOL Checker account",
			html: getVerificationEmailHtml(verificationUrl)
		};

		await transporter.sendMail(mailOptions);
		logger.info(`Verification email re-sent successfully to ${email} via Gmail SMTP`);
		return true;
	} catch (error) {
		logger.error("Failed to send verification email via Gmail SMTP:", error);
		return false;
	}
}
