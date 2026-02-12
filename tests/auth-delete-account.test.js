/**
 * Tests for netlify/functions/auth-delete-account.js
 */

jest.mock("../netlify/functions/lib/logger", () => ({
	info: jest.fn(),
	warn: jest.fn(),
	error: jest.fn(),
	debug: jest.fn()
}));

jest.mock("../netlify/functions/lib/user-storage", () => ({
	getPasswordResetToken: jest.fn(),
	deletePasswordResetToken: jest.fn(),
	deleteUser: jest.fn()
}));

jest.mock("../netlify/functions/lib/response-builder", () => ({
	getCorsOrigin: jest.fn(() => "*")
}));

const { handler } = require("../netlify/functions/auth-delete-account");
const {
	getPasswordResetToken,
	deletePasswordResetToken,
	deleteUser
} = require("../netlify/functions/lib/user-storage");

describe("auth-delete-account handler", () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	test("returns 204 for OPTIONS preflight", async () => {
		const event = { httpMethod: "OPTIONS" };
		const result = await handler(event);

		expect(result.statusCode).toBe(204);
		expect(result.body).toBe("");
	});

	test("returns 405 for non-GET methods", async () => {
		const event = { httpMethod: "POST" };
		const result = await handler(event);

		expect(result.statusCode).toBe(405);
	});

	test("returns 400 when no token provided", async () => {
		const event = {
			httpMethod: "GET",
			queryStringParameters: {}
		};
		const result = await handler(event);

		expect(result.statusCode).toBe(400);
		const body = JSON.parse(result.body);
		expect(body.success).toBe(false);
		expect(body.message).toBe("No token provided");
	});

	test("returns 400 when queryStringParameters is null", async () => {
		const event = {
			httpMethod: "GET",
			queryStringParameters: null
		};
		const result = await handler(event);

		expect(result.statusCode).toBe(400);
		const body = JSON.parse(result.body);
		expect(body.message).toBe("No token provided");
	});

	test("returns 400 for invalid or expired token", async () => {
		getPasswordResetToken.mockResolvedValue(null);

		const event = {
			httpMethod: "GET",
			queryStringParameters: { token: "invalid-token-12345678" }
		};
		const result = await handler(event);

		expect(result.statusCode).toBe(400);
		const body = JSON.parse(result.body);
		expect(body.success).toBe(false);
		expect(body.message).toContain("Invalid or expired");
	});

	test("returns 400 when user not found for valid token", async () => {
		getPasswordResetToken.mockResolvedValue({ email: "test@syntegon.com" });
		deleteUser.mockResolvedValue(false);

		const event = {
			httpMethod: "GET",
			queryStringParameters: { token: "valid-token-abc12345" }
		};
		const result = await handler(event);

		expect(result.statusCode).toBe(400);
		const body = JSON.parse(result.body);
		expect(body.success).toBe(false);
		expect(body.message).toContain("Account not found");
		expect(deletePasswordResetToken).toHaveBeenCalledWith("valid-token-abc12345");
	});

	test("successfully deletes account with valid token", async () => {
		getPasswordResetToken.mockResolvedValue({ email: "test@syntegon.com" });
		deleteUser.mockResolvedValue(true);
		deletePasswordResetToken.mockResolvedValue(true);

		const event = {
			httpMethod: "GET",
			queryStringParameters: { token: "valid-token-abc12345" }
		};
		const result = await handler(event);

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.success).toBe(true);
		expect(body.message).toContain("account has been deleted");
		expect(deleteUser).toHaveBeenCalledWith("test@syntegon.com");
		expect(deletePasswordResetToken).toHaveBeenCalledWith("valid-token-abc12345");
	});

	test("returns 500 on internal error", async () => {
		getPasswordResetToken.mockRejectedValue(new Error("Storage error"));

		const event = {
			httpMethod: "GET",
			queryStringParameters: { token: "some-token-12345678" }
		};
		const result = await handler(event);

		expect(result.statusCode).toBe(500);
		const body = JSON.parse(result.body);
		expect(body.success).toBe(false);
	});
});
