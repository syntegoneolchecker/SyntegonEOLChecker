/**
 * Tests for scraping-service/routes/scrape-keyence.js
 * Heavy dependencies (puppeteer, callback, scrape queue) are mocked.
 */

jest.mock("../scraping-service/utils/logger", () => ({
	info: jest.fn(),
	warn: jest.fn(),
	error: jest.fn(),
	debug: jest.fn()
}));

jest.mock("../scraping-service/config/puppeteer", () => ({
	launchBrowser: jest.fn(),
	configureStandardPage: jest.fn(),
	setupResourceBlocking: jest.fn()
}));

jest.mock("../scraping-service/utils/memory", () => ({
	getMemoryUsageMB: jest.fn(() => ({ rss: 100, heapUsed: 60, heapTotal: 120, external: 5 })),
	trackMemoryUsage: jest.fn(() => ({ rss: 100, heapUsed: 60, heapTotal: 120, external: 5 })),
	scheduleRestartIfNeeded: jest.fn(),
	getShutdownState: jest.fn(() => false),
	incrementRequestCount: jest.fn(() => 1),
	forceGarbageCollection: jest.fn(),
	setShutdownState: jest.fn()
}));

jest.mock("../scraping-service/utils/validation", () => ({
	isValidCallbackUrl: jest.fn((url) => {
		if (!url) return { valid: true };
		if (url.includes("evil.com") || url.includes("169.254.")) {
			return { valid: false, reason: "Callback URL domain not in allowed list" };
		}
		return { valid: true };
	})
}));

jest.mock("../scraping-service/utils/callback", () => ({
	sendCallback: jest.fn(() => Promise.resolve())
}));

jest.mock("../scraping-service/routes/scrape", () => ({
	enqueuePuppeteerTask: jest.fn((task) => {
		// Execute the task immediately for testing (fire-and-forget in real code)
		return task();
	})
}));

const { handleKeyenceScrapeRequest } = require("../scraping-service/routes/scrape-keyence");
const {
	getShutdownState,
	incrementRequestCount,
	trackMemoryUsage
} = require("../scraping-service/utils/memory");
const { isValidCallbackUrl } = require("../scraping-service/utils/validation");
const { enqueuePuppeteerTask } = require("../scraping-service/routes/scrape");
const { launchBrowser } = require("../scraping-service/config/puppeteer");
const logger = require("../scraping-service/utils/logger");

beforeEach(() => {
	jest.clearAllMocks();
	getShutdownState.mockReturnValue(false);
	incrementRequestCount.mockReturnValue(1);
	trackMemoryUsage.mockReturnValue({ rss: 100, heapUsed: 60, heapTotal: 120, external: 5 });
	isValidCallbackUrl.mockImplementation((url) => {
		if (!url) return { valid: true };
		if (url.includes("evil.com") || url.includes("169.254.")) {
			return { valid: false, reason: "Callback URL domain not in allowed list" };
		}
		return { valid: true };
	});
	// Default: enqueuePuppeteerTask runs the task but we don't need the browser logic
	// since we are testing request handling, not browser interaction
	enqueuePuppeteerTask.mockImplementation(() => Promise.resolve());
	launchBrowser.mockResolvedValue({
		newPage: jest.fn().mockResolvedValue({
			goto: jest.fn(),
			evaluate: jest.fn(),
			click: jest.fn(),
			waitForNavigation: jest.fn(),
			on: jest.fn(),
			keyboard: { press: jest.fn() }
		}),
		close: jest.fn()
	});
});

function createMockRes() {
	const res = {
		statusCode: null,
		body: null,
		status: jest.fn(function (code) {
			res.statusCode = code;
			return res;
		}),
		json: jest.fn(function (data) {
			res.body = data;
			return res;
		})
	};
	return res;
}

function createMockReq(body) {
	return { body: body || {} };
}

