/**
 * Tests for netlify/functions/get-auto-check-state.js
 */

const mockGetStore = jest.fn();
jest.mock("@netlify/blobs", () => ({
	getStore: mockGetStore
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
	errorResponse: jest.fn((message, details) => ({
		statusCode: 500,
		headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
		body: JSON.stringify({ error: message, ...details })
	}))
}));

jest.mock("../netlify/functions/lib/auth-middleware", () => ({
	requireHybridAuth: jest.fn((handler) => handler)
}));

const { handler } = require("../netlify/functions/get-auto-check-state");

describe("get-auto-check-state handler", () => {
	let mockStore;

	beforeEach(() => {
		jest.clearAllMocks();
		mockStore = {
			get: jest.fn(),
			setJSON: jest.fn().mockResolvedValue(undefined)
		};
		mockGetStore.mockReturnValue(mockStore);
		process.env.SITE_ID = "test-site";
		process.env.NETLIFY_TOKEN = "test-token";
	});

	test("returns 204 for OPTIONS preflight", async () => {
		const event = { httpMethod: "OPTIONS" };
		const result = await handler(event, {});

		expect(result.statusCode).toBe(204);
	});

	test("returns existing state from blob storage", async () => {
		const existingState = {
			enabled: true,
			dailyCounter: 5,
			lastResetDate: "2025-01-15",
			isRunning: false,
			lastActivityTime: null
		};
		mockStore.get.mockResolvedValue(existingState);

		const event = { httpMethod: "GET" };
		const result = await handler(event, {});

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.enabled).toBe(true);
		expect(body.dailyCounter).toBe(5);
		expect(mockStore.setJSON).not.toHaveBeenCalled();
	});

	test("initializes default state when none exists", async () => {
		mockStore.get.mockResolvedValue(null);

		const event = { httpMethod: "GET" };
		const result = await handler(event, {});

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.enabled).toBe(false);
		expect(body.dailyCounter).toBe(0);
		expect(body.isRunning).toBe(false);
		expect(mockStore.setJSON).toHaveBeenCalledWith("state", expect.objectContaining({
			enabled: false,
			dailyCounter: 0,
			isRunning: false
		}));
	});

	test("includes no-cache headers", async () => {
		mockStore.get.mockResolvedValue({ enabled: false, dailyCounter: 0 });

		const event = { httpMethod: "GET" };
		const result = await handler(event, {});

		expect(result.headers["Cache-Control"]).toContain("no-store");
		expect(result.headers["Pragma"]).toBe("no-cache");
	});

	test("returns 500 on blob storage error", async () => {
		mockStore.get.mockRejectedValue(new Error("Blob error"));

		const event = { httpMethod: "GET" };
		const result = await handler(event, {});

		expect(result.statusCode).toBe(500);
	});
});
