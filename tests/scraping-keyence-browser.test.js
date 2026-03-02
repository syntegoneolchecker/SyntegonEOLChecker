/**
 * Tests for scraping-service/routes/scrape-keyence.js - Phase 3B: Browser Logic
 *
 * This test file focuses on the browser interaction layer:
 * performKeyenceSearch, extractKeyenceContent, validateKeyenceContent,
 * and the full background task flow within handleKeyenceScrapeRequest.
 *
 * Heavy dependencies (puppeteer, callback, scrape queue) are mocked.
 * enqueuePuppeteerTask is mocked to execute the callback immediately
 * so we can test the internal browser logic.
 *
 * IMPORTANT: handleKeyenceScrapeRequest does NOT await the background task.
 * It calls enqueuePuppeteerTask(...).catch(...) without await (fire-and-forget).
 * The background task contains setTimeout waits (1000ms in performKeyenceSearch).
 * We capture the background task promise via the mock and await it in tests
 * after advancing fake timers.
 */

jest.mock("../scraping-service/utils/logger", () => ({
	info: jest.fn(),
	warn: jest.fn(),
	error: jest.fn(),
	debug: jest.fn()
}));

jest.mock("../scraping-service/config/puppeteer", () => ({
	launchBrowser: jest.fn(),
	configureStandardPage: jest.fn().mockResolvedValue(undefined),
	setupResourceBlocking: jest.fn().mockResolvedValue(undefined)
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
		const hostname = new URL(url).hostname;
		if (hostname === "evil.com" || hostname.startsWith("169.254.")) {
			return { valid: false, reason: "Callback URL domain not in allowed list" };
		}
		return { valid: true };
	})
}));

jest.mock("../scraping-service/utils/callback", () => ({
	sendCallback: jest.fn(() => Promise.resolve())
}));

// Mock enqueuePuppeteerTask to execute the callback immediately.
// We capture the promise so tests can await the background work completing.
let backgroundTaskPromise = null;
jest.mock("../scraping-service/routes/scrape", () => ({
	enqueuePuppeteerTask: jest.fn((fn) => {
		const p = fn();
		backgroundTaskPromise = p;
		return p;
	})
}));

const { handleKeyenceScrapeRequest } = require("../scraping-service/routes/scrape-keyence");
const {
	getShutdownState,
	incrementRequestCount,
	trackMemoryUsage,
	forceGarbageCollection,
	scheduleRestartIfNeeded,
	setShutdownState
} = require("../scraping-service/utils/memory");
const { isValidCallbackUrl } = require("../scraping-service/utils/validation");
const { sendCallback } = require("../scraping-service/utils/callback");
const { enqueuePuppeteerTask } = require("../scraping-service/routes/scrape");
const {
	launchBrowser,
	configureStandardPage,
	setupResourceBlocking
} = require("../scraping-service/config/puppeteer");
const logger = require("../scraping-service/utils/logger");

/**
 * Creates a mock Puppeteer page with all methods needed by the module.
 * By default, page.evaluate returns truthy for search element check
 * and valid extraction content.
 */
function createMockPage() {
	const mockPage = {
		goto: jest.fn().mockResolvedValue(undefined),
		evaluate: jest.fn(),
		on: jest.fn(),
		click: jest.fn().mockResolvedValue(undefined),
		keyboard: { press: jest.fn().mockResolvedValue(undefined) },
		waitForNavigation: jest.fn().mockResolvedValue(undefined),
		url: jest.fn().mockReturnValue("https://www.keyence.co.jp/search?q=test-model"),
		close: jest.fn().mockResolvedValue(undefined),
		setUserAgent: jest.fn(),
		setViewport: jest.fn(),
		setRequestInterception: jest.fn()
	};

	// Default evaluate behavior: first call checks search elements (returns true),
	// second call sets input value (returns undefined),
	// third call extracts content (returns {text, title})
	let evaluateCallCount = 0;
	mockPage.evaluate.mockImplementation(() => {
		evaluateCallCount++;
		if (evaluateCallCount === 1) {
			return Promise.resolve(true);
		}
		if (evaluateCallCount === 2) {
			return Promise.resolve(undefined);
		}
		if (evaluateCallCount === 3) {
			return Promise.resolve({
				text: "KEYENCE product page content that is long enough to pass the 50-character validation threshold easily",
				title: "KEYENCE Search Results"
			});
		}
		return Promise.resolve(undefined);
	});

	return mockPage;
}

