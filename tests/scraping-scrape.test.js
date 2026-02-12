/**
 * Tests for scraping-service/routes/scrape.js
 * Heavy dependencies (puppeteer, extraction, callback) are mocked.
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
	setupResourceBlocking: jest.fn(),
	extractPageContent: jest.fn()
}));

jest.mock("../scraping-service/utils/memory", () => ({
	getMemoryUsageMB: jest.fn(() => ({ rss: 100, heapUsed: 60, heapTotal: 120, external: 5 })),
	trackMemoryUsage: jest.fn(() => ({ rss: 100, heapUsed: 60, heapTotal: 120, external: 5 })),
	shouldRestartDueToMemory: jest.fn(() => false),
	scheduleRestartIfNeeded: jest.fn(),
	getShutdownState: jest.fn(() => false),
	incrementRequestCount: jest.fn(() => 1),
	getRequestCount: jest.fn(() => 1),
	forceGarbageCollection: jest.fn()
}));

jest.mock("../scraping-service/utils/validation", () => ({
	isSafePublicUrl: jest.fn((url) => {
		if (!url || url.includes("localhost") || url.includes("127.0.0.1") || url.includes("169.254.")) {
			return { valid: false, reason: "Blocked by SSRF protection" };
		}
		return { valid: true };
	}),
	isValidCallbackUrl: jest.fn((url) => {
		if (!url) return { valid: true };
		if (url.includes("evil.com")) {
			return { valid: false, reason: "Callback URL domain not in allowed list" };
		}
		return { valid: true };
	})
}));

jest.mock("../scraping-service/utils/extraction", () => ({
	tryFastFetch: jest.fn(),
	isPDFUrl: jest.fn(() => false),
	isTextFileUrl: jest.fn(() => false)
}));

jest.mock("../scraping-service/utils/callback", () => ({
	sendCallback: jest.fn(() => Promise.resolve())
}));

const { handleScrapeRequest, enqueuePuppeteerTask } = require("../scraping-service/routes/scrape");
const {
	getShutdownState,
	shouldRestartDueToMemory,
	incrementRequestCount,
	trackMemoryUsage
} = require("../scraping-service/utils/memory");
const { isSafePublicUrl, isValidCallbackUrl } = require("../scraping-service/utils/validation");
const { isPDFUrl, isTextFileUrl, tryFastFetch } = require("../scraping-service/utils/extraction");
const { sendCallback } = require("../scraping-service/utils/callback");
const logger = require("../scraping-service/utils/logger");

beforeEach(() => {
	jest.clearAllMocks();
	getShutdownState.mockReturnValue(false);
	shouldRestartDueToMemory.mockReturnValue(false);
	incrementRequestCount.mockReturnValue(1);
	trackMemoryUsage.mockReturnValue({ rss: 100, heapUsed: 60, heapTotal: 120, external: 5 });
	isSafePublicUrl.mockImplementation((url) => {
		if (!url || url.includes("localhost") || url.includes("127.0.0.1") || url.includes("169.254.")) {
			return { valid: false, reason: "Blocked by SSRF protection" };
		}
		return { valid: true };
	});
	isValidCallbackUrl.mockImplementation((url) => {
		if (!url) return { valid: true };
		if (url.includes("evil.com")) {
			return { valid: false, reason: "Callback URL domain not in allowed list" };
		}
		return { valid: true };
	});
	isPDFUrl.mockReturnValue(false);
	isTextFileUrl.mockReturnValue(false);
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

describe("Scraping Scrape Route", () => {
	describe("enqueuePuppeteerTask", () => {
		test("should execute a task and return its result", async () => {
			const result = await enqueuePuppeteerTask(async () => "task-result");
			expect(result).toBe("task-result");
		});

		test("should execute tasks sequentially", async () => {
			const order = [];

			const task1 = enqueuePuppeteerTask(async () => {
				order.push("task1-start");
				await new Promise((resolve) => setTimeout(resolve, 50));
				order.push("task1-end");
				return "result1";
			});

			const task2 = enqueuePuppeteerTask(async () => {
				order.push("task2-start");
				return "result2";
			});

			const [r1, r2] = await Promise.all([task1, task2]);

			expect(r1).toBe("result1");
			expect(r2).toBe("result2");
			expect(order).toEqual(["task1-start", "task1-end", "task2-start"]);
		});

		test("should continue queue after a task fails", async () => {
			const failTask = enqueuePuppeteerTask(async () => {
				throw new Error("task failed");
			});

			await expect(failTask).rejects.toThrow("task failed");

			const successResult = await enqueuePuppeteerTask(async () => "recovered");
			expect(successResult).toBe("recovered");
		});

		test("should propagate task errors to caller", async () => {
			await expect(
				enqueuePuppeteerTask(async () => {
					throw new Error("specific error");
				})
			).rejects.toThrow("specific error");
		});
	});

	describe("handleScrapeRequest - input validation", () => {
		test("should return 400 when url is missing", async () => {
			const req = createMockReq({
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await handleScrapeRequest(req, res);

			expect(res.status).toHaveBeenCalledWith(400);
			expect(res.body).toEqual({ error: "URL is required" });
		});

		test("should return 400 when callbackUrl is missing", async () => {
			const req = createMockReq({
				url: "https://example.com",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await handleScrapeRequest(req, res);

			expect(res.status).toHaveBeenCalledWith(400);
			expect(res.body).toEqual({ error: "callbackUrl is required" });
		});

		test("should return 400 when jobId is missing", async () => {
			const req = createMockReq({
				url: "https://example.com",
				callbackUrl: "https://example.com/callback",
				urlIndex: 0
			});
			const res = createMockRes();

			await handleScrapeRequest(req, res);

			expect(res.status).toHaveBeenCalledWith(400);
			expect(res.body).toEqual({ error: "jobId is required" });
		});

		test("should return 400 when urlIndex is missing (undefined)", async () => {
			const req = createMockReq({
				url: "https://example.com",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1"
			});
			const res = createMockRes();

			await handleScrapeRequest(req, res);

			expect(res.status).toHaveBeenCalledWith(400);
			expect(res.body).toEqual({ error: "urlIndex is required" });
		});

		test("should return 400 when urlIndex is null", async () => {
			const req = createMockReq({
				url: "https://example.com",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: null
			});
			const res = createMockRes();

			await handleScrapeRequest(req, res);

			expect(res.status).toHaveBeenCalledWith(400);
			expect(res.body).toEqual({ error: "urlIndex is required" });
		});

		test("should accept urlIndex of 0 (falsy but valid)", async () => {
			const req = createMockReq({
				url: "https://example.com",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await handleScrapeRequest(req, res);

			// Should not return 400 for urlIndex
			if (res.statusCode === 400) {
				expect(res.body.error).not.toBe("urlIndex is required");
			}
		});
	});

	describe("handleScrapeRequest - SSRF protection", () => {
		test("should reject unsafe scrape URL", async () => {
			const req = createMockReq({
				url: "http://localhost:8080/admin",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await handleScrapeRequest(req, res);

			expect(res.status).toHaveBeenCalledWith(400);
			expect(res.body.error).toBe("Invalid or unsafe URL");
			expect(res.body.reason).toBeDefined();
		});

		test("should reject unsafe callback URL", async () => {
			const req = createMockReq({
				url: "https://example.com",
				callbackUrl: "https://evil.com/steal",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await handleScrapeRequest(req, res);

			expect(res.status).toHaveBeenCalledWith(400);
			expect(res.body.error).toBe("Invalid or unsafe callback URL");
			expect(res.body.reason).toBeDefined();
		});

		test("should reject private IP in scrape URL", async () => {
			isSafePublicUrl.mockReturnValue({ valid: false, reason: "Cannot scrape private IP addresses" });
			const req = createMockReq({
				url: "http://169.254.169.254/latest/meta-data",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await handleScrapeRequest(req, res);

			expect(res.status).toHaveBeenCalledWith(400);
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining("SSRF protection blocked URL")
			);
		});
	});

	describe("handleScrapeRequest - shutdown state", () => {
		test("should return 503 when shutting down", async () => {
			getShutdownState.mockReturnValue(true);

			const req = createMockReq({
				url: "https://example.com",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await handleScrapeRequest(req, res);

			expect(res.status).toHaveBeenCalledWith(503);
			expect(res.body.error).toContain("Service restarting");
			expect(res.body.retryAfter).toBe(30);
		});
	});

	describe("handleScrapeRequest - memory check", () => {
		test("should return 503 when memory is too high", async () => {
			shouldRestartDueToMemory.mockReturnValue(true);

			const req = createMockReq({
				url: "https://example.com",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await handleScrapeRequest(req, res);

			expect(res.status).toHaveBeenCalledWith(503);
			expect(res.body.error).toContain("high memory");
			expect(sendCallback).toHaveBeenCalledWith(
				"https://example.com/callback",
				expect.objectContaining({
					jobId: "job-1",
					urlIndex: 0
				})
			);
		});
	});

	describe("handleScrapeRequest - routing to fast-fetch vs Puppeteer", () => {
		test("should use fast-fetch for PDF URLs", async () => {
			isPDFUrl.mockReturnValue(true);
			tryFastFetch.mockResolvedValue("PDF content that is long enough to pass validation check easily");

			const req = createMockReq({
				url: "https://example.com/doc.pdf",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await handleScrapeRequest(req, res);

			expect(tryFastFetch).toHaveBeenCalledWith("https://example.com/doc.pdf");
			expect(sendCallback).toHaveBeenCalled();
		});

		test("should use fast-fetch for text file URLs", async () => {
			isTextFileUrl.mockReturnValue(true);
			tryFastFetch.mockResolvedValue("Text content that is long enough to pass validation check easily");

			const req = createMockReq({
				url: "https://example.com/readme.txt",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await handleScrapeRequest(req, res);

			expect(tryFastFetch).toHaveBeenCalledWith("https://example.com/readme.txt");
		});

		test("should respond 202 for HTML pages (Puppeteer path)", async () => {
			isPDFUrl.mockReturnValue(false);
			isTextFileUrl.mockReturnValue(false);

			const req = createMockReq({
				url: "https://example.com/page",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await handleScrapeRequest(req, res);

			expect(res.status).toHaveBeenCalledWith(202);
			expect(res.body).toEqual({
				success: true,
				status: "processing",
				message: "Scraping started, results will be sent via callback"
			});
		});

		test("should handle fast-fetch returning null (PDF fetch failed)", async () => {
			isPDFUrl.mockReturnValue(true);
			tryFastFetch.mockResolvedValue(null);

			const req = createMockReq({
				url: "https://example.com/doc.pdf",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await handleScrapeRequest(req, res);

			expect(res.status).toHaveBeenCalledWith(500);
			expect(sendCallback).toHaveBeenCalledWith(
				"https://example.com/callback",
				expect.objectContaining({
					content: "[PDF or text file could not be fetched]"
				})
			);
		});
	});

});
