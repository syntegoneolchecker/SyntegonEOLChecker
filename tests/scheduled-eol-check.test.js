/**
 * Tests for netlify/functions/scheduled-eol-check.js
 * Verifies main handler flow with mocked dependencies
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
