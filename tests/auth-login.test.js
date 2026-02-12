/**
 * Tests for netlify/functions/auth-login.js
 */

jest.mock("../netlify/functions/lib/auth-manager", () => ({
	loginUser: jest.fn()
}));

jest.mock("../netlify/functions/lib/auth-middleware", () => ({
	generateAuthCookie: jest.fn(() => "auth_token=jwt-token; HttpOnly; Secure; Path=/")
}));

jest.mock("../netlify/functions/lib/response-builder", () => ({
	getCorsOrigin: jest.fn(() => "*")
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
	clearRateLimit: jest.fn(),
	getClientIP: jest.fn(() => "1.2.3.4")
}));

jest.mock("../netlify/functions/lib/auth-helpers", () => ({
	validateAuthRequest: jest.fn()
}));

const { handler } = require("../netlify/functions/auth-login");
const { loginUser } = require("../netlify/functions/lib/auth-manager");
const { recordAttempt, clearRateLimit } = require("../netlify/functions/lib/rate-limiter");
const { validateAuthRequest } = require("../netlify/functions/lib/auth-helpers");

describe("auth-login handler", () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	test("returns validation error when validateAuthRequest fails", async () => {
		const errorResponse = {
			statusCode: 400,
			body: JSON.stringify({ success: false, message: "Invalid email" })
		};
		validateAuthRequest.mockResolvedValue({ error: errorResponse });

		const event = {
			httpMethod: "POST",
			body: JSON.stringify({ email: "bad", password: "test" })
		};
		const result = await handler(event);

		expect(result.statusCode).toBe(400);
	});

	test("returns 401 on failed login and records attempt", async () => {
		validateAuthRequest.mockResolvedValue({
			email: "test@syntegon.com",
			password: "wrongpass",
			clientIP: "1.2.3.4"
		});
		loginUser.mockResolvedValue({ success: false, message: "Invalid credentials" });

		const event = {
			httpMethod: "POST",
			body: JSON.stringify({ email: "test@syntegon.com", password: "wrongpass" })
		};
		const result = await handler(event);

		expect(result.statusCode).toBe(401);
		const body = JSON.parse(result.body);
		expect(body.success).toBe(false);
		expect(body.message).toBe("Invalid credentials");
		expect(recordAttempt).toHaveBeenCalledWith("login", "1.2.3.4");
	});

	test("returns 200 on successful login with token and cookie", async () => {
		validateAuthRequest.mockResolvedValue({
			email: "test@syntegon.com",
			password: "correct",
			clientIP: "1.2.3.4"
		});
		loginUser.mockResolvedValue({
			success: true,
			message: "Login successful",
			token: "jwt-token-123",
			user: { id: "user-1", email: "test@syntegon.com" }
		});

		const event = {
			httpMethod: "POST",
			body: JSON.stringify({ email: "test@syntegon.com", password: "correct" })
		};
		const result = await handler(event);

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.success).toBe(true);
		expect(body.token).toBe("jwt-token-123");
		expect(body.user.email).toBe("test@syntegon.com");
		expect(result.headers["Set-Cookie"]).toContain("auth_token");
		expect(clearRateLimit).toHaveBeenCalledWith("login", "1.2.3.4");
	});

	test("returns 500 on internal error", async () => {
		validateAuthRequest.mockResolvedValue({
			email: "test@syntegon.com",
			password: "test",
			clientIP: "1.2.3.4"
		});
		loginUser.mockRejectedValue(new Error("Database connection failed"));

		const event = {
			httpMethod: "POST",
			body: JSON.stringify({ email: "test@syntegon.com", password: "test" })
		};
		const result = await handler(event);

		expect(result.statusCode).toBe(500);
		const body = JSON.parse(result.body);
		expect(body.success).toBe(false);
		expect(body.message).toContain("Internal server error");
	});
});
