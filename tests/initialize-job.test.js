/**
 * Tests for netlify/functions/initialize-job.js
 * Tests pure/helper functions directly and the handler via mocking
 */

jest.mock("../netlify/functions/lib/job-storage", () => ({
	createJob: jest.fn(),
	saveJobUrls: jest.fn(),
	saveFinalResult: jest.fn(),
	saveUrlResult: jest.fn()
}));

jest.mock("../netlify/functions/lib/validators", () => ({
	validateInitializeJob: jest.fn(),
	sanitizeString: jest.fn((str) => str)
}));

jest.mock("../netlify/functions/lib/browserql-scraper", () => ({
	scrapeWithBrowserQL: jest.fn()
}));

jest.mock("serpapi", () => ({
	getJson: jest.fn()
}));

jest.mock("pdf-parse", () => jest.fn());

jest.mock("../scraping-service/utils/pdfjs-loader", () => ({
	loadPdfjs: jest.fn()
}));

jest.mock("../netlify/functions/lib/logger", () => ({
	info: jest.fn(),
	warn: jest.fn(),
	error: jest.fn(),
	debug: jest.fn()
}));

jest.mock("../netlify/functions/lib/config", () => ({
	SERPAPI_ENGINE: "google",
	SERPAPI_GOOGLE_DOMAIN: "google.co.jp",
	SERPAPI_SITES_TO_SEARCH: ["site1.com", "site2.com"],
	PDF_SCREENING_TIMEOUT_MS: 5000,
	PDF_SCREENING_MAX_SIZE_MB: 10,
	PDF_SCREENING_MAX_PAGES: 5,
	PDF_SCREENING_MIN_CHARS: 100
}));

jest.mock("../netlify/functions/lib/response-builder", () => ({
	getCorsOrigin: jest.fn(() => "*"),
	errorResponse: jest.fn((msg, details, code) => ({
		statusCode: code || 500,
		headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
		body: JSON.stringify({ error: msg, details })
	})),
	validationErrorResponse: jest.fn((errors) => ({
		statusCode: 400,
		headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
		body: JSON.stringify({ error: "Validation failed", errors })
	}))
}));

jest.mock("../netlify/functions/lib/auth-middleware", () => ({
	requireHybridAuth: jest.fn((handler) => handler)
}));

const { handler } = require("../netlify/functions/initialize-job");
const { createJob, saveJobUrls, saveFinalResult } = require("../netlify/functions/lib/job-storage");
const { validateInitializeJob } = require("../netlify/functions/lib/validators");
const { scrapeWithBrowserQL } = require("../netlify/functions/lib/browserql-scraper");
const { getJson } = require("serpapi");

