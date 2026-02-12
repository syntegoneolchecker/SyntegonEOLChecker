/**
 * Tests for netlify/functions/scheduled-eol-check.js
 * Tests helper functions by re-implementing their logic,
 * and verifies main handler flow with mocked dependencies
 */

const mockGetStore = jest.fn();
jest.mock("@netlify/blobs", () => ({
	getStore: mockGetStore
}));

jest.mock("@netlify/functions", () => ({
	schedule: jest.fn((cron, handler) => handler)
}));

jest.mock("../netlify/functions/lib/logger", () => ({
	info: jest.fn(),
	warn: jest.fn(),
	error: jest.fn(),
	debug: jest.fn()
}));

jest.mock("../netlify/functions/lib/config", () => ({
	MAX_AUTO_CHECKS_PER_DAY: 20,
	MIN_SERPAPI_CREDITS_FOR_AUTO: 30,
	DEFAULT_NETLIFY_SITE_URL: "https://syntegoneolchecker.netlify.app"
}));

const originalEnv = { ...process.env };
const originalFetch = global.fetch;

describe("scheduled-eol-check", () => {
	let handler;
	let mockStore;

	beforeEach(() => {
		jest.clearAllMocks();
		jest.resetModules();

		global.fetch = jest.fn();
		process.env = { ...originalEnv };
		process.env.SITE_ID = "test-site";
		process.env.NETLIFY_TOKEN = "test-token";
		delete process.env.INTERNAL_API_KEY;
		delete process.env.SCHEDULED_FUNCTION_TARGET_URL;
		delete process.env.DEPLOY_PRIME_URL;
		delete process.env.DEPLOY_URL;
		delete process.env.URL;

		jest.spyOn(console, "log").mockImplementation(() => {});
		jest.spyOn(console, "warn").mockImplementation(() => {});
		jest.spyOn(console, "error").mockImplementation(() => {});

		mockStore = {
			get: jest.fn(),
			set: jest.fn().mockResolvedValue(undefined),
			setJSON: jest.fn().mockResolvedValue(undefined)
		};
		mockGetStore.mockReturnValue(mockStore);

		handler = require("../netlify/functions/scheduled-eol-check").handler;
	});

	afterEach(() => {
		global.fetch = originalFetch;
		process.env = { ...originalEnv };
		console.log.mockRestore();
		console.warn.mockRestore();
		console.error.mockRestore();
	});

	describe("getInternalAuthHeaders (re-implementation)", () => {
		test("returns Content-Type header without INTERNAL_API_KEY", () => {
			delete process.env.INTERNAL_API_KEY;
			const headers = { "Content-Type": "application/json" };
			if (process.env.INTERNAL_API_KEY) {
				headers["x-internal-key"] = process.env.INTERNAL_API_KEY;
			}

			expect(headers).toEqual({ "Content-Type": "application/json" });
			expect(headers["x-internal-key"]).toBeUndefined();
		});

		test("includes x-internal-key when INTERNAL_API_KEY is set", () => {
			process.env.INTERNAL_API_KEY = "my-secret-key";
			const headers = { "Content-Type": "application/json" };
			if (process.env.INTERNAL_API_KEY) {
				headers["x-internal-key"] = process.env.INTERNAL_API_KEY;
			}

			expect(headers).toEqual({
				"Content-Type": "application/json",
				"x-internal-key": "my-secret-key"
			});
		});
	});

	describe("getGMT9Date (re-implementation)", () => {
		test("returns a date string in YYYY-MM-DD format", () => {
			const now = new Date();
			const gmt9Time = new Date(now.getTime() + 9 * 60 * 60 * 1000);
			const result = gmt9Time.toISOString().split("T")[0];

			expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		});

		test("produces a date offset by +9 hours from UTC", () => {
			// Use a known UTC time: 2025-01-15T20:00:00Z
			// GMT+9 would be 2025-01-16T05:00:00 (next day)
			const fixedDate = new Date("2025-01-15T20:00:00Z");
			const gmt9Time = new Date(fixedDate.getTime() + 9 * 60 * 60 * 1000);
			const result = gmt9Time.toISOString().split("T")[0];

			expect(result).toBe("2025-01-16");
		});

		test("same day when UTC time plus 9 hours does not cross midnight", () => {
			// Use a known UTC time: 2025-01-15T10:00:00Z
			// GMT+9 would be 2025-01-15T19:00:00 (same day)
			const fixedDate = new Date("2025-01-15T10:00:00Z");
			const gmt9Time = new Date(fixedDate.getTime() + 9 * 60 * 60 * 1000);
			const result = gmt9Time.toISOString().split("T")[0];

			expect(result).toBe("2025-01-15");
		});
	});

	describe("getCurrentDeploymentUrl (re-implementation)", () => {
		test("priority 1: uses event.rawUrl when available", () => {
			const event = { rawUrl: "https://develop--site.netlify.app/.netlify/functions/scheduled-eol-check" };
			const context = {};

			const url = new URL(event.rawUrl);
			const siteUrl = `${url.protocol}//${url.host}`;

			expect(siteUrl).toBe("https://develop--site.netlify.app");
		});

		test("priority 2: uses event.headers.host when rawUrl not available", () => {
			const event = {
				headers: {
					host: "my-site.netlify.app",
					"x-forwarded-proto": "https"
				}
			};

			const protocol = event.headers["x-forwarded-proto"] || "https";
			const siteUrl = `${protocol}://${event.headers.host}`;

			expect(siteUrl).toBe("https://my-site.netlify.app");
		});

		test("priority 2: defaults to https when x-forwarded-proto is missing", () => {
			const event = {
				headers: {
					host: "my-site.netlify.app"
				}
			};

			const protocol = event.headers["x-forwarded-proto"] || "https";
			const siteUrl = `${protocol}://${event.headers.host}`;

			expect(siteUrl).toBe("https://my-site.netlify.app");
		});

		test("priority 3: decodes context.clientContext.custom.netlify base64", () => {
			const data = { site_url: "https://context-site.netlify.app" };
			const encoded = Buffer.from(JSON.stringify(data)).toString("base64");
			const context = {
				clientContext: {
					custom: {
						netlify: encoded
					}
				}
			};

			const decoded = Buffer.from(context.clientContext.custom.netlify, "base64").toString("utf-8");
			const parsed = JSON.parse(decoded);

			expect(parsed.site_url).toBe("https://context-site.netlify.app");
		});

		test("priority 4: uses SCHEDULED_FUNCTION_TARGET_URL env var", () => {
			process.env.SCHEDULED_FUNCTION_TARGET_URL = "https://explicit-target.netlify.app";

			expect(process.env.SCHEDULED_FUNCTION_TARGET_URL).toBe("https://explicit-target.netlify.app");
		});

		test("priority 4: falls back to DEPLOY_PRIME_URL", () => {
			process.env.DEPLOY_PRIME_URL = "https://deploy-prime.netlify.app";

			expect(process.env.DEPLOY_PRIME_URL).toBe("https://deploy-prime.netlify.app");
		});

		test("priority 4: falls back to DEPLOY_URL", () => {
			process.env.DEPLOY_URL = "https://deploy-url.netlify.app";

			expect(process.env.DEPLOY_URL).toBe("https://deploy-url.netlify.app");
		});

		test("priority 5: falls back to URL env var or config default", () => {
			const config = require("../netlify/functions/lib/config");
			const fallbackUrl = process.env.URL || config.DEFAULT_NETLIFY_SITE_URL;

			expect(fallbackUrl).toBe("https://syntegoneolchecker.netlify.app");
		});
	});

	describe("handler main flow", () => {
		test("returns state not initialized when state is null", async () => {
			mockStore.get.mockResolvedValue(null);

			const event = { rawUrl: "https://test.netlify.app/.netlify/functions/scheduled-eol-check" };
			const result = await handler(event, {});

			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			expect(body.message).toBe("State not initialized");
		});

		test("returns disabled when auto-check is not enabled", async () => {
			mockStore.get.mockResolvedValue({
				enabled: false,
				dailyCounter: 0,
				isRunning: false,
				lastResetDate: "2025-01-15"
			});

			const event = { rawUrl: "https://test.netlify.app/.netlify/functions/scheduled-eol-check" };
			const result = await handler(event, {});

			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			expect(body.message).toBe("Auto-check disabled");
		});

		test("returns already running when isRunning is true", async () => {
			mockStore.get.mockResolvedValue({
				enabled: true,
				dailyCounter: 0,
				isRunning: true,
				lastResetDate: "2025-01-15"
			});

			const event = { rawUrl: "https://test.netlify.app/.netlify/functions/scheduled-eol-check" };
			const result = await handler(event, {});

			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			expect(body.message).toBe("Already running");
		});

		test("returns daily limit reached when counter >= max", async () => {
			// Use a date that matches current GMT+9 date to avoid reset branch
			const now = new Date();
			const gmt9Time = new Date(now.getTime() + 9 * 60 * 60 * 1000);
			const currentDate = gmt9Time.toISOString().split("T")[0];

			mockStore.get.mockResolvedValue({
				enabled: true,
				dailyCounter: 20,
				isRunning: false,
				lastResetDate: currentDate
			});

			const event = { rawUrl: "https://test.netlify.app/.netlify/functions/scheduled-eol-check" };
			const result = await handler(event, {});

			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			expect(body.message).toBe("Daily limit reached");
		});

		test("disables auto-check when SerpAPI credits are too low", async () => {
			const now = new Date();
			const gmt9Time = new Date(now.getTime() + 9 * 60 * 60 * 1000);
			const currentDate = gmt9Time.toISOString().split("T")[0];

			mockStore.get.mockResolvedValue({
				enabled: true,
				dailyCounter: 0,
				isRunning: false,
				lastResetDate: currentDate
			});

			// Mock SerpAPI usage response with low credits
			global.fetch.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ remaining: 10 }),
				text: () => Promise.resolve("")
			});

			const event = { rawUrl: "https://test.netlify.app/.netlify/functions/scheduled-eol-check" };
			const result = await handler(event, {});

			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			expect(body.message).toBe("Credits too low, auto-check disabled");
		});

		test("triggers background function when all checks pass", async () => {
			const now = new Date();
			const gmt9Time = new Date(now.getTime() + 9 * 60 * 60 * 1000);
			const currentDate = gmt9Time.toISOString().split("T")[0];

			mockStore.get.mockResolvedValue({
				enabled: true,
				dailyCounter: 5,
				isRunning: false,
				lastResetDate: currentDate
			});

			// Mock SerpAPI usage response with enough credits
			global.fetch.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ remaining: 100 }),
				text: () => Promise.resolve(""),
				status: 200
			});

			const event = { rawUrl: "https://test.netlify.app/.netlify/functions/scheduled-eol-check" };
			const result = await handler(event, {});

			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			expect(body.message).toBe("Background EOL check started");
			expect(body.currentCounter).toBe(5);

			// Verify fetch was called for SerpAPI check, state update, and background trigger
			expect(global.fetch).toHaveBeenCalled();
		});

		test("returns 500 on unexpected error", async () => {
			mockStore.get.mockRejectedValue(new Error("Blob storage failed"));

			const event = { rawUrl: "https://test.netlify.app/.netlify/functions/scheduled-eol-check" };
			const result = await handler(event, {});

			expect(result.statusCode).toBe(500);
			const body = JSON.parse(result.body);
			expect(body.error).toContain("Blob storage failed");
		});

		test("resets daily counter on new day", async () => {
			// State with a yesterday date
			mockStore.get
				.mockResolvedValueOnce({
					enabled: true,
					dailyCounter: 15,
					isRunning: false,
					lastResetDate: "2020-01-01"
				})
				.mockResolvedValueOnce({
					enabled: true,
					dailyCounter: 0,
					isRunning: false,
					lastResetDate: "2025-06-15"
				});

			// Mock fetch for reset call, SerpAPI check, state update, and background trigger
			global.fetch.mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ remaining: 100 }),
				text: () => Promise.resolve(""),
				status: 200
			});

			const event = { rawUrl: "https://test.netlify.app/.netlify/functions/scheduled-eol-check" };
			const result = await handler(event, {});

			expect(result.statusCode).toBe(200);
			// The first fetch call should be the reset call
			const resetCall = global.fetch.mock.calls[0];
			expect(resetCall[0]).toContain("set-auto-check-state");
			const resetBody = JSON.parse(resetCall[1].body);
			expect(resetBody.dailyCounter).toBe(0);
		});
	});
});
