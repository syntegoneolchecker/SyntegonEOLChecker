/**
 * Tests for netlify/functions/get-groq-usage.js
 * Verifies the handler is properly wired with hybrid auth
 * and that the Groq usage logic works correctly
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
	process.env.GROQ_API_KEY = "test-groq-key";

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

describe("get-groq-usage", () => {
	test("module exports a handler function", () => {
		const { handler } = require("../netlify/functions/get-groq-usage");
		expect(handler).toBeDefined();
		expect(typeof handler).toBe("function");
	});

	test("handler is wrapped with requireHybridAuth", () => {
		require("../netlify/functions/get-groq-usage");
		expect(mockRequireHybridAuth).toHaveBeenCalledTimes(1);
		expect(mockRequireHybridAuth).toHaveBeenCalledWith(expect.any(Function));
	});

	test("should return 503 when GROQ_API_KEY is not set", async () => {
		delete process.env.GROQ_API_KEY;

		const { handler } = require("../netlify/functions/get-groq-usage");
		const result = await handler({}, {});

		expect(result.statusCode).toBe(503);
	});

	test("should extract rate limit headers from Groq response", async () => {
		const headers = new Map([
			["x-ratelimit-remaining-tokens", "7500"],
			["x-ratelimit-limit-tokens", "8000"],
			["x-ratelimit-reset-tokens", "3.5s"]
		]);

		global.fetch.mockResolvedValue({
			ok: true,
			headers: { get: (h) => headers.get(h) || null },
			json: () => Promise.resolve({})
		});

		const { handler } = require("../netlify/functions/get-groq-usage");
		const result = await handler({}, {});

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.remainingTokens).toBe("7500");
		expect(body.limitTokens).toBe("8000");
		expect(body.resetSeconds).toBe(3.5);
	});

	test("should handle missing rate limit headers with defaults", async () => {
		global.fetch.mockResolvedValue({
			ok: true,
			headers: { get: () => null },
			json: () => Promise.resolve({})
		});

		const { handler } = require("../netlify/functions/get-groq-usage");
		const result = await handler({}, {});

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.remainingTokens).toBe("0");
		expect(body.limitTokens).toBe("8000");
		expect(body.resetSeconds).toBeNull();
	});

	test('should handle reset tokens without "s" suffix', async () => {
		const headers = new Map([
			["x-ratelimit-remaining-tokens", "5000"],
			["x-ratelimit-limit-tokens", "8000"],
			["x-ratelimit-reset-tokens", "7.66"]
		]);

		global.fetch.mockResolvedValue({
			ok: true,
			headers: { get: (h) => headers.get(h) || null },
			json: () => Promise.resolve({})
		});

		const { handler } = require("../netlify/functions/get-groq-usage");
		const result = await handler({}, {});

		const body = JSON.parse(result.body);
		expect(body.resetSeconds).toBe(7.66);
	});

	test("should handle unparseable reset token format", async () => {
		const headers = new Map([
			["x-ratelimit-remaining-tokens", "5000"],
			["x-ratelimit-limit-tokens", "8000"],
			["x-ratelimit-reset-tokens", "invalid"]
		]);

		global.fetch.mockResolvedValue({
			ok: true,
			headers: { get: (h) => headers.get(h) || null },
			json: () => Promise.resolve({})
		});

		const { handler } = require("../netlify/functions/get-groq-usage");
		const result = await handler({}, {});

		const body = JSON.parse(result.body);
		expect(body.resetSeconds).toBeNull();
	});

	test("should handle Groq API errors", async () => {
		global.fetch.mockResolvedValue({
			ok: false,
			status: 429,
			text: () => Promise.resolve("Rate limit exceeded")
		});

		const { handler } = require("../netlify/functions/get-groq-usage");
		const result = await handler({}, {});

		expect(result.statusCode).toBe(429);
		const body = JSON.parse(result.body);
		expect(body.error).toContain("Groq");
	});

	test("should handle Groq fetch exceptions", async () => {
		global.fetch.mockRejectedValue(new Error("Connection refused"));

		const { handler } = require("../netlify/functions/get-groq-usage");
		const result = await handler({}, {});

		expect(result.statusCode).toBe(500);
	});

	test("should send correct request to Groq API", async () => {
		global.fetch.mockResolvedValue({
			ok: true,
			headers: { get: () => null },
			json: () => Promise.resolve({})
		});

		const { handler } = require("../netlify/functions/get-groq-usage");
		await handler({}, {});

		expect(global.fetch).toHaveBeenCalledWith(
			"https://api.groq.com/openai/v1/chat/completions",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({
					Authorization: "Bearer test-groq-key",
					"Content-Type": "application/json"
				})
			})
		);
	});
});