describe("Scraping Scrape Keyence Route", () => {
	describe("handleKeyenceScrapeRequest - input validation", () => {
		test("should return 400 when model is missing", async () => {
			const req = createMockReq({
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await handleKeyenceScrapeRequest(req, res);

			expect(res.status).toHaveBeenCalledWith(400);
			expect(res.body).toEqual({ error: "Model is required" });
		});

		test("should return 400 when model is empty string", async () => {
			const req = createMockReq({
				model: "",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await handleKeyenceScrapeRequest(req, res);

			expect(res.status).toHaveBeenCalledWith(400);
			expect(res.body).toEqual({ error: "Model is required" });
		});
	});

	describe("handleKeyenceScrapeRequest - shutdown rejection", () => {
		test("should return 503 when shutting down", async () => {
			getShutdownState.mockReturnValue(true);

			const req = createMockReq({
				model: "LR-ZB250CP",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await handleKeyenceScrapeRequest(req, res);

			expect(res.status).toHaveBeenCalledWith(503);
			expect(res.body.error).toContain("Service restarting");
			expect(res.body.retryAfter).toBe(30);
		});

		test("should log shutdown rejection with memory info", async () => {
			getShutdownState.mockReturnValue(true);

			const req = createMockReq({
				model: "LR-ZB250CP",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await handleKeyenceScrapeRequest(req, res);

			expect(logger.info).toHaveBeenCalledWith(
				expect.stringContaining("Rejecting /scrape-keyence request during shutdown")
			);
		});
	});

	describe("handleKeyenceScrapeRequest - callback URL validation (SSRF)", () => {
		test("should reject unsafe callback URL", async () => {
			const req = createMockReq({
				model: "LR-ZB250CP",
				callbackUrl: "https://evil.com/steal",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await handleKeyenceScrapeRequest(req, res);

			expect(res.status).toHaveBeenCalledWith(400);
			expect(res.body.error).toBe("Invalid or unsafe callback URL");
			expect(res.body.reason).toBeDefined();
		});

		test("should reject link-local callback URL", async () => {
			const req = createMockReq({
				model: "LR-ZB250CP",
				callbackUrl: "http://169.254.169.254/latest/meta-data",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await handleKeyenceScrapeRequest(req, res);

			expect(res.status).toHaveBeenCalledWith(400);
			expect(res.body.error).toBe("Invalid or unsafe callback URL");
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining("SSRF protection blocked callback URL")
			);
		});

		test("should accept valid callback URL", async () => {
			const req = createMockReq({
				model: "LR-ZB250CP",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await handleKeyenceScrapeRequest(req, res);

			// Should not be rejected with 400 for callback
			expect(res.statusCode).not.toBe(400);
		});
	});

	describe("handleKeyenceScrapeRequest - 202 Accepted response", () => {
		test("should respond with 202 for valid request", async () => {
			const req = createMockReq({
				model: "LR-ZB250CP",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await handleKeyenceScrapeRequest(req, res);

			expect(res.status).toHaveBeenCalledWith(202);
			expect(res.body).toEqual({
				success: true,
				status: "processing",
				message: "KEYENCE search started, results will be sent via callback"
			});
		});

		test("should increment request count", async () => {
			const req = createMockReq({
				model: "LR-ZB250CP",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await handleKeyenceScrapeRequest(req, res);

			expect(incrementRequestCount).toHaveBeenCalled();
		});

		test("should track memory usage at request start", async () => {
			const req = createMockReq({
				model: "LR-ZB250CP",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await handleKeyenceScrapeRequest(req, res);

			expect(trackMemoryUsage).toHaveBeenCalledWith(
				expect.stringContaining("keyence_start_")
			);
		});

		test("should enqueue a Puppeteer task after responding", async () => {
			const req = createMockReq({
				model: "LR-ZB250CP",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await handleKeyenceScrapeRequest(req, res);

			expect(enqueuePuppeteerTask).toHaveBeenCalledWith(expect.any(Function));
		});
	});

	describe("handleKeyenceScrapeRequest - model validation order", () => {
		test("should check shutdown before model validation", async () => {
			getShutdownState.mockReturnValue(true);

			const req = createMockReq({
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await handleKeyenceScrapeRequest(req, res);

			// Shutdown check comes first in the code, so we get 503 not 400
			expect(res.status).toHaveBeenCalledWith(503);
		});

		test("should check model before callback URL validation", async () => {
			const req = createMockReq({
				callbackUrl: "https://evil.com/steal",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await handleKeyenceScrapeRequest(req, res);

			// Model check comes before callback validation
			expect(res.status).toHaveBeenCalledWith(400);
			expect(res.body.error).toBe("Model is required");
		});
	});

	describe("handleKeyenceScrapeRequest - logging", () => {
		test("should log the model being searched", async () => {
			const req = createMockReq({
				model: "IV2-G500CA",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await handleKeyenceScrapeRequest(req, res);

			expect(logger.info).toHaveBeenCalledWith(
				expect.stringContaining("Searching for model: IV2-G500CA")
			);
		});

		test("should log callback URL when provided", async () => {
			const req = createMockReq({
				model: "IV2-G500CA",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await handleKeyenceScrapeRequest(req, res);

			expect(logger.info).toHaveBeenCalledWith(
				expect.stringContaining("Callback URL provided")
			);
		});

		test("should log memory at request start", async () => {
			const req = createMockReq({
				model: "IV2-G500CA",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await handleKeyenceScrapeRequest(req, res);

			expect(logger.info).toHaveBeenCalledWith(
				expect.stringContaining("KEYENCE Search Request #1")
			);
			expect(logger.info).toHaveBeenCalledWith(
				expect.stringContaining("Memory: 100MB RSS")
			);
		});
	});
});
