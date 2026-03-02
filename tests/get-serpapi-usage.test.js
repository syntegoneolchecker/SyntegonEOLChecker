/**
 * Tests for netlify/functions/get-serpapi-usage.js
 * Verifies the handler is properly wired with hybrid auth
 * and that the SerpAPI usage logic works correctly
 */

jest.mock("../netlify/functions/lib/logger", () => ({
	info: jest.fn(),
	warn: jest.fn(),
	error: jest.fn(),
	debug: jest.fn()
}));

let mockRequireHybridAuth;

const originalEnv = { ...process.env };
const originalFetch = global.fetch;

beforeEach(() => {
	jest.resetModules();
	jest.clearAllMocks();
	global.fetch = jest.fn();
	process.env.SERPAPI_API_KEY = "test-serpapi-key";

	mockRequireHybridAuth = jest.fn((handler) => {
		const wrapped = function wrappedHandler(event, context) {
			return handler(event, context);
		};
		wrapped._original = handler;
		return wrapped;
	});

	jest.mock("../netlify/functions/lib/auth-middleware", () => ({
		requireHybridAuth: mockRequireHybridAuth
	}));
});

afterEach(() => {
	global.fetch = originalFetch;
	process.env = { ...originalEnv };
});

describe("get-serpapi-usage", () => {
	test("module exports a handler function", () => {
		const { handler } = require("../netlify/functions/get-serpapi-usage");
		expect(handler).toBeDefined();
		expect(typeof handler).toBe("function");
	});

	test("handler is wrapped with requireHybridAuth", () => {
		require("../netlify/functions/get-serpapi-usage");
		expect(mockRequireHybridAuth).toHaveBeenCalledTimes(1);
		expect(mockRequireHybridAuth).toHaveBeenCalledWith(expect.any(Function));
	});

	test("should return 503 when SERPAPI_API_KEY is not set", async () => {
		delete process.env.SERPAPI_API_KEY;

		const { handler } = require("../netlify/functions/get-serpapi-usage");
		const result = await handler({}, {});

		expect(result.statusCode).toBe(503);
	});

	test("should fetch and transform SerpAPI usage data", async () => {
		global.fetch.mockResolvedValue({
			ok: true,
			json: () =>
				Promise.resolve({
					searches_per_month: 100,
					total_searches_left: 75,
					plan_name: "Free"
				})
		});

		const { handler } = require("../netlify/functions/get-serpapi-usage");
		const result = await handler({}, {});

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.usage).toBe(25); // 100 - 75
		expect(body.limit).toBe(100);
		expect(body.remaining).toBe(75);
		expect(body.plan).toBe("Free");
	});

	test("should handle missing fields with defaults", async () => {
		global.fetch.mockResolvedValue({
			ok: true,
			json: () => Promise.resolve({})
		});

		const { handler } = require("../netlify/functions/get-serpapi-usage");
		const result = await handler({}, {});

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.limit).toBe(100); // default
		expect(body.remaining).toBe(0); // default
		expect(body.plan).toBe("Unknown");
	});

	test("should handle API errors", async () => {
		global.fetch.mockResolvedValue({
			ok: false,
			status: 401,
			text: () => Promise.resolve("Invalid API key")
		});

		const { handler } = require("../netlify/functions/get-serpapi-usage");
		const result = await handler({}, {});

		expect(result.statusCode).toBe(401);
		const body = JSON.parse(result.body);
		expect(body.error).toContain("SerpAPI");
		expect(body.details).toBe("Invalid API key");
	});

	test("should handle fetch exceptions", async () => {
		global.fetch.mockRejectedValue(new Error("Network failure"));

		const { handler } = require("../netlify/functions/get-serpapi-usage");
		const result = await handler({}, {});

		expect(result.statusCode).toBe(500);
		const body = JSON.parse(result.body);
		expect(body.error.message).toContain("Network failure");
	});
});
