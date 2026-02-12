/**
 * Tests for scraping-service/routes/scrape.js — Phase 3A
 * Focused on browser interaction (Puppeteer scraping), fast-fetch paths,
 * and the enqueuePuppeteerTask queue mechanism.
 *
 * All heavy dependencies (puppeteer, extraction, callback, memory) are mocked.
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
	isSafePublicUrl: jest.fn(() => ({ valid: true })),
	isValidCallbackUrl: jest.fn(() => ({ valid: true }))
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
	launchBrowser,
	configureStandardPage,
	setupResourceBlocking,
	extractPageContent
} = require("../scraping-service/config/puppeteer");
const {
	getMemoryUsageMB,
	trackMemoryUsage,
	shouldRestartDueToMemory,
	scheduleRestartIfNeeded,
	getShutdownState,
	incrementRequestCount,
	getRequestCount,
	forceGarbageCollection
} = require("../scraping-service/utils/memory");
const { isSafePublicUrl, isValidCallbackUrl } = require("../scraping-service/utils/validation");
const { isPDFUrl, isTextFileUrl, tryFastFetch } = require("../scraping-service/utils/extraction");
const { sendCallback } = require("../scraping-service/utils/callback");
const logger = require("../scraping-service/utils/logger");

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockPage() {
	return {
		goto: jest.fn().mockResolvedValue(undefined),
		evaluate: jest.fn(),
		on: jest.fn(),
		title: jest.fn().mockResolvedValue("Test Page"),
		close: jest.fn(),
		setUserAgent: jest.fn(),
		setViewport: jest.fn(),
		setRequestInterception: jest.fn()
	};
}

function createMockBrowser(mockPage) {
	return {
		newPage: jest.fn().mockResolvedValue(mockPage || createMockPage()),
		close: jest.fn().mockResolvedValue(undefined)
	};
}

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

function validReqBody(overrides) {
	return {
		url: "https://example.com/page",
		callbackUrl: "https://example.com/callback",
		jobId: "job-1",
		urlIndex: 0,
		snippet: "test snippet",
		...overrides
	};
}

/**
 * Set up the standard Puppeteer mocks so that handleScrapeRequest follows the
 * full Puppeteer path (HTML URL, browser launch, navigate, extract, callback).
 * Returns { mockPage, mockBrowser } for further assertions.
 */
function setupPuppeteerMocks(opts = {}) {
	const {
		content = "This is a long enough page content that exceeds the fifty character validation threshold for sure.",
		title = "Test Page Title",
		navigationError = null,
		extractionError = null,
		browserCloseError = null
	} = opts;

	const mockPage = createMockPage();
	const mockBrowser = createMockBrowser(mockPage);

	launchBrowser.mockResolvedValue(mockBrowser);
	configureStandardPage.mockResolvedValue(undefined);
	setupResourceBlocking.mockResolvedValue(undefined);

	if (navigationError) {
		mockPage.goto.mockRejectedValue(navigationError);
	}

	if (extractionError) {
		extractPageContent.mockRejectedValue(extractionError);
	} else {
		extractPageContent.mockResolvedValue({ content, title });
	}

	if (browserCloseError) {
		mockBrowser.close.mockRejectedValue(browserCloseError);
	}

	isSafePublicUrl.mockReturnValue({ valid: true });
	isPDFUrl.mockReturnValue(false);
	isTextFileUrl.mockReturnValue(false);

	return { mockPage, mockBrowser };
}

/**
 * Fire handleScrapeRequest for an HTML URL and wait until the background
 * Puppeteer scraping promise settles.
 *
 * handleScrapeRequest responds with 202 immediately, then fires
 * handlePuppeteerScraping as fire-and-forget.  handlePuppeteerScraping
 * uses setTimeout for waitForRendering (3s for normal, 1s for timeout, 20s
 * for Cloudflare).  We use fake timers and advance them so the background
 * work completes synchronously within the test.
 */