describe("initialize-job handler", () => {
	const mockContext = {};

	beforeEach(() => {
		jest.clearAllMocks();
		process.env.SERPAPI_API_KEY = "test-key";
	});

	test("returns 204 for OPTIONS preflight", async () => {
		const event = { httpMethod: "OPTIONS" };
		const result = await handler(event, mockContext);

		expect(result.statusCode).toBe(204);
		expect(result.headers["Access-Control-Allow-Methods"]).toBe("POST, OPTIONS");
	});

	test("returns 405 for non-POST methods", async () => {
		const event = { httpMethod: "GET" };
		const result = await handler(event, mockContext);

		expect(result.statusCode).toBe(405);
	});

	test("returns validation error for invalid input", async () => {
		validateInitializeJob.mockReturnValue({
			valid: false,
			errors: ["maker is required", "model is required"]
		});

		const event = {
			httpMethod: "POST",
			body: JSON.stringify({})
		};
		const result = await handler(event, mockContext);

		expect(result.statusCode).toBe(400);
		const body = JSON.parse(result.body);
		expect(body.errors).toContain("maker is required");
	});

	test("uses direct URL strategy for SMC manufacturer", async () => {
		validateInitializeJob.mockReturnValue({ valid: true });
		createJob.mockResolvedValue("job-123");
		saveJobUrls.mockResolvedValue(undefined);

		const event = {
			httpMethod: "POST",
			body: JSON.stringify({ maker: "SMC", model: "SY3120" })
		};
		const result = await handler(event, mockContext);

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.jobId).toBe("job-123");
		expect(body.strategy).toBe("direct_url");
		expect(saveJobUrls).toHaveBeenCalled();
	});

	test("uses direct URL strategy for MISUMI manufacturer", async () => {
		validateInitializeJob.mockReturnValue({ valid: true });
		createJob.mockResolvedValue("job-456");
		saveJobUrls.mockResolvedValue(undefined);

		const event = {
			httpMethod: "POST",
			body: JSON.stringify({ maker: "MISUMI", model: "HFSB5-2020" })
		};
		const result = await handler(event, mockContext);

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.strategy).toBe("direct_url");
	});

	test("uses BrowserQL strategy for ORIENTAL MOTOR", async () => {
		validateInitializeJob.mockReturnValue({ valid: true });
		createJob.mockResolvedValue("job-789");
		saveJobUrls.mockResolvedValue(undefined);

		const event = {
			httpMethod: "POST",
			body: JSON.stringify({ maker: "ORIENTAL MOTOR", model: "BLM230" })
		};
		const result = await handler(event, mockContext);

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.strategy).toBe("direct_url");
		expect(body.scrapingMethod).toBe("browserql");
	});

	test("falls back to SerpAPI for unknown manufacturer", async () => {
		validateInitializeJob.mockReturnValue({ valid: true });
		createJob.mockResolvedValue("job-fallback");
		saveJobUrls.mockResolvedValue(undefined);

		getJson.mockImplementation((params, callback) => {
			callback({
				organic_results: [
					{ link: "https://example.com/product1", title: "Product 1", snippet: "Desc 1" },
					{ link: "https://example.com/product2", title: "Product 2", snippet: "Desc 2" }
				]
			});
		});

		const event = {
			httpMethod: "POST",
			body: JSON.stringify({ maker: "UnknownCorp", model: "ABC-123" })
		};
		const result = await handler(event, mockContext);

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.jobId).toBe("job-fallback");
		expect(body.urlCount).toBe(2);
	});

	test("handles no search results from SerpAPI", async () => {
		validateInitializeJob.mockReturnValue({ valid: true });
		createJob.mockResolvedValue("job-noresults");
		saveFinalResult.mockResolvedValue(undefined);

		getJson.mockImplementation((params, callback) => {
			callback({ organic_results: [] });
		});

		const event = {
			httpMethod: "POST",
			body: JSON.stringify({ maker: "Unknown", model: "XYZ-999" })
		};
		const result = await handler(event, mockContext);

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.status).toBe("complete");
		expect(body.message).toContain("No search results");
		expect(saveFinalResult).toHaveBeenCalledWith(
			"job-noresults",
			expect.objectContaining({ status: "UNKNOWN" }),
			mockContext
		);
	});

	test("handles SerpAPI error", async () => {
		validateInitializeJob.mockReturnValue({ valid: true });
		createJob.mockResolvedValue("job-err");

		getJson.mockImplementation((params, callback) => {
			callback({ error: "API key invalid" });
		});

		const event = {
			httpMethod: "POST",
			body: JSON.stringify({ maker: "SomeMaker", model: "SomeModel" })
		};
		const result = await handler(event, mockContext);

		expect(result.statusCode).toBe(500);
	});

	test("handles NTN with BrowserQL validation (no results fallback)", async () => {
		validateInitializeJob.mockReturnValue({ valid: true });
		createJob.mockResolvedValue("job-ntn");

		scrapeWithBrowserQL.mockResolvedValue({
			content: "no results for: some-model"
		});

		// Fall back to SerpAPI
		getJson.mockImplementation((params, callback) => {
			callback({ organic_results: [] });
		});
		saveFinalResult.mockResolvedValue(undefined);

		const event = {
			httpMethod: "POST",
			body: JSON.stringify({ maker: "NTN", model: "6200Z" })
		};
		const result = await handler(event, mockContext);

		expect(result.statusCode).toBe(200);
		// NTN should have attempted BrowserQL, found "no results", and fallen back
		expect(scrapeWithBrowserQL).toHaveBeenCalled();
	});

	test("returns 500 on unexpected error", async () => {
		validateInitializeJob.mockReturnValue({ valid: true });
		createJob.mockRejectedValue(new Error("Storage failure"));

		const event = {
			httpMethod: "POST",
			body: JSON.stringify({ maker: "Test", model: "Test" })
		};
		const result = await handler(event, mockContext);

		expect(result.statusCode).toBe(500);
	});
});
