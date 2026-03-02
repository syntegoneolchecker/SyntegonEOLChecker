/**
 * Tests for netlify/functions/auth-verify.js
 */

jest.mock("../netlify/functions/lib/auth-manager", () => ({
	verifyEmail: jest.fn()
}));

jest.mock("../netlify/functions/lib/logger", () => ({
	info: jest.fn(),
	warn: jest.fn(),
	error: jest.fn(),
	debug: jest.fn()
}));

jest.mock("../netlify/functions/lib/response-builder", () => ({
	getCorsOrigin: jest.fn(() => "*")
}));

const { handler } = require("../netlify/functions/auth-verify");
const { verifyEmail } = require("../netlify/functions/lib/auth-manager");

describe("auth-verify handler", () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	test("returns 204 for OPTIONS preflight", async () => {
		const event = { httpMethod: "OPTIONS" };
		const result = await handler(event);

		expect(result.statusCode).toBe(204);
	});

	test("returns 405 for non-GET methods", async () => {
		const event = { httpMethod: "POST" };
		const result = await handler(event);

		expect(result.statusCode).toBe(405);
		const body = JSON.parse(result.body);
		expect(body.message).toBe("Method not allowed");
	});

	test("returns 400 when token is missing", async () => {
		const event = {
			httpMethod: "GET",
			queryStringParameters: {}
		};
		const result = await handler(event);

		expect(result.statusCode).toBe(400);
		const body = JSON.parse(result.body);
		expect(body.success).toBe(false);
		expect(body.message).toBe("Verification token is required");
	});

	test("returns 400 when queryStringParameters is null", async () => {
		const event = {
			httpMethod: "GET",
			queryStringParameters: null
		};
		const result = await handler(event);

		expect(result.statusCode).toBe(400);
		const body = JSON.parse(result.body);
		expect(body.message).toBe("Verification token is required");
	});

	test("returns 200 on successful verification", async () => {
		verifyEmail.mockResolvedValue({
			success: true,
			message: "Email verified successfully. You can now log in."
		});

		const event = {
			httpMethod: "GET",
			queryStringParameters: { token: "valid-verify-token" }
		};
		const result = await handler(event);

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.success).toBe(true);
		expect(verifyEmail).toHaveBeenCalledWith("valid-verify-token");
	});

	test("returns 400 on failed verification", async () => {
		verifyEmail.mockResolvedValue({
			success: false,
			message: "Invalid or expired verification token"
		});

		const event = {
			httpMethod: "GET",
			queryStringParameters: { token: "expired-token" }
		};
		const result = await handler(event);

		expect(result.statusCode).toBe(400);
		const body = JSON.parse(result.body);
		expect(body.success).toBe(false);
	});

	test("returns 500 on internal error", async () => {
		verifyEmail.mockRejectedValue(new Error("Database error"));

		const event = {
			httpMethod: "GET",
			queryStringParameters: { token: "some-token" }
		};
		const result = await handler(event);

		expect(result.statusCode).toBe(500);
		const body = JSON.parse(result.body);
		expect(body.success).toBe(false);
		expect(body.message).toContain("Internal server error");
	});
});
