/**
 * Tests for netlify/functions/auth-register.js
 */

jest.mock("../netlify/functions/lib/auth-manager", () => ({
	registerUser: jest.fn()
}));

jest.mock("../netlify/functions/lib/logger", () => ({
	info: jest.fn(),
	warn: jest.fn(),
	error: jest.fn(),
	debug: jest.fn()
}));

jest.mock("../netlify/functions/lib/rate-limiter", () => ({
	checkRateLimit: jest.fn(() => Promise.resolve({ allowed: true })),
	recordAttempt: jest.fn(),
	getClientIP: jest.fn(() => "1.2.3.4")
}));

jest.mock("../netlify/functions/lib/auth-helpers", () => ({
	validateAuthRequest: jest.fn()
}));

jest.mock("../netlify/functions/lib/response-builder", () => ({
	getCorsOrigin: jest.fn(() => "*")
}));

jest.mock("nodemailer", () => ({
	createTransport: jest.fn(() => ({
		sendMail: jest.fn().mockResolvedValue(true)
	}))
}));

const { handler } = require("../netlify/functions/auth-register");
const { registerUser } = require("../netlify/functions/lib/auth-manager");
const { recordAttempt } = require("../netlify/functions/lib/rate-limiter");
const { validateAuthRequest } = require("../netlify/functions/lib/auth-helpers");

describe("auth-register handler", () => {
	const originalEnv = process.env;

	beforeEach(() => {
		jest.clearAllMocks();
		process.env = {
			...originalEnv,
			EMAIL_USER: "test@gmail.com",
			EMAIL_PASSWORD: "app-password"
		};
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	test("returns validation error when validateAuthRequest fails", async () => {
		const errorResponse = {
			statusCode: 400,
			body: JSON.stringify({ success: false, message: "Invalid email format" })
		};
		validateAuthRequest.mockResolvedValue({ error: errorResponse });

		const event = {
			httpMethod: "POST",
			body: JSON.stringify({ email: "bad", password: "test" })
		};
		const result = await handler(event);

		expect(result.statusCode).toBe(400);
	});

	test("returns 400 when registration fails", async () => {
		validateAuthRequest.mockResolvedValue({
			email: "existing@syntegon.com",
			password: "Pass123!",
			clientIP: "1.2.3.4"
		});
		registerUser.mockResolvedValue({
			success: false,
			message: "Email already registered"
		});

		const event = {
			httpMethod: "POST",
			body: JSON.stringify({ email: "existing@syntegon.com", password: "Pass123!" })
		};
		const result = await handler(event);

		expect(result.statusCode).toBe(400);
		const body = JSON.parse(result.body);
		expect(body.success).toBe(false);
		expect(recordAttempt).toHaveBeenCalledWith("register", "1.2.3.4");
	});

	test("returns 201 on successful registration with email sent", async () => {
		validateAuthRequest.mockResolvedValue({
			email: "new@syntegon.com",
			password: "SecurePass123!",
			clientIP: "1.2.3.4"
		});
		registerUser.mockResolvedValue({
			success: true,
			message: "Account created. Please check your email to verify your account.",
			verificationToken: "verify-token-123"
		});

		const event = {
			httpMethod: "POST",
			body: JSON.stringify({ email: "new@syntegon.com", password: "SecurePass123!" }),
			headers: { host: "example.netlify.app", "x-forwarded-proto": "https" }
		};
		const result = await handler(event);

		expect(result.statusCode).toBe(201);
		const body = JSON.parse(result.body);
		expect(body.success).toBe(true);
		expect(body.emailSent).toBe(true);
		// Security: verification URL should NOT be in response
		expect(body.verificationUrl).toBeUndefined();
	});

	test("returns 201 with warning when email fails to send", async () => {
		validateAuthRequest.mockResolvedValue({
			email: "new@syntegon.com",
			password: "SecurePass123!",
			clientIP: "1.2.3.4"
		});
		registerUser.mockResolvedValue({
			success: true,
			message: "Account created. Please check your email.",
			verificationToken: "verify-token-123"
		});

		// Remove email credentials to make email sending fail
		delete process.env.EMAIL_USER;
		delete process.env.EMAIL_PASSWORD;

		const event = {
			httpMethod: "POST",
			body: JSON.stringify({ email: "new@syntegon.com", password: "SecurePass123!" }),
			headers: { host: "example.netlify.app", "x-forwarded-proto": "https" }
		};
		const result = await handler(event);

		expect(result.statusCode).toBe(201);
		const body = JSON.parse(result.body);
		expect(body.success).toBe(true);
		expect(body.emailSent).toBe(false);
	});

	test("returns 500 on internal error", async () => {
		validateAuthRequest.mockResolvedValue({
			email: "test@syntegon.com",
			password: "Pass123!",
			clientIP: "1.2.3.4"
		});
		registerUser.mockRejectedValue(new Error("Database error"));

		const event = {
			httpMethod: "POST",
			body: JSON.stringify({ email: "test@syntegon.com", password: "Pass123!" }),
			headers: { host: "example.netlify.app" }
		};
		const result = await handler(event);

		expect(result.statusCode).toBe(500);
		const body = JSON.parse(result.body);
		expect(body.success).toBe(false);
		expect(body.message).toContain("Internal server error");
	});
});
