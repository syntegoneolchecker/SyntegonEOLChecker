/**
 * Tests for netlify/functions/clear-logs.js
 */

jest.mock("../netlify/functions/lib/logger", () => ({
	info: jest.fn(),
	warn: jest.fn(),
	error: jest.fn(),
	debug: jest.fn()
}));

const { handler } = require("../netlify/functions/clear-logs");

describe("clear-logs handler", () => {
	const originalEnv = process.env;
	const originalFetch = global.fetch;

	beforeEach(() => {
		jest.clearAllMocks();
		process.env = {
			...originalEnv,
			SUPABASE_URL: "https://test.supabase.co",
			SUPABASE_API_KEY: "test-api-key"
		};
		global.fetch = jest.fn();
	});

	afterEach(() => {
		process.env = originalEnv;
		global.fetch = originalFetch;
	});

	test("returns 405 for non-POST methods", async () => {
		const event = { httpMethod: "GET" };
		const result = await handler(event);

		expect(result.statusCode).toBe(405);
		const body = JSON.parse(result.body);
		expect(body.error).toContain("Method not allowed");
	});

	test("returns 500 when Supabase not configured", async () => {
		delete process.env.SUPABASE_URL;
		delete process.env.SUPABASE_API_KEY;

		const event = { httpMethod: "POST" };
		const result = await handler(event);

		expect(result.statusCode).toBe(500);
		const body = JSON.parse(result.body);
		expect(body.error).toContain("Supabase not configured");
	});

	test("successfully clears logs", async () => {
		// Mock count response
		global.fetch
			.mockResolvedValueOnce({
				ok: true,
				headers: {
					get: jest.fn((header) => {
						if (header === "content-range") return "0-49/150";
						return null;
					})
				}
			})
			// Mock delete response
			.mockResolvedValueOnce({
				ok: true
			});

		const event = { httpMethod: "POST" };
		const result = await handler(event);

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.success).toBe(true);
		expect(body.deletedCount).toBe(150);
		expect(global.fetch).toHaveBeenCalledTimes(2);
	});

	test("returns 500 when delete fails", async () => {
		global.fetch
			.mockResolvedValueOnce({
				ok: true,
				headers: {
					get: jest.fn(() => "0-0/10")
				}
			})
			.mockResolvedValueOnce({
				ok: false,
				status: 500,
				statusText: "Internal Server Error"
			});

		const event = { httpMethod: "POST" };
		const result = await handler(event);

		expect(result.statusCode).toBe(500);
		const body = JSON.parse(result.body);
		expect(body.success).toBe(false);
		expect(body.error).toContain("Failed to delete logs");
	});

	test("handles zero logs gracefully", async () => {
		global.fetch
			.mockResolvedValueOnce({
				ok: true,
				headers: {
					get: jest.fn(() => "*/0")
				}
			})
			.mockResolvedValueOnce({ ok: true });

		const event = { httpMethod: "POST" };
		const result = await handler(event);

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.deletedCount).toBe(0);
	});
});