async function runScrapeWithFakeTimers(req, res) {
	jest.useFakeTimers();

	// Kick off the request — this returns after the 202 response
	const handlePromise = handleScrapeRequest(req, res);

	// Flush the microtask queue so the background promise starts executing
	await handlePromise;

	// Advance all pending timers (covers 3s, 1s, 20s waits)
	await jest.runAllTimersAsync();

	jest.useRealTimers();
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
	jest.clearAllMocks();
	jest.useRealTimers();

	// Sensible defaults — individual tests override as needed
	getShutdownState.mockReturnValue(false);
	shouldRestartDueToMemory.mockReturnValue(false);
	incrementRequestCount.mockReturnValue(1);
	getRequestCount.mockReturnValue(1);
	trackMemoryUsage.mockReturnValue({ rss: 100, heapUsed: 60, heapTotal: 120, external: 5 });
	getMemoryUsageMB.mockReturnValue({ rss: 100, heapUsed: 60, heapTotal: 120, external: 5 });
	isSafePublicUrl.mockReturnValue({ valid: true });
	isValidCallbackUrl.mockReturnValue({ valid: true });
	isPDFUrl.mockReturnValue(false);
	isTextFileUrl.mockReturnValue(false);
	sendCallback.mockResolvedValue(undefined);
});

