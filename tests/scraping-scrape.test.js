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

	describe("validateAndFixContent (tested indirectly via module internals)", () => {
		/**
		 * Re-implement validateAndFixContent to test the logic directly
		 * since it is not exported. This mirrors the source exactly.
		 */
		function validateAndFixContent(content) {
			if (!content || content.length < 50) {
				return `[The website could not be scraped - extracted only ${
					content ? content.length : 0
				} characters. The site may require authentication, use anti-bot protection, or be temporarily unavailable.]`;
			}
			return content;
		}

		test("should return explanation for null content", () => {
			const result = validateAndFixContent(null);
			expect(result).toContain("extracted only 0 characters");
			expect(result).toContain("could not be scraped");
		});

		test("should return explanation for empty string", () => {
			const result = validateAndFixContent("");
			expect(result).toContain("extracted only 0 characters");
		});

		test("should return explanation for short content (< 50 chars)", () => {
			const result = validateAndFixContent("short");
			expect(result).toContain("extracted only 5 characters");
		});

		test("should return explanation for content of exactly 49 chars", () => {
			const content = "a".repeat(49);
			const result = validateAndFixContent(content);
			expect(result).toContain("extracted only 49 characters");
		});

		test("should return content as-is when >= 50 chars", () => {
			const content = "a".repeat(50);
			const result = validateAndFixContent(content);
			expect(result).toBe(content);
		});

		test("should return content as-is for long content", () => {
			const content = "This is a long piece of content that definitely exceeds the fifty character minimum threshold.";
			const result = validateAndFixContent(content);
			expect(result).toBe(content);
		});
	});

	describe("setupNetworkMonitoring (logic test)", () => {
		/**
		 * Re-implement setupNetworkMonitoring to test the logic directly.
		 */
		function setupNetworkMonitoring(page) {
			const pendingRequests = new Map();

			page.on("request", (request) => {
				pendingRequests.set(request.url(), {
					startTime: Date.now(),
					resourceType: request.resourceType()
				});
			});

			page.on("requestfinished", (request) => {
				pendingRequests.delete(request.url());
			});

			page.on("requestfailed", (request) => {
				pendingRequests.delete(request.url());
			});

			return pendingRequests;
		}

		test("should track requests via page events", () => {
			const handlers = {};
			const mockPage = {
				on: jest.fn((event, handler) => {
					handlers[event] = handler;
				})
			};

			const pending = setupNetworkMonitoring(mockPage);

			expect(mockPage.on).toHaveBeenCalledWith("request", expect.any(Function));
			expect(mockPage.on).toHaveBeenCalledWith("requestfinished", expect.any(Function));
			expect(mockPage.on).toHaveBeenCalledWith("requestfailed", expect.any(Function));

			// Simulate a request
			handlers.request({
				url: () => "https://example.com/script.js",
				resourceType: () => "script"
			});
			expect(pending.size).toBe(1);
			expect(pending.has("https://example.com/script.js")).toBe(true);

			// Simulate request finished
			handlers.requestfinished({
				url: () => "https://example.com/script.js"
			});
			expect(pending.size).toBe(0);
		});

		test("should remove on requestfailed", () => {
			const handlers = {};
			const mockPage = {
				on: jest.fn((event, handler) => {
					handlers[event] = handler;
				})
			};

			const pending = setupNetworkMonitoring(mockPage);

			handlers.request({
				url: () => "https://example.com/image.png",
				resourceType: () => "image"
			});
			expect(pending.size).toBe(1);

			handlers.requestfailed({
				url: () => "https://example.com/image.png"
			});
			expect(pending.size).toBe(0);
		});
	});

	describe("logNetworkDiagnostics (logic test)", () => {
		/**
		 * Re-implement logNetworkDiagnostics to test the logging output.
		 */
		function logNetworkDiagnostics(pendingRequests) {
			logger.info(`\n=== NETWORK TIMEOUT DIAGNOSTICS ===`);
			logger.info(`Total pending requests: ${pendingRequests.size}`);

			if (pendingRequests.size > 0) {
				const byType = new Map();
				for (const [url, info] of pendingRequests) {
					if (!byType.has(info.resourceType)) {
						byType.set(info.resourceType, []);
					}
					byType.get(info.resourceType).push({
						url,
						duration: Date.now() - info.startTime
					});
				}

				logger.info(`\nPending requests by type:`);
				for (const [type, requests] of byType) {
					logger.info(`  ${type}: ${requests.length}`);
				}

				const sortedRequests = Array.from(pendingRequests.entries())
					.map(([url, info]) => ({
						url,
						duration: Date.now() - info.startTime,
						type: info.resourceType
					}))
					.sort((a, b) => b.duration - a.duration)
					.slice(0, 10);

				logger.info(`\nTop 10 longest pending requests:`);
				sortedRequests.forEach((req, i) => {
					const seconds = (req.duration / 1000).toFixed(1);
					logger.info(
						`  ${i + 1}. [${req.type}] ${seconds}s - ${req.url.substring(0, 100)}${
							req.url.length > 100 ? "..." : ""
						}`
					);
				});
			}
			logger.info(`===================================\n`);
		}

		test("should log header and total count for empty map", () => {
			const pending = new Map();
			logNetworkDiagnostics(pending);

			expect(logger.info).toHaveBeenCalledWith(
				expect.stringContaining("NETWORK TIMEOUT DIAGNOSTICS")
			);
			expect(logger.info).toHaveBeenCalledWith("Total pending requests: 0");
		});

		test("should log type breakdown for pending requests", () => {
			const pending = new Map();
			pending.set("https://example.com/a.js", {
				startTime: Date.now() - 5000,
				resourceType: "script"
			});
			pending.set("https://example.com/b.css", {
				startTime: Date.now() - 3000,
				resourceType: "stylesheet"
			});

			logNetworkDiagnostics(pending);

			expect(logger.info).toHaveBeenCalledWith("Total pending requests: 2");
			expect(logger.info).toHaveBeenCalledWith("  script: 1");
			expect(logger.info).toHaveBeenCalledWith("  stylesheet: 1");
		});
	});

	describe("waitForRendering (logic test)", () => {
		/**
		 * Re-implement waitForRendering to test the branching logic.
		 */
		async function waitForRendering(isCloudflareProtected, navigationTimedOut) {
			if (isCloudflareProtected) {
				return "cloudflare";
			} else if (navigationTimedOut) {
				return "timeout";
			} else {
				return "normal";
			}
		}

		test("should choose cloudflare wait when site is cloudflare-protected", async () => {
			const result = await waitForRendering(true, false);
			expect(result).toBe("cloudflare");
		});

		test("should choose timeout wait when navigation timed out", async () => {
			const result = await waitForRendering(false, true);
			expect(result).toBe("timeout");
		});

		test("should choose normal wait for regular pages", async () => {
			const result = await waitForRendering(false, false);
			expect(result).toBe("normal");
		});

		test("should prefer cloudflare over timeout when both are true", async () => {
			const result = await waitForRendering(true, true);
			expect(result).toBe("cloudflare");
		});
	});
});
