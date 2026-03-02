/**
 * Tests for netlify/functions/scraping-callback.js
 */

jest.mock("../netlify/functions/lib/job-storage", () => ({
	saveUrlResult: jest.fn(),
	getJob: jest.fn()
}));

jest.mock("../netlify/functions/lib/response-builder", () => ({
	errorResponse: jest.fn((msg) => ({
		statusCode: 500,
		body: JSON.stringify({ error: msg })
	})),
	methodNotAllowedResponse: jest.fn(() => ({
		statusCode: 405,
		body: JSON.stringify({ error: "Method not allowed" })
	})),
	unauthorizedResponse: jest.fn(() => ({
		statusCode: 401,
		body: JSON.stringify({ error: "Unauthorized" })
	}))
}));

jest.mock("../netlify/functions/lib/fire-and-forget", () => ({
	triggerFetchUrl: jest.fn().mockResolvedValue(undefined)
}));

jest.mock("../netlify/functions/lib/logger", () => ({
	info: jest.fn(),
	warn: jest.fn(),
	error: jest.fn(),
	debug: jest.fn()
}));

const { handler } = require("../netlify/functions/scraping-callback");
const { saveUrlResult, getJob } = require("../netlify/functions/lib/job-storage");
const { triggerFetchUrl } = require("../netlify/functions/lib/fire-and-forget");

describe("scraping-callback handler", () => {
	const mockContext = {};

	beforeEach(() => {
		jest.clearAllMocks();
		process.env.SCRAPING_API_KEY = "valid-api-key";
	});

	test("returns 405 for non-POST methods", async () => {
		const event = { httpMethod: "GET" };
		const result = await handler(event, mockContext);

		expect(result.statusCode).toBe(405);
	});

	test("returns 401 when API key is missing", async () => {
		const event = {
			httpMethod: "POST",
			headers: {},
			body: JSON.stringify({ jobId: "test", urlIndex: 0 })
		};
		const result = await handler(event, mockContext);

		expect(result.statusCode).toBe(401);
	});

	test("returns 401 when API key is invalid", async () => {
		const event = {
			httpMethod: "POST",
			headers: { "x-api-key": "wrong-key" },
			body: JSON.stringify({ jobId: "test", urlIndex: 0 })
		};
		const result = await handler(event, mockContext);

		expect(result.statusCode).toBe(401);
	});

	test("returns 401 when SCRAPING_API_KEY not configured", async () => {
		delete process.env.SCRAPING_API_KEY;

		const event = {
			httpMethod: "POST",
			headers: { "x-api-key": "any-key" },
			body: JSON.stringify({ jobId: "test", urlIndex: 0 })
		};
		const result = await handler(event, mockContext);

		expect(result.statusCode).toBe(401);
	});

	test("saves URL result and triggers next URL when not all done", async () => {
		saveUrlResult.mockResolvedValue(false); // Not all done
		getJob.mockResolvedValue({
			urls: [
				{ index: 0, status: "complete" },
				{ index: 1, status: "pending", url: "https://next.com", title: "Next", snippet: "" }
			]
		});

		const event = {
			httpMethod: "POST",
			headers: {
				"x-api-key": "valid-api-key",
				"x-forwarded-proto": "https",
				host: "example.netlify.app"
			},
			body: JSON.stringify({
				jobId: "job-123",
				urlIndex: 0,
				content: "Scraped content",
				title: "Page Title",
				snippet: "Description",
				url: "https://example.com"
			})
		};
		const result = await handler(event, mockContext);

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.success).toBe(true);
		expect(saveUrlResult).toHaveBeenCalledWith(
			"job-123",
			0,
			expect.objectContaining({ fullContent: "Scraped content" }),
			mockContext
		);
		expect(triggerFetchUrl).toHaveBeenCalled();
	});

	test("saves URL result and skips next trigger when all done", async () => {
		saveUrlResult.mockResolvedValue(true); // All done
		getJob.mockResolvedValue({
			urls: [{ index: 0, status: "complete" }]
		});

		const event = {
			httpMethod: "POST",
			headers: {
				"x-api-key": "valid-api-key",
				"x-forwarded-proto": "https",
				host: "example.netlify.app"
			},
			body: JSON.stringify({
				jobId: "job-done",
				urlIndex: 0,
				content: "Content",
				title: "Title",
				snippet: "",
				url: "https://example.com"
			})
		};
		const result = await handler(event, mockContext);

		expect(result.statusCode).toBe(200);
		expect(triggerFetchUrl).not.toHaveBeenCalled();
	});

	test("returns 500 when saveUrlResult fails after retries", async () => {
		saveUrlResult.mockRejectedValue(new Error("Storage write failed"));

		const event = {
			httpMethod: "POST",
			headers: {
				"x-api-key": "valid-api-key",
				"x-forwarded-proto": "https",
				host: "example.netlify.app"
			},
			body: JSON.stringify({
				jobId: "job-fail",
				urlIndex: 0,
				content: "Content",
				title: "Title",
				snippet: "",
				url: "https://example.com"
			})
		};
		const result = await handler(event, mockContext);

		expect(result.statusCode).toBe(500);
	});

	test("handles JSON parse error gracefully", async () => {
		const event = {
			httpMethod: "POST",
			headers: { "x-api-key": "valid-api-key" },
			body: "invalid json"
		};
		const result = await handler(event, mockContext);

		expect(result.statusCode).toBe(500);
	});
});
