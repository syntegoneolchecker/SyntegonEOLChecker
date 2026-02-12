/**
 * Tests for netlify/functions/view-logs.js
 */

jest.mock("../netlify/functions/lib/logger", () => ({
	info: jest.fn(),
	warn: jest.fn(),
	error: jest.fn(),
	debug: jest.fn()
}));

jest.mock("../netlify/functions/lib/auth-middleware", () => ({
	requireAuth: jest.fn((handler) => handler)
}));

const { handler } = require("../netlify/functions/view-logs");

describe("view-logs handler", () => {
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

	test("returns 500 when Supabase not configured", async () => {
		delete process.env.SUPABASE_URL;
		delete process.env.SUPABASE_API_KEY;

		const event = { queryStringParameters: {} };
		const result = await handler(event);

		expect(result.statusCode).toBe(500);
		expect(result.body).toContain("Supabase not configured");
	});

	test("returns JSON format when requested", async () => {
		const mockLogs = [
			{ timestamp: "2025-01-15T12:00:00Z", level: "INFO", source: "test", message: "msg" }
		];

		global.fetch
			.mockResolvedValueOnce({
				ok: true,
				json: jest.fn().mockResolvedValue(mockLogs)
			})
			.mockResolvedValueOnce({
				ok: true,
				headers: {
					get: jest.fn(() => "0-0/1")
				}
			});

		const event = {
			queryStringParameters: { format: "json" }
		};
		const result = await handler(event);

		expect(result.statusCode).toBe(200);
		expect(result.headers["Content-Type"]).toBe("application/json");
		const body = JSON.parse(result.body);
		expect(body.logs).toHaveLength(1);
		expect(body.totalCount).toBe(1);
	});

	test("returns HTML format by default", async () => {
		global.fetch
			.mockResolvedValueOnce({
				ok: true,
				json: jest.fn().mockResolvedValue([])
			})
			.mockResolvedValueOnce({
				ok: true,
				headers: {
					get: jest.fn(() => "*/0")
				}
			});

		const event = { queryStringParameters: {} };
		const result = await handler(event);

		expect(result.statusCode).toBe(200);
		expect(result.headers["Content-Type"]).toBe("text/html");
		expect(result.body).toContain("<!DOCTYPE html>");
	});

	test("passes filter parameters to Supabase query", async () => {
		global.fetch
			.mockResolvedValueOnce({
				ok: true,
				json: jest.fn().mockResolvedValue([])
			})
			.mockResolvedValueOnce({
				ok: true,
				headers: {
					get: jest.fn(() => "*/0")
				}
			});

		const event = {
			queryStringParameters: {
				level: "ERROR",
				source: "netlify",
				search: "timeout",
				format: "json"
			}
		};
		const result = await handler(event);

		expect(result.statusCode).toBe(200);
		// Verify fetch was called with filter params in URL
		const fetchUrl = global.fetch.mock.calls[0][0];
		expect(fetchUrl).toContain("source=ilike");
		expect(fetchUrl).toContain("message=ilike");
	});

	test("handles pagination parameters", async () => {
		global.fetch
			.mockResolvedValueOnce({
				ok: true,
				json: jest.fn().mockResolvedValue([])
			})
			.mockResolvedValueOnce({
				ok: true,
				headers: {
					get: jest.fn(() => "*/200")
				}
			});

		const event = {
			queryStringParameters: {
				offset: "100",
				limit: "50",
				format: "json"
			}
		};
		const result = await handler(event);

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.offset).toBe(100);
		expect(body.limit).toBe(50);
		expect(body.hasMore).toBe(true);
	});

	test("clamps limit to max 1000", async () => {
		global.fetch
			.mockResolvedValueOnce({
				ok: true,
				json: jest.fn().mockResolvedValue([])
			})
			.mockResolvedValueOnce({
				ok: true,
				headers: {
					get: jest.fn(() => "*/0")
				}
			});

		const event = {
			queryStringParameters: { limit: "5000", format: "json" }
		};
		const result = await handler(event);

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.limit).toBe(1000);
	});

	test("handles null queryStringParameters", async () => {
		global.fetch
			.mockResolvedValueOnce({
				ok: true,
				json: jest.fn().mockResolvedValue([])
			})
			.mockResolvedValueOnce({
				ok: true,
				headers: {
					get: jest.fn(() => "*/0")
				}
			});

		const event = { queryStringParameters: null };
		const result = await handler(event);

		expect(result.statusCode).toBe(200);
	});

	test("returns 500 on Supabase query failure", async () => {
		global.fetch.mockResolvedValueOnce({
			ok: false,
			status: 500,
			statusText: "Internal Server Error"
		});

		const event = { queryStringParameters: {} };
		const result = await handler(event);

		expect(result.statusCode).toBe(500);
		expect(result.body).toContain("Supabase query failed");
	});
});
