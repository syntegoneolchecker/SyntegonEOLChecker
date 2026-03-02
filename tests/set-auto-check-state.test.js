/**
 * Tests for netlify/functions/set-auto-check-state.js
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
	handleCORSPreflight: jest.fn((event) => {
		if (event.httpMethod === "OPTIONS") {
			return { statusCode: 204, headers: { "Access-Control-Allow-Origin": "*" }, body: "" };
		}
		return null;
	}),
	successResponse: jest.fn((data) => ({
		statusCode: 200,
		headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
		body: JSON.stringify(data)
	})),
	errorResponse: jest.fn((msg, details) => ({
		statusCode: 500,
		headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
		body: JSON.stringify({ error: msg, ...details })
	})),
	methodNotAllowedResponse: jest.fn(() => ({
		statusCode: 405,
		body: JSON.stringify({ error: "Method not allowed" })
	}))
}));

jest.mock("../netlify/functions/lib/auth-middleware", () => ({
	requireHybridAuth: jest.fn((handler) => handler)
}));

const { handler } = require("../netlify/functions/set-auto-check-state");

describe("set-auto-check-state handler", () => {
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

	test("returns 405 for non-POST methods", async () => {
		const event = { httpMethod: "GET" };
		const result = await handler(event, {});

		expect(result.statusCode).toBe(405);
	});

	test("updates enabled field", async () => {
		mockStore.get.mockResolvedValue({
			enabled: false,
			dailyCounter: 0,
			lastResetDate: "2025-01-15",
			isRunning: false,
			lastActivityTime: null
		});

		const event = {
			httpMethod: "POST",
			body: JSON.stringify({ enabled: true })
		};
		const result = await handler(event, {});

		expect(result.statusCode).toBe(200);
		expect(mockStore.setJSON).toHaveBeenCalledWith(
			"state",
			expect.objectContaining({ enabled: true })
		);
	});

	test("updates dailyCounter field", async () => {
		mockStore.get.mockResolvedValue({
			enabled: true,
			dailyCounter: 5,
			isRunning: false
		});

		const event = {
			httpMethod: "POST",
			body: JSON.stringify({ dailyCounter: 0 })
		};
		const result = await handler(event, {});

		expect(result.statusCode).toBe(200);
		expect(mockStore.setJSON).toHaveBeenCalledWith(
			"state",
			expect.objectContaining({ dailyCounter: 0 })
		);
	});

	test("updates isRunning and sets lastActivityTime", async () => {
		mockStore.get.mockResolvedValue({
			enabled: true,
			dailyCounter: 3,
			isRunning: false,
			lastActivityTime: null
		});

		const event = {
			httpMethod: "POST",
			body: JSON.stringify({ isRunning: true })
		};
		const result = await handler(event, {});

		expect(result.statusCode).toBe(200);
		expect(mockStore.setJSON).toHaveBeenCalledWith(
			"state",
			expect.objectContaining({
				isRunning: true,
				lastActivityTime: expect.any(String)
			})
		);
	});

	test("initializes default state when none exists", async () => {
		mockStore.get.mockResolvedValue(null);

		const event = {
			httpMethod: "POST",
			body: JSON.stringify({ enabled: true })
		};
		const result = await handler(event, {});

		expect(result.statusCode).toBe(200);
		expect(mockStore.setJSON).toHaveBeenCalledWith(
			"state",
			expect.objectContaining({
				enabled: true,
				dailyCounter: 0,
				isRunning: false
			})
		);
	});

	test("returns 500 on blob storage error", async () => {
		mockStore.get.mockRejectedValue(new Error("Blob write error"));

		const event = {
			httpMethod: "POST",
			body: JSON.stringify({ enabled: true })
		};
		const result = await handler(event, {});

		expect(result.statusCode).toBe(500);
	});
});