afterEach(() => {
	jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("scrape.js — Phase 3A Puppeteer interaction tests", () => {
	// -----------------------------------------------------------------------
	// handleScrapeRequest — input validation & guards
	// -----------------------------------------------------------------------
	describe("handleScrapeRequest — input validation", () => {
		test("returns 503 when shutting down", async () => {
			getShutdownState.mockReturnValue(true);
			const res = createMockRes();
			await handleScrapeRequest(createMockReq(validReqBody()), res);

			expect(res.status).toHaveBeenCalledWith(503);
			expect(res.body.error).toContain("Service restarting");
			expect(res.body.retryAfter).toBe(30);
		});

		test("returns 400 when url missing", async () => {
			const res = createMockRes();
			await handleScrapeRequest(
				createMockReq(validReqBody({ url: undefined })),
				res
			);
			expect(res.status).toHaveBeenCalledWith(400);
			expect(res.body).toEqual({ error: "URL is required" });
		});

		test("returns 400 when callbackUrl missing", async () => {
			const res = createMockRes();
			await handleScrapeRequest(
				createMockReq(validReqBody({ callbackUrl: undefined })),
				res
			);
			expect(res.status).toHaveBeenCalledWith(400);
			expect(res.body).toEqual({ error: "callbackUrl is required" });
		});

		test("returns 400 when jobId missing", async () => {
			const res = createMockRes();
			await handleScrapeRequest(
				createMockReq(validReqBody({ jobId: undefined })),
				res
			);
			expect(res.status).toHaveBeenCalledWith(400);
			expect(res.body).toEqual({ error: "jobId is required" });
		});

		test("returns 400 when urlIndex missing", async () => {
			const res = createMockRes();
			await handleScrapeRequest(
				createMockReq(validReqBody({ urlIndex: undefined })),
				res
			);
			expect(res.status).toHaveBeenCalledWith(400);
			expect(res.body).toEqual({ error: "urlIndex is required" });
		});

		test("returns 400 for unsafe URL (SSRF)", async () => {
			isSafePublicUrl.mockReturnValue({ valid: false, reason: "Blocked by SSRF protection" });
			const res = createMockRes();
			await handleScrapeRequest(createMockReq(validReqBody()), res);

			expect(res.status).toHaveBeenCalledWith(400);
			expect(res.body.error).toBe("Invalid or unsafe URL");
			expect(res.body.reason).toBe("Blocked by SSRF protection");
		});

		test("returns 400 for unsafe callback URL", async () => {
			isValidCallbackUrl.mockReturnValue({
				valid: false,
				reason: "Callback URL domain not in allowed list"
			});
			const res = createMockRes();
			await handleScrapeRequest(createMockReq(validReqBody()), res);

			expect(res.status).toHaveBeenCalledWith(400);
			expect(res.body.error).toBe("Invalid or unsafe callback URL");
			expect(res.body.reason).toBe("Callback URL domain not in allowed list");
		});

		test("returns 503 when memory too high", async () => {
			shouldRestartDueToMemory.mockReturnValue(true);
			const res = createMockRes();
			await handleScrapeRequest(createMockReq(validReqBody()), res);

			expect(res.status).toHaveBeenCalledWith(503);
			expect(res.body.error).toContain("high memory");
		});

		test("sends callback when memory too high", async () => {
			shouldRestartDueToMemory.mockReturnValue(true);
			const res = createMockRes();
			await handleScrapeRequest(createMockReq(validReqBody()), res);

			expect(sendCallback).toHaveBeenCalledWith(
				"https://example.com/callback",
				expect.objectContaining({
					jobId: "job-1",
					urlIndex: 0,
					title: null
				})
			);
			expect(scheduleRestartIfNeeded).toHaveBeenCalled();
		});

		test("routes PDF URLs to fast fetch", async () => {
			isPDFUrl.mockReturnValue(true);
			tryFastFetch.mockResolvedValue(
				"PDF content that is long enough to exceed the fifty character threshold for validation checks."
			);
			const res = createMockRes();
			await handleScrapeRequest(
				createMockReq(validReqBody({ url: "https://example.com/doc.pdf" })),
				res
			);

			expect(tryFastFetch).toHaveBeenCalledWith("https://example.com/doc.pdf");
			expect(sendCallback).toHaveBeenCalled();
			// Should NOT launch a browser
			expect(launchBrowser).not.toHaveBeenCalled();
		});

		test("routes text file URLs to fast fetch", async () => {
			isTextFileUrl.mockReturnValue(true);
			tryFastFetch.mockResolvedValue(
				"Text file content that is long enough to exceed the fifty character threshold for validation."
			);
			const res = createMockRes();
			await handleScrapeRequest(
				createMockReq(validReqBody({ url: "https://example.com/data.csv" })),
				res
			);

			expect(tryFastFetch).toHaveBeenCalledWith("https://example.com/data.csv");
			expect(launchBrowser).not.toHaveBeenCalled();
		});

		test("routes HTML URLs to Puppeteer (returns 202)", async () => {
			setupPuppeteerMocks();
			const res = createMockRes();

			// Use fake timers since the handler fires background Puppeteer work with setTimeout
			jest.useFakeTimers();
			await handleScrapeRequest(createMockReq(validReqBody()), res);

			expect(res.status).toHaveBeenCalledWith(202);
			expect(res.body).toEqual({
				success: true,
				status: "processing",
				message: "Scraping started, results will be sent via callback"
			});

			// Clean up background timers
			await jest.runAllTimersAsync();
			jest.useRealTimers();
		});
	});

	// -----------------------------------------------------------------------
	// handlePuppeteerScraping — full browser lifecycle (via handleScrapeRequest)
	// -----------------------------------------------------------------------
	describe("handlePuppeteerScraping (via handleScrapeRequest with HTML URL)", () => {
		test("browser launches, navigates, extracts content, closes, and sends success callback", async () => {
			const longContent =
				"Extracted page content that is definitely longer than fifty characters to pass the validation.";
			const { mockBrowser, mockPage } = setupPuppeteerMocks({
				content: longContent,
				title: "Product Page"
			});

			const res = createMockRes();
			await runScrapeWithFakeTimers(createMockReq(validReqBody()), res);

			// Browser lifecycle
			expect(launchBrowser).toHaveBeenCalled();
			expect(mockBrowser.newPage).toHaveBeenCalled();
			expect(configureStandardPage).toHaveBeenCalledWith(mockPage);
			expect(mockPage.goto).toHaveBeenCalled();
			expect(extractPageContent).toHaveBeenCalledWith(mockPage, 10000);
			expect(mockBrowser.close).toHaveBeenCalled();

			// Callback with correct content
			expect(sendCallback).toHaveBeenCalledWith(
				"https://example.com/callback",
				expect.objectContaining({
					content: longContent,
					title: "Product Page",
					jobId: "job-1",
					urlIndex: 0
				})
			);

			// Cleanup
			expect(forceGarbageCollection).toHaveBeenCalled();
			expect(trackMemoryUsage).toHaveBeenCalledWith(expect.stringContaining("request_complete"));
			expect(scheduleRestartIfNeeded).toHaveBeenCalled();
		});

		test("disables resource blocking for orientalmotor.co.jp", async () => {
			setupPuppeteerMocks();
			const res = createMockRes();
			await runScrapeWithFakeTimers(
				createMockReq(validReqBody({ url: "https://www.orientalmotor.co.jp/products/detail" })),
				res
			);

			// Resource blocking should NOT be called for Oriental Motor
			expect(setupResourceBlocking).not.toHaveBeenCalled();
			expect(logger.info).toHaveBeenCalledWith(
				expect.stringContaining("Resource blocking DISABLED")
			);
		});

		test("enables resource blocking for normal sites", async () => {
			setupPuppeteerMocks();
			const res = createMockRes();
			await runScrapeWithFakeTimers(createMockReq(validReqBody()), res);

			expect(setupResourceBlocking).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					blockImages: true,
					blockStylesheets: false,
					blockFonts: true,
					blockMedia: true,
					blockTracking: true
				})
			);
		});

		test("navigation timeout continues with extraction", async () => {
			const timeoutError = new Error("Navigation timeout of 45000ms exceeded");
			const { mockBrowser } = setupPuppeteerMocks({
				navigationError: timeoutError,
				content: "Partial content that was available before the navigation timeout occurred in the browser.",
				title: "Partial Page"
			});

			const res = createMockRes();
			await runScrapeWithFakeTimers(createMockReq(validReqBody()), res);

			// Should still extract content and send callback
			expect(extractPageContent).toHaveBeenCalled();
			expect(sendCallback).toHaveBeenCalledWith(
				"https://example.com/callback",
				expect.objectContaining({
					content: expect.any(String),
					title: "Partial Page"
				})
			);
			expect(mockBrowser.close).toHaveBeenCalled();
		});

		test("content < 50 chars gets explanation added", async () => {
			setupPuppeteerMocks({ content: "short", title: "Tiny" });

			const res = createMockRes();
			await runScrapeWithFakeTimers(createMockReq(validReqBody()), res);

			expect(sendCallback).toHaveBeenCalledWith(
				"https://example.com/callback",
				expect.objectContaining({
					content: expect.stringContaining("could not be scraped")
				})
			);
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining("Empty or invalid content")
			);
		});

		test("empty content gets explanation", async () => {
			setupPuppeteerMocks({ content: "", title: "Empty" });
			extractPageContent.mockResolvedValue({ content: "", title: "Empty" });

			const res = createMockRes();
			await runScrapeWithFakeTimers(createMockReq(validReqBody()), res);

			expect(sendCallback).toHaveBeenCalledWith(
				"https://example.com/callback",
				expect.objectContaining({
					content: expect.stringContaining("could not be scraped")
				})
			);
		});

		test("browser.close() failure is logged, not thrown (error path)", async () => {
			const extractError = new Error("Content extraction failed badly");
			const closeError = new Error("Browser process already closed");

			setupPuppeteerMocks({
				extractionError: extractError,
				browserCloseError: closeError
			});

			const res = createMockRes();
			await runScrapeWithFakeTimers(createMockReq(validReqBody()), res);

			// Error callback should still be sent
			expect(sendCallback).toHaveBeenCalledWith(
				"https://example.com/callback",
				expect.objectContaining({
					content: expect.stringContaining("Scraping failed")
				})
			);
			// Close error should be logged
			expect(logger.error).toHaveBeenCalledWith(
				expect.stringContaining("Failed to close browser"),
				"Browser process already closed"
			);
		});

		test("content extraction error sends error callback", async () => {
			const extractError = new Error("Content extraction timeout");
			setupPuppeteerMocks({ extractionError: extractError });

			const res = createMockRes();
			await runScrapeWithFakeTimers(createMockReq(validReqBody()), res);

			expect(sendCallback).toHaveBeenCalledWith(
				"https://example.com/callback",
				expect.objectContaining({
					content: expect.stringContaining("Content extraction timeout"),
					title: null
				})
			);
		});

		test("Puppeteer general error sends error callback and schedules restart", async () => {
			// Make launch itself fail - no setTimeout involved since it fails before navigation
			launchBrowser.mockRejectedValue(new Error("Failed to launch browser"));
			isPDFUrl.mockReturnValue(false);
			isTextFileUrl.mockReturnValue(false);

			const res = createMockRes();
			await runScrapeWithFakeTimers(createMockReq(validReqBody()), res);

			// Error callback
			expect(sendCallback).toHaveBeenCalledWith(
				"https://example.com/callback",
				expect.objectContaining({
					content: expect.stringContaining("Failed to launch browser"),
					title: null
				})
			);
			// Should schedule restart
			expect(scheduleRestartIfNeeded).toHaveBeenCalled();
		});

		test("SSRF validation before Puppeteer navigation blocks unsafe URL", async () => {
			const mockPage = createMockPage();
			const mockBrowser = createMockBrowser(mockPage);
			launchBrowser.mockResolvedValue(mockBrowser);
			configureStandardPage.mockResolvedValue(undefined);
			setupResourceBlocking.mockResolvedValue(undefined);
			isPDFUrl.mockReturnValue(false);
			isTextFileUrl.mockReturnValue(false);

			// First call (handleScrapeRequest level) passes, second call (handlePuppeteerScraping) fails
			isSafePublicUrl
				.mockReturnValueOnce({ valid: true }) // handleScrapeRequest level
				.mockReturnValueOnce({
					valid: false,
					reason: "Cannot scrape private IP addresses"
				}); // handlePuppeteerScraping pre-navigation check

			const res = createMockRes();
			await runScrapeWithFakeTimers(createMockReq(validReqBody()), res);

			// Should get error callback about SSRF block
			expect(sendCallback).toHaveBeenCalledWith(
				"https://example.com/callback",
				expect.objectContaining({
					content: expect.stringContaining("Invalid URL for scraping"),
					title: null
				})
			);
			// Navigation should NOT have happened
			expect(mockPage.goto).not.toHaveBeenCalled();
		});

		test("Cloudflare site (orientalmotor.co.jp) gets 20s wait", async () => {
			jest.useFakeTimers();
			setupPuppeteerMocks();

			const res = createMockRes();

			// Start the request
			handleScrapeRequest(
				createMockReq(validReqBody({ url: "https://www.orientalmotor.co.jp/product" })),
				res
			);

			// Let the microtask queue drain so the 202 response fires
			await jest.advanceTimersByTimeAsync(0);
			expect(res.status).toHaveBeenCalledWith(202);

			// Advance less than 20s - callback should NOT have been sent yet
			// (the rendering wait is the bottleneck)
			await jest.advanceTimersByTimeAsync(19000);
			expect(sendCallback).not.toHaveBeenCalledWith(
				"https://example.com/callback",
				expect.objectContaining({
					title: "Test Page Title"
				})
			);

			// Advance past 20s - now the callback should fire
			await jest.advanceTimersByTimeAsync(2000);

			expect(logger.info).toHaveBeenCalledWith(
				expect.stringContaining("Extended 20-second wait")
			);

			jest.useRealTimers();
		});

		test("normal site gets 3s wait", async () => {
			jest.useFakeTimers();
			const longContent =
				"Normal site content that has more than fifty characters for the validation to pass successfully.";
			setupPuppeteerMocks({ content: longContent, title: "Normal" });

			const res = createMockRes();
			handleScrapeRequest(createMockReq(validReqBody()), res);

			// Advance timers enough for the 3-second rendering wait to complete
			await jest.advanceTimersByTimeAsync(3500);

			// The callback should have been sent with the content
			expect(sendCallback).toHaveBeenCalledWith(
				"https://example.com/callback",
				expect.objectContaining({
					content: longContent,
					title: "Normal"
				})
			);

			jest.useRealTimers();
		});

		test("timeout site gets 1s wait", async () => {
			jest.useFakeTimers();
			const timeoutError = new Error("Navigation timeout of 45000ms exceeded");
			const longContent =
				"Partial content still retrieved after the navigation timed out - has more than fifty chars.";
			setupPuppeteerMocks({
				navigationError: timeoutError,
				content: longContent,
				title: "Timeout Page"
			});

			const res = createMockRes();
			handleScrapeRequest(createMockReq(validReqBody()), res);

			// Advance 1.5s - enough for the 1s timeout wait to finish
			await jest.advanceTimersByTimeAsync(1500);

			expect(sendCallback).toHaveBeenCalledWith(
				"https://example.com/callback",
				expect.objectContaining({
					content: longContent,
					title: "Timeout Page"
				})
			);

			jest.useRealTimers();
		});

		test("sets up network monitoring via page.on", async () => {
			const { mockPage } = setupPuppeteerMocks();
			const res = createMockRes();
			await runScrapeWithFakeTimers(createMockReq(validReqBody()), res);

			// setupNetworkMonitoring registers three page.on listeners
			const onCalls = mockPage.on.mock.calls.map((call) => call[0]);
			expect(onCalls).toContain("request");
			expect(onCalls).toContain("requestfinished");
			expect(onCalls).toContain("requestfailed");
		});
	});

	// -----------------------------------------------------------------------
	// handleFastFetchSuccess
	// -----------------------------------------------------------------------
	describe("handleFastFetchSuccess", () => {
		test("content >= 50 chars sends success callback and returns result", async () => {
			isPDFUrl.mockReturnValue(true);
			const longContent =
				"PDF content that is definitely longer than fifty characters to pass the content length check.";
			tryFastFetch.mockResolvedValue(longContent);

			const res = createMockRes();
			await handleScrapeRequest(createMockReq(validReqBody()), res);

			expect(sendCallback).toHaveBeenCalledWith(
				"https://example.com/callback",
				expect.objectContaining({
					content: longContent,
					title: null,
					jobId: "job-1",
					urlIndex: 0
				})
			);
			// Should return JSON result (not 202)
			expect(res.json).toHaveBeenCalledWith(
				expect.objectContaining({
					success: true,
					content: longContent,
					method: "fast_fetch"
				})
			);
		});

		test("content < 50 chars adds explanation before callback", async () => {
			isPDFUrl.mockReturnValue(true);
			tryFastFetch.mockResolvedValue("short");

			const res = createMockRes();
			await handleScrapeRequest(createMockReq(validReqBody()), res);

			expect(sendCallback).toHaveBeenCalledWith(
				"https://example.com/callback",
				expect.objectContaining({
					content: expect.stringContaining("could not be scraped")
				})
			);
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining("Empty or invalid content")
			);
		});

		test("calls GC and memory tracking after success", async () => {
			isPDFUrl.mockReturnValue(true);
			tryFastFetch.mockResolvedValue(
				"Content that is more than fifty characters long so the validation passes without explanation."
			);

			const res = createMockRes();
			await handleScrapeRequest(createMockReq(validReqBody()), res);

			expect(forceGarbageCollection).toHaveBeenCalled();
			expect(getRequestCount).toHaveBeenCalled();
			expect(trackMemoryUsage).toHaveBeenCalledWith(
				expect.stringContaining("request_complete")
			);
			expect(scheduleRestartIfNeeded).toHaveBeenCalled();
		});
	});

	// -----------------------------------------------------------------------
	// handlePDFOrTextFileFailed
	// -----------------------------------------------------------------------
	describe("handlePDFOrTextFileFailed", () => {
		test("sends error callback with failure message", async () => {
			isPDFUrl.mockReturnValue(true);
			tryFastFetch.mockResolvedValue(null); // fast fetch failed

			const res = createMockRes();
			await handleScrapeRequest(createMockReq(validReqBody()), res);

			expect(sendCallback).toHaveBeenCalledWith(
				"https://example.com/callback",
				expect.objectContaining({
					content: "[PDF or text file could not be fetched]",
					title: null,
					jobId: "job-1",
					urlIndex: 0
				})
			);
		});

		test("returns 500 response with error", async () => {
			isPDFUrl.mockReturnValue(true);
			tryFastFetch.mockResolvedValue(null);

			const res = createMockRes();
			await handleScrapeRequest(createMockReq(validReqBody()), res);

			expect(res.status).toHaveBeenCalledWith(500);
			expect(res.body).toEqual(
				expect.objectContaining({
					success: false,
					error: "PDF or text file could not be fetched"
				})
			);
		});

		test("calls scheduleRestartIfNeeded", async () => {
			isPDFUrl.mockReturnValue(true);
			tryFastFetch.mockResolvedValue(null);

			const res = createMockRes();
			await handleScrapeRequest(createMockReq(validReqBody()), res);

			expect(scheduleRestartIfNeeded).toHaveBeenCalled();
		});
	});

	// -----------------------------------------------------------------------
	// enqueuePuppeteerTask
	// -----------------------------------------------------------------------
	describe("enqueuePuppeteerTask", () => {
		test("executes tasks sequentially", async () => {
			const order = [];

			const task1 = enqueuePuppeteerTask(async () => {
				order.push("task1-start");
				// Use a short resolved promise instead of setTimeout to avoid timer issues
				await Promise.resolve();
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
			// task2 must start AFTER task1 ends
			expect(order).toEqual(["task1-start", "task1-end", "task2-start"]);
		});

		test("previous task failure does not block next task", async () => {
			const failTask = enqueuePuppeteerTask(async () => {
				throw new Error("task failed");
			});

			await expect(failTask).rejects.toThrow("task failed");

			const successResult = await enqueuePuppeteerTask(async () => "recovered");
			expect(successResult).toBe("recovered");
		});
	});
});
