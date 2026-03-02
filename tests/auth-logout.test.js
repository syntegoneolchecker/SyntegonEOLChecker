/**
 * Tests for netlify/functions/auth-logout.js
 */

jest.mock("../netlify/functions/lib/auth-middleware", () => ({
	generateLogoutCookie: jest.fn(
		() => "auth_token=; HttpOnly; Secure; Path=/; Max-Age=0"
	)
}));

jest.mock("../netlify/functions/lib/logger", () => ({
	info: jest.fn(),
	warn: jest.fn(),
	error: jest.fn(),
	debug: jest.fn()
}));

jest.mock("../netlify/functions/lib/response-builder", () => ({
	getCorsOrigin: jest.fn(() => "*"),
	handleCORSPreflight: jest.fn((event) => {
		if (event.httpMethod === "OPTIONS") {
			return { statusCode: 204, headers: { "Access-Control-Allow-Origin": "*" }, body: "" };
		}
		return null;
	}),
	methodNotAllowedResponse: jest.fn((methods) => ({
		statusCode: 405,
		headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
		body: JSON.stringify({ error: `Method not allowed. Allowed: ${methods}` })
	})),
	errorResponse: jest.fn((message) => ({
		statusCode: 500,
		headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
		body: JSON.stringify({ error: message })
	}))
}));

const { handler } = require("../netlify/functions/auth-logout");
const { generateLogoutCookie } = require("../netlify/functions/lib/auth-middleware");

describe("auth-logout handler", () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	test("returns CORS preflight response for OPTIONS", async () => {
		const event = { httpMethod: "OPTIONS" };
		const result = await handler(event);

		expect(result.statusCode).toBe(204);
	});

	test("returns 405 for unsupported methods", async () => {
		const event = { httpMethod: "PUT" };
		const result = await handler(event);

		expect(result.statusCode).toBe(405);
	});

	test("successfully logs out with POST and clears cookie", async () => {
		const event = { httpMethod: "POST" };
		const result = await handler(event);

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.success).toBe(true);
		expect(body.message).toBe("Logged out successfully");
		expect(result.headers["Set-Cookie"]).toContain("Max-Age=0");
		expect(generateLogoutCookie).toHaveBeenCalled();
	});

	test("successfully logs out with GET (convenience)", async () => {
		const event = { httpMethod: "GET" };
		const result = await handler(event);

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.success).toBe(true);
	});

	test("returns 500 on internal error", async () => {
		generateLogoutCookie.mockImplementation(() => {
			throw new Error("Cookie generation failed");
		});

		const event = { httpMethod: "POST" };
		const result = await handler(event);

		expect(result.statusCode).toBe(500);
	});
});
