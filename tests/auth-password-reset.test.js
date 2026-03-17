/**
 * Tests for netlify/functions/auth-password-reset.js
 */

jest.mock("../netlify/functions/lib/logger", () => ({
	info: jest.fn(),
	warn: jest.fn(),
	error: jest.fn(),
	debug: jest.fn()
}));

jest.mock("../netlify/functions/lib/rate-limiter", () => ({
	checkRateLimit: jest.fn(),
	recordAttempt: jest.fn()
}));

jest.mock("../netlify/functions/lib/user-storage", () => ({
	findUserByEmail: jest.fn(),
	storePasswordResetToken: jest.fn(),
	normalizeEmail: jest.fn((email) => email.toLowerCase().trim())
}));

jest.mock("../netlify/functions/lib/response-builder", () => ({
	getCorsOrigin: jest.fn(() => "*")
}));

jest.mock("nodemailer", () => ({
	createTransport: jest.fn(() => ({
		sendMail: jest.fn().mockResolvedValue(true)
	}))
}));

const { handler } = require("../netlify/functions/auth-password-reset");
const { checkRateLimit, recordAttempt } = require("../netlify/functions/lib/rate-limiter");
const { findUserByEmail, storePasswordResetToken } = require("../netlify/functions/lib/user-storage");

describe("auth-password-reset handler", () => {
	const originalEnv = process.env;

	beforeEach(() => {
		jest.clearAllMocks();
		process.env = {
			...originalEnv,
			EMAIL_USER: "test@gmail.com",
			EMAIL_PASSWORD: "app-password"
		};
		checkRateLimit.mockResolvedValue({ allowed: true });
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	test("returns 204 for OPTIONS preflight", async () => {
		const event = { httpMethod: "OPTIONS" };
		const result = await handler(event);

		expect(result.statusCode).toBe(204);
	});

	test("returns 405 for non-POST methods", async () => {
		const event = { httpMethod: "GET" };
		const result = await handler(event);

		expect(result.statusCode).toBe(405);
	});

	test("returns 400 for invalid JSON body", async () => {
		const event = { httpMethod: "POST", body: "not json" };
		const result = await handler(event);

		expect(result.statusCode).toBe(400);
		const body = JSON.parse(result.body);
		expect(body.message).toContain("Invalid JSON");
	});

	test("returns 400 when email is missing", async () => {
		const event = { httpMethod: "POST", body: JSON.stringify({}) };
		const result = await handler(event);

		expect(result.statusCode).toBe(400);
		const body = JSON.parse(result.body);
		expect(body.message).toBe("Email is required");
	});

	test("returns 429 when rate limited", async () => {
		checkRateLimit.mockResolvedValue({
			allowed: false,
			retryAfter: 900,
			message: "Too many attempts"
		});

		const event = {
			httpMethod: "POST",
			body: JSON.stringify({ email: "test@syntegon.com" })
		};
		const result = await handler(event);

		expect(result.statusCode).toBe(429);
		const body = JSON.parse(result.body);
		expect(body.retryAfter).toBe(900);
	});

	test("returns generic success message for existing verified user", async () => {
		findUserByEmail.mockResolvedValue({ email: "test@syntegon.com", verified: true });

		const event = {
			httpMethod: "POST",
			body: JSON.stringify({ email: "test@syntegon.com" }),
			headers: { host: "example.netlify.app", "x-forwarded-proto": "https" }
		};
		const result = await handler(event);

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.success).toBe(true);
		expect(body.message).toContain("If an account exists");
		expect(storePasswordResetToken).toHaveBeenCalled();
		expect(recordAttempt).toHaveBeenCalled();
	});

	test("returns same success message for non-existent user (prevents enumeration)", async () => {
		findUserByEmail.mockResolvedValue(null);

		const event = {
			httpMethod: "POST",
			body: JSON.stringify({ email: "nobody@syntegon.com" }),
			headers: { host: "example.netlify.app" }
		};
		const result = await handler(event);

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.success).toBe(true);
		expect(body.message).toContain("If an account exists");
		expect(storePasswordResetToken).not.toHaveBeenCalled();
	});

	test("sends password reset email for unverified user", async () => {
		findUserByEmail.mockResolvedValue({ email: "unverified@syntegon.com", verified: false });

		const event = {
			httpMethod: "POST",
			body: JSON.stringify({ email: "unverified@syntegon.com" }),
			headers: { host: "example.netlify.app", "x-forwarded-proto": "https" }
		};
		const result = await handler(event);

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.success).toBe(true);
		expect(storePasswordResetToken).toHaveBeenCalled();
	});

	test("returns 500 on internal error", async () => {
		recordAttempt.mockRejectedValue(new Error("Storage failure"));

		const event = {
			httpMethod: "POST",
			body: JSON.stringify({ email: "test@syntegon.com" }),
			headers: { host: "example.netlify.app" }
		};
		const result = await handler(event);

		expect(result.statusCode).toBe(500);
		const body = JSON.parse(result.body);
		expect(body.success).toBe(false);
	});
});