function createMockBrowser(mockPage) {
	return {
		newPage: jest.fn().mockResolvedValue(mockPage),
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

/**
 * Helper: call handleKeyenceScrapeRequest, advance all fake timers,
 * then wait for the background task to complete.
 */
async function runHandlerAndWaitForBackground(req, res) {
	const handlerResult = handleKeyenceScrapeRequest(req, res);

	// The handler itself is async but returns quickly after sending 202.
	// The background task runs via enqueuePuppeteerTask.
	// We need to flush microtasks and advance timers iteratively
	// to handle the setTimeout calls in performKeyenceSearch.
	for (let i = 0; i < 10; i++) {
		jest.advanceTimersByTime(2000);
		await Promise.resolve();
	}

	// Wait for handler to complete
	await handlerResult;

	// Wait for background task to complete (if it was enqueued)
	if (backgroundTaskPromise) {
		try {
			await backgroundTaskPromise;
		} catch {
			// Background errors are handled internally via .catch()
		}
	}

	// Final flush of microtasks
	await Promise.resolve();
	await Promise.resolve();
}

beforeEach(() => {
	jest.useFakeTimers();
	jest.clearAllMocks();
	backgroundTaskPromise = null;
	getShutdownState.mockReturnValue(false);
	incrementRequestCount.mockReturnValue(1);
	trackMemoryUsage.mockReturnValue({ rss: 100, heapUsed: 60, heapTotal: 120, external: 5 });
	isValidCallbackUrl.mockImplementation((url) => {
		if (!url) return { valid: true };
		const hostname = new URL(url).hostname;
		if (hostname === "evil.com" || hostname.startsWith("169.254.")) {
			return { valid: false, reason: "Callback URL domain not in allowed list" };
		}
		return { valid: true };
	});
	enqueuePuppeteerTask.mockImplementation((fn) => {
		const p = fn();
		backgroundTaskPromise = p;
		return p;
	});
});

afterEach(() => {
	jest.useRealTimers();
});

describe("Scraping Keyence Browser Logic", () => {
	describe("handleKeyenceScrapeRequest - input validation", () => {
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

		test("should return 400 for invalid callback URL", async () => {
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

		test("should return 202 for valid request", async () => {
			const mockPage = createMockPage();
			const mockBrowser = createMockBrowser(mockPage);
			launchBrowser.mockResolvedValue(mockBrowser);

			const req = createMockReq({
				model: "LR-ZB250CP",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await runHandlerAndWaitForBackground(req, res);

			expect(res.status).toHaveBeenCalledWith(202);
			expect(res.body).toEqual({
				success: true,
				status: "processing",
				message: "KEYENCE search started, results will be sent via callback"
			});
		});
	});

	describe("handleKeyenceScrapeRequest - full success flow", () => {
		test("should execute full success flow: launch, search, extract, validate, callback, cleanup", async () => {
			const mockPage = createMockPage();
			const mockBrowser = createMockBrowser(mockPage);
			launchBrowser.mockResolvedValue(mockBrowser);

			const req = createMockReq({
				model: "IV2-G500CA",
				callbackUrl: "https://example.com/callback",
				jobId: "job-42",
				urlIndex: 3
			});
			const res = createMockRes();

			await runHandlerAndWaitForBackground(req, res);

			// Verify browser lifecycle
			expect(launchBrowser).toHaveBeenCalled();
			expect(mockBrowser.newPage).toHaveBeenCalled();
			expect(configureStandardPage).toHaveBeenCalledWith(mockPage);
			expect(setupResourceBlocking).toHaveBeenCalledWith(mockPage, {
				blockImages: true,
				blockStylesheets: false,
				blockFonts: true,
				blockMedia: true,
				blockTracking: true
			});

			// Verify search was performed
			expect(mockPage.goto).toHaveBeenCalledWith("https://www.keyence.co.jp/", {
				waitUntil: "domcontentloaded",
				timeout: 30000
			});

			// Verify browser was closed before callback
			expect(mockBrowser.close).toHaveBeenCalled();

			// Verify callback was sent with correct data
			expect(sendCallback).toHaveBeenCalledWith(
				"https://example.com/callback",
				expect.objectContaining({
					jobId: "job-42",
					urlIndex: 3,
					content: expect.any(String),
					title: "KEYENCE Search Results",
					snippet: "KEYENCE search result for IV2-G500CA",
					url: "https://www.keyence.co.jp/search?q=test-model"
				})
			);

			// Verify cleanup
			expect(forceGarbageCollection).toHaveBeenCalled();
			expect(trackMemoryUsage).toHaveBeenCalledWith(
				expect.stringContaining("keyence_complete_")
			);
			expect(scheduleRestartIfNeeded).toHaveBeenCalled();
		});

		test("should log browser close failure in success path", async () => {
			const mockPage = createMockPage();
			const mockBrowser = createMockBrowser(mockPage);
			// browser.close() throws in the try block success path
			mockBrowser.close.mockRejectedValue(new Error("Browser close failed"));
			launchBrowser.mockResolvedValue(mockBrowser);

			const req = createMockReq({
				model: "LR-ZB250CP",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await runHandlerAndWaitForBackground(req, res);

			// Browser close failure in try block propagates to catch block
			expect(logger.error).toHaveBeenCalledWith(
				expect.stringContaining("KEYENCE scraping error"),
				expect.any(Error)
			);
		});

		test("should call forceGarbageCollection and trackMemoryUsage on success", async () => {
			const mockPage = createMockPage();
			const mockBrowser = createMockBrowser(mockPage);
			launchBrowser.mockResolvedValue(mockBrowser);

			const req = createMockReq({
				model: "LR-ZB250CP",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await runHandlerAndWaitForBackground(req, res);

			expect(forceGarbageCollection).toHaveBeenCalled();
			expect(trackMemoryUsage).toHaveBeenCalledWith(
				expect.stringContaining("keyence_complete_")
			);
		});

		test("should skip callback send when no callbackUrl is provided", async () => {
			const mockPage = createMockPage();
			const mockBrowser = createMockBrowser(mockPage);
			launchBrowser.mockResolvedValue(mockBrowser);

			const req = createMockReq({
				model: "LR-ZB250CP",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await runHandlerAndWaitForBackground(req, res);

			expect(sendCallback).not.toHaveBeenCalled();
			// Should still complete cleanup
			expect(forceGarbageCollection).toHaveBeenCalled();
		});
	});

	describe("handleKeyenceScrapeRequest - error handling", () => {
		test("should send error callback and set shutdown on search failure", async () => {
			const mockPage = createMockPage();
			const mockBrowser = createMockBrowser(mockPage);
			launchBrowser.mockResolvedValue(mockBrowser);

			// Make performKeyenceSearch fail by making goto throw
			mockPage.goto.mockRejectedValue(new Error("Navigation failed"));

			const req = createMockReq({
				model: "LR-ZB250CP",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await runHandlerAndWaitForBackground(req, res);

			// Should still return 202 (response sent before background task)
			expect(res.status).toHaveBeenCalledWith(202);

			// Error callback should be sent
			expect(sendCallback).toHaveBeenCalledWith(
				"https://example.com/callback",
				expect.objectContaining({
					jobId: "job-1",
					urlIndex: 0,
					content: expect.stringContaining("KEYENCE search failed"),
					title: null,
					snippet: "",
					url: "https://www.keyence.co.jp/"
				})
			);

			// Browser should be closed
			expect(mockBrowser.close).toHaveBeenCalled();

			// Shutdown should be set
			expect(setShutdownState).toHaveBeenCalledWith(true);
			expect(scheduleRestartIfNeeded).toHaveBeenCalled();
		});

		test("should send error callback and set shutdown on extraction failure", async () => {
			const mockPage = createMockPage();
			const mockBrowser = createMockBrowser(mockPage);
			launchBrowser.mockResolvedValue(mockBrowser);

			// Override evaluate: first two calls succeed, third (extraction) throws
			let callCount = 0;
			mockPage.evaluate.mockImplementation(() => {
				callCount++;
				if (callCount === 1) return Promise.resolve(true);
				if (callCount === 2) return Promise.resolve(undefined);
				if (callCount === 3)
					return Promise.reject(new Error("Evaluation failed: page crashed"));
				return Promise.resolve(undefined);
			});

			const req = createMockReq({
				model: "LR-ZB250CP",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await runHandlerAndWaitForBackground(req, res);

			expect(sendCallback).toHaveBeenCalledWith(
				"https://example.com/callback",
				expect.objectContaining({
					content: expect.stringContaining("KEYENCE search failed"),
					title: null
				})
			);

			expect(setShutdownState).toHaveBeenCalledWith(true);
			expect(scheduleRestartIfNeeded).toHaveBeenCalled();
		});

		test("should call setShutdownState(true) and scheduleRestartIfNeeded on error", async () => {
			const mockPage = createMockPage();
			const mockBrowser = createMockBrowser(mockPage);
			launchBrowser.mockResolvedValue(mockBrowser);

			mockPage.goto.mockRejectedValue(new Error("Timeout"));

			const req = createMockReq({
				model: "LR-ZB250CP",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await runHandlerAndWaitForBackground(req, res);

			expect(setShutdownState).toHaveBeenCalledWith(true);
			expect(scheduleRestartIfNeeded).toHaveBeenCalled();
		});

		test("should skip error callback when no callbackUrl provided", async () => {
			const mockPage = createMockPage();
			const mockBrowser = createMockBrowser(mockPage);
			launchBrowser.mockResolvedValue(mockBrowser);

			mockPage.goto.mockRejectedValue(new Error("Navigation failed"));

			const req = createMockReq({
				model: "LR-ZB250CP",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await runHandlerAndWaitForBackground(req, res);

			expect(sendCallback).not.toHaveBeenCalled();
			// Shutdown should still be set
			expect(setShutdownState).toHaveBeenCalledWith(true);
		});

		test("should handle browser close error during error path gracefully", async () => {
			const mockPage = createMockPage();
			const mockBrowser = createMockBrowser(mockPage);
			launchBrowser.mockResolvedValue(mockBrowser);

			mockPage.goto.mockRejectedValue(new Error("Navigation failed"));
			// Browser close fails in the catch block
			mockBrowser.close.mockRejectedValue(new Error("Browser already closed"));

			const req = createMockReq({
				model: "LR-ZB250CP",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			// Should not throw - errors are caught internally
			await runHandlerAndWaitForBackground(req, res);

			expect(logger.error).toHaveBeenCalledWith(
				expect.stringContaining("Error closing browser"),
				expect.any(Error)
			);

			// Error callback should still be sent
			expect(sendCallback).toHaveBeenCalled();
		});
	});

	describe("performKeyenceSearch - tested via handleKeyenceScrapeRequest mock flow", () => {
		test("should navigate to KEYENCE homepage", async () => {
			const mockPage = createMockPage();
			const mockBrowser = createMockBrowser(mockPage);
			launchBrowser.mockResolvedValue(mockBrowser);

			const req = createMockReq({
				model: "LR-ZB250CP",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await runHandlerAndWaitForBackground(req, res);

			expect(mockPage.goto).toHaveBeenCalledWith("https://www.keyence.co.jp/", {
				waitUntil: "domcontentloaded",
				timeout: 30000
			});
		});

		test("should check for search elements via page.evaluate", async () => {
			const mockPage = createMockPage();
			const mockBrowser = createMockBrowser(mockPage);
			launchBrowser.mockResolvedValue(mockBrowser);

			const req = createMockReq({
				model: "LR-ZB250CP",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await runHandlerAndWaitForBackground(req, res);

			// First evaluate call should check for search elements
			expect(mockPage.evaluate).toHaveBeenCalled();
			const firstEvaluateCall = mockPage.evaluate.mock.calls[0];
			expect(typeof firstEvaluateCall[0]).toBe("function");
		});

		test("should throw error when search elements are missing", async () => {
			const mockPage = createMockPage();
			const mockBrowser = createMockBrowser(mockPage);
			launchBrowser.mockResolvedValue(mockBrowser);

			// Override: first evaluate returns false (no search elements)
			let callCount = 0;
			mockPage.evaluate.mockImplementation(() => {
				callCount++;
				if (callCount === 1) return Promise.resolve(false);
				return Promise.resolve(undefined);
			});

			const req = createMockReq({
				model: "LR-ZB250CP",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await runHandlerAndWaitForBackground(req, res);

			// Should have sent error callback with "Search input or button not found" message
			expect(sendCallback).toHaveBeenCalledWith(
				"https://example.com/callback",
				expect.objectContaining({
					content: expect.stringContaining("Search input or button not found")
				})
			);
		});

		test("should set input value and dispatch events via evaluate", async () => {
			const mockPage = createMockPage();
			const mockBrowser = createMockBrowser(mockPage);
			launchBrowser.mockResolvedValue(mockBrowser);

			const req = createMockReq({
				model: "IV2-G500CA",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await runHandlerAndWaitForBackground(req, res);

			// Second evaluate call should set input value with selector and model
			expect(mockPage.evaluate.mock.calls.length).toBeGreaterThanOrEqual(2);
			const secondEvaluateCall = mockPage.evaluate.mock.calls[1];
			expect(typeof secondEvaluateCall[0]).toBe("function");
			expect(secondEvaluateCall[1]).toBe(".m-form-search__input");
			expect(secondEvaluateCall[2]).toBe("IV2-G500CA");
		});

		test("should click input and submit search via keyboard Enter", async () => {
			const mockPage = createMockPage();
			const mockBrowser = createMockBrowser(mockPage);
			launchBrowser.mockResolvedValue(mockBrowser);

			const req = createMockReq({
				model: "LR-ZB250CP",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await runHandlerAndWaitForBackground(req, res);

			expect(mockPage.click).toHaveBeenCalledWith(".m-form-search__input");
			expect(mockPage.keyboard.press).toHaveBeenCalledWith("Enter");
			expect(mockPage.waitForNavigation).toHaveBeenCalledWith({
				waitUntil: "domcontentloaded",
				timeout: 20000
			});
		});

		test("should handle navigation timeout with fallback wait", async () => {
			const mockPage = createMockPage();
			const mockBrowser = createMockBrowser(mockPage);
			launchBrowser.mockResolvedValue(mockBrowser);

			// Make waitForNavigation reject with timeout
			mockPage.waitForNavigation.mockRejectedValue(
				new Error("Navigation timeout of 20000ms exceeded")
			);

			const req = createMockReq({
				model: "LR-ZB250CP",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			// Need extra microtask flushes for this test because of Promise.all rejection
			// followed by another setTimeout in the catch path
			const handlerResult = handleKeyenceScrapeRequest(req, res);

			for (let i = 0; i < 30; i++) {
				jest.advanceTimersByTime(1000);
				await Promise.resolve();
				await Promise.resolve();
				await Promise.resolve();
				await Promise.resolve();
			}

			await handlerResult;

			if (backgroundTaskPromise) {
				try {
					await backgroundTaskPromise;
				} catch {
					// handled internally
				}
			}

			await Promise.resolve();
			await Promise.resolve();

			// Should log navigation timeout
			expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("Navigation timeout"));

			// Should still proceed and complete successfully (not trigger error path)
			// The success callback should be sent with content
			expect(sendCallback).toHaveBeenCalledWith(
				"https://example.com/callback",
				expect.objectContaining({
					jobId: "job-1",
					content: expect.any(String),
					url: expect.any(String)
				})
			);

			// Should not set shutdown state since this is a recoverable situation
			expect(setShutdownState).not.toHaveBeenCalled();
		});
	});

	describe("extractKeyenceContent - tested via handleKeyenceScrapeRequest mock flow", () => {
		test("should extract text and title from page", async () => {
			const mockPage = createMockPage();
			const mockBrowser = createMockBrowser(mockPage);
			launchBrowser.mockResolvedValue(mockBrowser);

			const expectedText =
				"This is a KEYENCE product page with enough content to pass the validation threshold check";
			const expectedTitle = "KEYENCE - IV2-G500CA Product Page";

			let callCount = 0;
			mockPage.evaluate.mockImplementation(() => {
				callCount++;
				if (callCount === 1) return Promise.resolve(true);
				if (callCount === 2) return Promise.resolve(undefined);
				if (callCount === 3)
					return Promise.resolve({ text: expectedText, title: expectedTitle });
				return Promise.resolve(undefined);
			});

			const req = createMockReq({
				model: "IV2-G500CA",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await runHandlerAndWaitForBackground(req, res);

			expect(sendCallback).toHaveBeenCalledWith(
				"https://example.com/callback",
				expect.objectContaining({
					content: expectedText,
					title: expectedTitle
				})
			);
		});

		test("should handle extraction timeout (10s)", async () => {
			const mockPage = createMockPage();
			const mockBrowser = createMockBrowser(mockPage);
			launchBrowser.mockResolvedValue(mockBrowser);

			// Make the extraction evaluate never resolve (simulating a hang)
			let callCount = 0;
			mockPage.evaluate.mockImplementation(() => {
				callCount++;
				if (callCount === 1) return Promise.resolve(true);
				if (callCount === 2) return Promise.resolve(undefined);
				if (callCount === 3) {
					// Return a promise that never resolves - the timeout will win
					return new Promise(() => {});
				}
				return Promise.resolve(undefined);
			});

			const req = createMockReq({
				model: "LR-ZB250CP",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			// Use the iterative approach to advance timers and flush microtasks
			const handlerResult = handleKeyenceScrapeRequest(req, res);

			// Advance timers in steps to handle the sequential awaits
			// performKeyenceSearch has a 1000ms setTimeout wait
			// extractKeyenceContent has a 10000ms timeout
			for (let i = 0; i < 20; i++) {
				jest.advanceTimersByTime(1000);
				await Promise.resolve();
				await Promise.resolve();
				await Promise.resolve();
			}

			await handlerResult;

			if (backgroundTaskPromise) {
				try {
					await backgroundTaskPromise;
				} catch {
					// Expected: the extraction timeout error is caught internally
				}
			}

			// Flush final microtasks
			await Promise.resolve();
			await Promise.resolve();

			// Should have sent error callback because extraction timed out
			expect(sendCallback).toHaveBeenCalledWith(
				"https://example.com/callback",
				expect.objectContaining({
					content: expect.stringContaining("KEYENCE search failed"),
					title: null
				})
			);
		});

		test("should log browser evaluation error when result.error exists", async () => {
			const mockPage = createMockPage();
			const mockBrowser = createMockBrowser(mockPage);
			launchBrowser.mockResolvedValue(mockBrowser);

			let callCount = 0;
			mockPage.evaluate.mockImplementation(() => {
				callCount++;
				if (callCount === 1) return Promise.resolve(true);
				if (callCount === 2) return Promise.resolve(undefined);
				if (callCount === 3) {
					return Promise.resolve({
						text: "Some content that is longer than fifty characters to pass the validation check",
						title: "Page Title",
						error: "ReferenceError: something is not defined"
					});
				}
				return Promise.resolve(undefined);
			});

			const req = createMockReq({
				model: "LR-ZB250CP",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await runHandlerAndWaitForBackground(req, res);

			// Should log the browser evaluation error
			expect(logger.error).toHaveBeenCalledWith(
				expect.stringContaining(
					"Browser evaluation error: ReferenceError: something is not defined"
				)
			);

			// Should still send success callback with extracted content
			expect(sendCallback).toHaveBeenCalledWith(
				"https://example.com/callback",
				expect.objectContaining({
					content: expect.stringContaining("Some content"),
					title: "Page Title"
				})
			);
		});
	});

	describe("validateKeyenceContent - tested via handleKeyenceScrapeRequest mock flow", () => {
		test("should return original content when text is >= 50 characters", async () => {
			const mockPage = createMockPage();
			const mockBrowser = createMockBrowser(mockPage);
			launchBrowser.mockResolvedValue(mockBrowser);

			const longContent = "A".repeat(100);
			let callCount = 0;
			mockPage.evaluate.mockImplementation(() => {
				callCount++;
				if (callCount === 1) return Promise.resolve(true);
				if (callCount === 2) return Promise.resolve(undefined);
				if (callCount === 3) return Promise.resolve({ text: longContent, title: "Title" });
				return Promise.resolve(undefined);
			});

			const req = createMockReq({
				model: "LR-ZB250CP",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await runHandlerAndWaitForBackground(req, res);

			expect(sendCallback).toHaveBeenCalledWith(
				"https://example.com/callback",
				expect.objectContaining({
					content: longContent
				})
			);
		});

		test("should add explanation when text is < 50 characters", async () => {
			const mockPage = createMockPage();
			const mockBrowser = createMockBrowser(mockPage);
			launchBrowser.mockResolvedValue(mockBrowser);

			const shortContent = "Short";
			let callCount = 0;
			mockPage.evaluate.mockImplementation(() => {
				callCount++;
				if (callCount === 1) return Promise.resolve(true);
				if (callCount === 2) return Promise.resolve(undefined);
				if (callCount === 3) return Promise.resolve({ text: shortContent, title: "Title" });
				return Promise.resolve(undefined);
			});

			const req = createMockReq({
				model: "LR-ZB250CP",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await runHandlerAndWaitForBackground(req, res);

			expect(sendCallback).toHaveBeenCalledWith(
				"https://example.com/callback",
				expect.objectContaining({
					content: expect.stringContaining("KEYENCE search extracted only 5 characters")
				})
			);

			// Should log warning about empty content
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining("Empty or invalid KEYENCE content")
			);
		});

		test("should add explanation when text is empty string", async () => {
			const mockPage = createMockPage();
			const mockBrowser = createMockBrowser(mockPage);
			launchBrowser.mockResolvedValue(mockBrowser);

			let callCount = 0;
			mockPage.evaluate.mockImplementation(() => {
				callCount++;
				if (callCount === 1) return Promise.resolve(true);
				if (callCount === 2) return Promise.resolve(undefined);
				if (callCount === 3) return Promise.resolve({ text: "", title: "Title" });
				return Promise.resolve(undefined);
			});

			const req = createMockReq({
				model: "LR-ZB250CP",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await runHandlerAndWaitForBackground(req, res);

			expect(sendCallback).toHaveBeenCalledWith(
				"https://example.com/callback",
				expect.objectContaining({
					content: expect.stringContaining("KEYENCE search extracted only 0 characters")
				})
			);

			expect(sendCallback).toHaveBeenCalledWith(
				"https://example.com/callback",
				expect.objectContaining({
					content: expect.stringContaining("The search may have returned no results")
				})
			);
		});

		test("should handle exactly 50 characters (boundary - passes validation)", async () => {
			const mockPage = createMockPage();
			const mockBrowser = createMockBrowser(mockPage);
			launchBrowser.mockResolvedValue(mockBrowser);

			const exactly50 = "A".repeat(50);
			let callCount = 0;
			mockPage.evaluate.mockImplementation(() => {
				callCount++;
				if (callCount === 1) return Promise.resolve(true);
				if (callCount === 2) return Promise.resolve(undefined);
				if (callCount === 3) return Promise.resolve({ text: exactly50, title: "Title" });
				return Promise.resolve(undefined);
			});

			const req = createMockReq({
				model: "LR-ZB250CP",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await runHandlerAndWaitForBackground(req, res);

			// 50 chars is >= 50, should return original text
			expect(sendCallback).toHaveBeenCalledWith(
				"https://example.com/callback",
				expect.objectContaining({
					content: exactly50
				})
			);
		});

		test("should handle 49 characters (just below threshold)", async () => {
			const mockPage = createMockPage();
			const mockBrowser = createMockBrowser(mockPage);
			launchBrowser.mockResolvedValue(mockBrowser);

			const just49 = "A".repeat(49);
			let callCount = 0;
			mockPage.evaluate.mockImplementation(() => {
				callCount++;
				if (callCount === 1) return Promise.resolve(true);
				if (callCount === 2) return Promise.resolve(undefined);
				if (callCount === 3) return Promise.resolve({ text: just49, title: "Title" });
				return Promise.resolve(undefined);
			});

			const req = createMockReq({
				model: "LR-ZB250CP",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await runHandlerAndWaitForBackground(req, res);

			// 49 chars is below threshold - should add explanation
			expect(sendCallback).toHaveBeenCalledWith(
				"https://example.com/callback",
				expect.objectContaining({
					content: expect.stringContaining("KEYENCE search extracted only 49 characters")
				})
			);
		});
	});

	describe("handleKeyenceScrapeRequest - resource blocking configuration", () => {
		test("should configure resource blocking with correct options (CSS allowed for KEYENCE)", async () => {
			const mockPage = createMockPage();
			const mockBrowser = createMockBrowser(mockPage);
			launchBrowser.mockResolvedValue(mockBrowser);

			const req = createMockReq({
				model: "LR-ZB250CP",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await runHandlerAndWaitForBackground(req, res);

			expect(setupResourceBlocking).toHaveBeenCalledWith(mockPage, {
				blockImages: true,
				blockStylesheets: false,
				blockFonts: true,
				blockMedia: true,
				blockTracking: true
			});
		});
	});

	describe("handleKeyenceScrapeRequest - finally block browser cleanup", () => {
		test("should close browser in finally block if still open after error", async () => {
			const mockPage = createMockPage();
			const mockBrowser = createMockBrowser(mockPage);
			launchBrowser.mockResolvedValue(mockBrowser);

			// Make the search fail
			mockPage.goto.mockRejectedValue(new Error("Navigation failed"));
			// First close (in catch block) fails, so browser ref stays non-null for finally
			let closeCallCount = 0;
			mockBrowser.close.mockImplementation(() => {
				closeCallCount++;
				if (closeCallCount === 1) {
					return Promise.reject(new Error("Close failed in catch"));
				}
				return Promise.resolve();
			});

			const req = createMockReq({
				model: "LR-ZB250CP",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await runHandlerAndWaitForBackground(req, res);

			// Browser close should have been attempted at least twice
			// (once in catch, once in finally)
			expect(mockBrowser.close).toHaveBeenCalledTimes(2);
		});

		test("should log error when finally block browser close fails", async () => {
			const mockPage = createMockPage();
			const mockBrowser = createMockBrowser(mockPage);
			launchBrowser.mockResolvedValue(mockBrowser);

			// Make the search fail
			mockPage.goto.mockRejectedValue(new Error("Navigation failed"));
			// Make all browser close calls fail
			mockBrowser.close.mockRejectedValue(new Error("Cannot close"));

			const req = createMockReq({
				model: "LR-ZB250CP",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await runHandlerAndWaitForBackground(req, res);

			// Should log the finally block close error
			expect(logger.error).toHaveBeenCalledWith(
				expect.stringContaining("Failed to close browser in finally block"),
				expect.stringContaining("Cannot close")
			);
		});
	});

	describe("handleKeyenceScrapeRequest - enqueuePuppeteerTask integration", () => {
		test("should pass an async function to enqueuePuppeteerTask", async () => {
			const mockPage = createMockPage();
			const mockBrowser = createMockBrowser(mockPage);
			launchBrowser.mockResolvedValue(mockBrowser);

			const req = createMockReq({
				model: "LR-ZB250CP",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			await runHandlerAndWaitForBackground(req, res);

			expect(enqueuePuppeteerTask).toHaveBeenCalledWith(expect.any(Function));
		});

		test("should catch enqueuePuppeteerTask rejection and log background error", async () => {
			// Make enqueuePuppeteerTask return a rejected promise without executing any task
			enqueuePuppeteerTask.mockImplementation(() => {
				backgroundTaskPromise = Promise.reject(new Error("Queue full"));
				return backgroundTaskPromise;
			});

			const req = createMockReq({
				model: "LR-ZB250CP",
				callbackUrl: "https://example.com/callback",
				jobId: "job-1",
				urlIndex: 0
			});
			const res = createMockRes();

			// The .catch on the returned promise handles the rejection
			await runHandlerAndWaitForBackground(req, res);

			// Flush microtasks to ensure the .catch handler has executed
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();

			expect(logger.error).toHaveBeenCalledWith(
				expect.stringContaining("Background KEYENCE scraping failed"),
				expect.stringContaining("Queue full")
			);
		});
	});
});
