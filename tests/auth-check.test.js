/**
 * Tests for netlify/functions/auth-check.js
 */

// Mock dependencies
jest.mock("../netlify/functions/lib/auth-middleware", () => ({
	getAuthenticatedUser: jest.fn()
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

const { handler } = require("../netlify/functions/auth-check");
const { getAuthenticatedUser } = require("../netlify/functions/lib/auth-middleware");

describe("auth-check handler", () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	test("returns 204 for OPTIONS preflight request", async () => {
		const event = { httpMethod: "OPTIONS" };
		const result = await handler(event);

		expect(result.statusCode).toBe(204);
		expect(result.headers["Access-Control-Allow-Origin"]).toBe("*");
		expect(result.headers["Access-Control-Allow-Methods"]).toBe("GET, OPTIONS");
		expect(result.body).toBe("");
	});

	test("returns 405 for non-GET methods", async () => {
		const event = { httpMethod: "POST" };
		const result = await handler(event);

		expect(result.statusCode).toBe(405);
		const body = JSON.parse(result.body);
		expect(body.error).toBe("Method not allowed");
	});

	test("returns authenticated: false when no user found", async () => {
		getAuthenticatedUser.mockResolvedValue(null);

		const event = { httpMethod: "GET" };
		const result = await handler(event);

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.authenticated).toBe(false);
	});

	test("returns authenticated: true with user when authenticated", async () => {
		const mockUser = { id: "user-123", email: "test@syntegon.com" };
		getAuthenticatedUser.mockResolvedValue(mockUser);

		const event = { httpMethod: "GET" };
		const result = await handler(event);

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.authenticated).toBe(true);
		expect(body.user).toEqual(mockUser);
	});

	test("returns 500 on internal error", async () => {
		getAuthenticatedUser.mockRejectedValue(new Error("DB connection failed"));

		const event = { httpMethod: "GET" };
		const result = await handler(event);

		expect(result.statusCode).toBe(500);
		const body = JSON.parse(result.body);
		expect(body.authenticated).toBe(false);
		expect(body.error).toBe("Internal server error");
	});

	test("includes CORS headers in all responses", async () => {
		getAuthenticatedUser.mockResolvedValue(null);

		const event = { httpMethod: "GET" };
		const result = await handler(event);

		expect(result.headers["Access-Control-Allow-Origin"]).toBe("*");
	});
});
