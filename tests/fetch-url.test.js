/**
 * Tests for netlify/functions/fetch-url.js
 */

jest.mock("../netlify/functions/lib/job-storage", () => ({
	markUrlFetching: jest.fn(),
	saveUrlResult: jest.fn(),
	getJob: jest.fn()
}));

jest.mock("../netlify/functions/lib/response-builder", () => ({
	errorResponse: jest.fn((msg, details) => ({
		statusCode: 500,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ error: msg, ...details })
	})),
	methodNotAllowedResponse: jest.fn(() => ({
		statusCode: 405,
		body: JSON.stringify({ error: "Method not allowed" })
	}))
}));

jest.mock("../netlify/functions/lib/browserql-scraper", () => ({
	scrapeWithBrowserQL: jest.fn()
}));

jest.mock("../netlify/functions/lib/retry-helpers", () => ({
	retryWithBackoff: jest.fn()
}));

jest.mock("../netlify/functions/lib/fire-and-forget", () => ({
	triggerFetchUrl: jest.fn().mockResolvedValue(undefined),
	triggerAnalyzeJob: jest.fn().mockResolvedValue(undefined)
}));

jest.mock("../netlify/functions/lib/auth-middleware", () => ({
	requireHybridAuth: jest.fn((handler) => handler)
}));

jest.mock("../netlify/functions/lib/config", () => ({
	DEFAULT_SCRAPING_SERVICE_URL: "https://scraper.example.com",
	CALLBACK_MAX_RETRIES: 3,
	RENDER_SERVICE_CALL_TIMEOUT_MS: 10000
}));

jest.mock("../netlify/functions/lib/logger", () => ({
	info: jest.fn(),
	warn: jest.fn(),
	error: jest.fn(),
	debug: jest.fn()
}));

const { handler } = require("../netlify/functions/fetch-url");
const { markUrlFetching, saveUrlResult, getJob } = require("../netlify/functions/lib/job-storage");
const { scrapeWithBrowserQL } = require("../netlify/functions/lib/browserql-scraper");
const { retryWithBackoff } = require("../netlify/functions/lib/retry-helpers");

describe("fetch-url handler", () => {
	const mockContext = {};
	const baseHeaders = {
		"x-forwarded-proto": "https",
		host: "example.netlify.app"
	};

	beforeEach(() => {
		jest.clearAllMocks();
		process.env.SCRAPING_API_KEY = "test-key";
		process.env.SCRAPING_SERVICE_URL = "https://scraper.example.com";
	});

	test("returns 405 for non-POST methods", async () => {
		const event = { httpMethod: "GET" };
		const result = await handler(event, mockContext);

		expect(result.statusCode).toBe(405);
	});

	test("handles BrowserQL scraping method", async () => {
		markUrlFetching.mockResolvedValue(undefined);
		scrapeWithBrowserQL.mockResolvedValue({
			content: "Page content here",
			title: "Product Page"
		});
		saveUrlResult.mockResolvedValue(false); // Not all done
		getJob.mockResolvedValue({
			urls: [
				{ index: 0, status: "complete" },
				{ index: 1, status: "pending", url: "https://next.com", title: "Next", snippet: "" }
			]
		});

		const event = {
			httpMethod: "POST",
			headers: baseHeaders,
			body: JSON.stringify({
				jobId: "job-123",
				urlIndex: 0,
				url: "https://example.com",
				title: "Test",
				snippet: "test snippet",
				scrapingMethod: "browserql"
			})
		};
		const result = await handler(event, mockContext);

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.method).toBe("browserql");
		expect(scrapeWithBrowserQL).toHaveBeenCalledWith("https://example.com");
		expect(saveUrlResult).toHaveBeenCalled();
	});

	test("handles BrowserQL with all URLs complete (triggers analysis)", async () => {
		markUrlFetching.mockResolvedValue(undefined);
		scrapeWithBrowserQL.mockResolvedValue({
			content: "Content",
			title: "Title"
		});
		saveUrlResult.mockResolvedValue(true); // All done

		const event = {
			httpMethod: "POST",
			headers: baseHeaders,
			body: JSON.stringify({
				jobId: "job-done",
				urlIndex: 0,
				url: "https://example.com",
				title: "Test",
				snippet: "",
				scrapingMethod: "browserql"
			})
		};
		const result = await handler(event, mockContext);

		expect(result.statusCode).toBe(200);
	});

	test("handles BrowserQL scraping failure with error recovery", async () => {
		markUrlFetching.mockResolvedValue(undefined);
		scrapeWithBrowserQL.mockRejectedValue(new Error("BrowserQL timeout"));
		saveUrlResult.mockResolvedValue(false);
		getJob.mockResolvedValue({
			urls: [{ index: 1, status: "pending", url: "https://next.com", title: "N", snippet: "" }]
		});

		const event = {
			httpMethod: "POST",
			headers: baseHeaders,
			body: JSON.stringify({
				jobId: "job-err",
				urlIndex: 0,
				url: "https://protected.com",
				title: "Test",
				snippet: "",
				scrapingMethod: "browserql"
			})
		};
		const result = await handler(event, mockContext);

		expect(result.statusCode).toBe(500);
		const body = JSON.parse(result.body);
		expect(body.method).toBe("browserql_failed");
	});

	test("handles Render service (default) scraping method", async () => {
		markUrlFetching.mockResolvedValue(undefined);

		// Mock health check
		global.fetch = jest.fn()
			.mockResolvedValueOnce({ ok: true }); // health check

		retryWithBackoff.mockResolvedValue({
			success: true,
			timedOut: false
		});

		const event = {
			httpMethod: "POST",
			headers: baseHeaders,
			body: JSON.stringify({
				jobId: "job-render",
				urlIndex: 0,
				url: "https://example.com/page",
				title: "Page",
				snippet: "description"
			})
		};
		const result = await handler(event, mockContext);

		expect(result.statusCode).toBe(202);
		const body = JSON.parse(result.body);
		expect(body.method).toBe("render_pending");
	});

	test("handles KEYENCE interactive method", async () => {
		markUrlFetching.mockResolvedValue(undefined);
		retryWithBackoff.mockResolvedValue({
			success: true,
			timedOut: false
		});

		const event = {
			httpMethod: "POST",
			headers: baseHeaders,
			body: JSON.stringify({
				jobId: "job-keyence",
				urlIndex: 0,
				url: "https://www.keyence.co.jp/",
				title: "KEYENCE",
				snippet: "",
				scrapingMethod: "keyence_interactive",
				model: "IV-HG500CA"
			})
		};
		const result = await handler(event, mockContext);

		expect(result.statusCode).toBe(202);
	});

	test("returns 500 on unexpected error", async () => {
		markUrlFetching.mockRejectedValue(new Error("Storage error"));

		const event = {
			httpMethod: "POST",
			headers: baseHeaders,
			body: JSON.stringify({
				jobId: "job-bad",
				urlIndex: 0,
				url: "https://test.com",
				title: "Test",
				snippet: "",
				scrapingMethod: "browserql"
			})
		};
		const result = await handler(event, mockContext);

		expect(result.statusCode).toBe(500);
	});
});
