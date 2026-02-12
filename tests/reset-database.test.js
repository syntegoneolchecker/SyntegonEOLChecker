/**
 * Tests for netlify/functions/reset-database.js
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
	getCorsOrigin: jest.fn(() => "*")
}));

const { handler } = require("../netlify/functions/reset-database");

describe("reset-database handler", () => {
	let mockStore;

	beforeEach(() => {
		jest.clearAllMocks();
		mockStore = {
			delete: jest.fn().mockResolvedValue(undefined)
		};
		mockGetStore.mockReturnValue(mockStore);
		process.env.SITE_ID = "test-site";
		process.env.NETLIFY_TOKEN = "test-token";
	});

	test("returns 405 for non-POST methods", async () => {
		const event = { httpMethod: "GET" };
		const result = await handler(event, {});

		expect(result.statusCode).toBe(405);
		const body = JSON.parse(result.body);
		expect(body.error).toContain("Method Not Allowed");
	});

	test("successfully deletes database blob", async () => {
		const event = { httpMethod: "POST" };
		const result = await handler(event, {});

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.success).toBe(true);
		expect(body.message).toContain("Database cleared");
		expect(mockStore.delete).toHaveBeenCalledWith("database.csv");
	});

	test("returns 500 on storage error", async () => {
		mockStore.delete.mockRejectedValue(new Error("Delete failed"));

		const event = { httpMethod: "POST" };
		const result = await handler(event, {});

		expect(result.statusCode).toBe(500);
		const body = JSON.parse(result.body);
		expect(body.error).toBe("Delete failed");
	});

	test("includes CORS headers", async () => {
		const event = { httpMethod: "POST" };
		const result = await handler(event, {});

		expect(result.headers["Access-Control-Allow-Origin"]).toBe("*");
	});
});
