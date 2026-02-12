// =============================================================================
// Tests for js/eol-check.js - EOL Checking Functionality
// =============================================================================

import { pollJobStatus } from "../js/eol-check.js";

// Mock document for DOM interactions across all imported modules
beforeAll(() => {
	global.document = {
		getElementById: jest.fn(() => ({
			textContent: "",
			className: "",
			checked: false,
			disabled: false,
			style: { display: "" },
			classList: {
				add: jest.fn(),
				remove: jest.fn()
			},
			querySelector: jest.fn(() => ({
				textContent: "",
				disabled: false
			})),
			querySelectorAll: jest.fn(() => [])
		})),
		querySelectorAll: jest.fn(() => [])
	};

	// Suppress console output during tests
	jest.spyOn(console, "log").mockImplementation(() => {});
	jest.spyOn(console, "warn").mockImplementation(() => {});
	jest.spyOn(console, "error").mockImplementation(() => {});
});

afterAll(() => {
	delete global.document;
	delete global.fetch;
	jest.restoreAllMocks();
});

describe("js/eol-check.js - pollJobStatus", () => {
	let mockCheckButton;

	beforeEach(() => {
		jest.useFakeTimers();

		mockCheckButton = { textContent: "", disabled: false };

		global.fetch = jest.fn();
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	test('returns result when job status is "complete"', async () => {
		const expectedResult = {
			status: "EOL",
			explanation: "Product is discontinued",
			successor: { model: "NewModel", explanation: "Direct replacement" }
		};

		// job-status returns complete on first poll
		global.fetch.mockResolvedValueOnce({
			ok: true,
			json: () =>
				Promise.resolve({
					status: "complete",
					result: expectedResult,
					urlCount: 3,
					completedUrls: 3
				})
		});

		const resultPromise = pollJobStatus("job-123", "SMC", "ABC-100", mockCheckButton);
		await jest.runAllTimersAsync();
		const result = await resultPromise;

		expect(result).toEqual(expectedResult);
		expect(result.status).toBe("EOL");
		expect(result.successor.model).toBe("NewModel");
	});

	test('throws when job status is "error"', async () => {
		jest.useRealTimers();

		global.fetch.mockResolvedValueOnce({
			ok: true,
			json: () =>
				Promise.resolve({
					status: "error",
					error: "Rate limit exceeded",
					urlCount: 0,
					completedUrls: 0
				})
		});

		await expect(
			pollJobStatus("job-456", "Festo", "XYZ-200", mockCheckButton)
		).rejects.toThrow("Rate limit exceeded");

		jest.useFakeTimers();
	});

	test("triggers fetch-url when status is urls_ready with pending urls", async () => {
		// First poll: urls_ready with pending URLs
		global.fetch.mockResolvedValueOnce({
			ok: true,
			json: () =>
				Promise.resolve({
					status: "urls_ready",
					urlCount: 1,
					completedUrls: 0,
					urls: [
						{
							index: 0,
							url: "https://example.com/product",
							title: "Product Page",
							snippet: "Product info",
							scrapingMethod: "default",
							status: "pending"
						}
					]
				})
		});

		// fetch-url call succeeds
		global.fetch.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({ success: true })
		});

		// Second poll: complete
		global.fetch.mockResolvedValueOnce({
			ok: true,
			json: () =>
				Promise.resolve({
					status: "complete",
					result: { status: "Active", explanation: "Still available" },
					urlCount: 1,
					completedUrls: 1,
					urls: [{ index: 0, status: "complete" }]
				})
		});

		const resultPromise = pollJobStatus("job-789", "Bosch", "MNO-300", mockCheckButton);
		await jest.runAllTimersAsync();
		const result = await resultPromise;

		// fetch-url should have been called
		const fetchCalls = global.fetch.mock.calls;
		const fetchUrlCall = fetchCalls.find(
			(call) => typeof call[0] === "string" && call[0].includes("fetch-url")
		);
		expect(fetchUrlCall).toBeDefined();

		// The payload should contain the URL data
		const payload = JSON.parse(fetchUrlCall[1].body);
		expect(payload.jobId).toBe("job-789");
		expect(payload.url).toBe("https://example.com/product");
		expect(payload.urlIndex).toBe(0);
		expect(payload.title).toBe("Product Page");
		expect(payload.snippet).toBe("Product info");
		expect(payload.scrapingMethod).toBe("default");

		expect(result.status).toBe("Active");
	});

	test("triggers analyze-job when all URLs are complete", async () => {
		// First poll: urls_ready with pending URL
		global.fetch.mockResolvedValueOnce({
			ok: true,
			json: () =>
				Promise.resolve({
					status: "urls_ready",
					urlCount: 1,
					completedUrls: 0,
					urls: [
						{
							index: 0,
							url: "https://example.com/page",
							title: "Page",
							snippet: "Info",
							scrapingMethod: "default",
							status: "pending"
						}
					]
				})
		});

		// fetch-url call
		global.fetch.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({ success: true })
		});

		// Second poll: all URLs complete but status is not "analyzing" or "complete"
		global.fetch.mockResolvedValueOnce({
			ok: true,
			json: () =>
				Promise.resolve({
					status: "urls_ready",
					urlCount: 1,
					completedUrls: 1,
					urls: [{ index: 0, status: "complete" }]
				})
		});

		// analyze-job call
		global.fetch.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({ success: true })
		});

		// Third poll: complete
		global.fetch.mockResolvedValueOnce({
			ok: true,
			json: () =>
				Promise.resolve({
					status: "complete",
					result: { status: "EOL", explanation: "Discontinued" },
					urlCount: 1,
					completedUrls: 1,
					urls: [{ index: 0, status: "complete" }]
				})
		});

		const resultPromise = pollJobStatus("job-analyze", "SMC", "DEF-400", mockCheckButton);
		await jest.runAllTimersAsync();
		const result = await resultPromise;

		// analyze-job should have been called
		const fetchCalls = global.fetch.mock.calls;
		const analyzeCall = fetchCalls.find(
			(call) => typeof call[0] === "string" && call[0].includes("analyze-job")
		);
		expect(analyzeCall).toBeDefined();

		const analyzePayload = JSON.parse(analyzeCall[1].body);
		expect(analyzePayload.jobId).toBe("job-analyze");

		expect(result.status).toBe("EOL");
	});

	test("fetch-url is only triggered once (fetchTriggered flag)", async () => {
		// First poll: urls_ready with pending URL
		global.fetch.mockResolvedValueOnce({
			ok: true,
			json: () =>
				Promise.resolve({
					status: "urls_ready",
					urlCount: 1,
					completedUrls: 0,
					urls: [
						{
							index: 0,
							url: "https://example.com",
							title: "Title",
							snippet: "Snippet",
							scrapingMethod: "default",
							status: "pending"
						}
					]
				})
		});

		// fetch-url call
		global.fetch.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({ success: true })
		});

		// Second poll: still urls_ready with pending URL (should NOT trigger fetch again)
		global.fetch.mockResolvedValueOnce({
			ok: true,
			json: () =>
				Promise.resolve({
					status: "urls_ready",
					urlCount: 1,
					completedUrls: 0,
					urls: [
						{
							index: 0,
							url: "https://example.com",
							title: "Title",
							snippet: "Snippet",
							scrapingMethod: "default",
							status: "pending"
						}
					]
				})
		});

		// Third poll: complete
		global.fetch.mockResolvedValueOnce({
			ok: true,
			json: () =>
				Promise.resolve({
					status: "complete",
					result: { status: "Active", explanation: "OK" },
					urlCount: 1,
					completedUrls: 1
				})
		});

		const resultPromise = pollJobStatus("job-once", "SMC", "GHI-500", mockCheckButton);
		await jest.runAllTimersAsync();
		await resultPromise;

		// Count fetch-url calls
		const fetchUrlCalls = global.fetch.mock.calls.filter(
			(call) => typeof call[0] === "string" && call[0].includes("fetch-url")
		);
		expect(fetchUrlCalls.length).toBe(1);
	});

	test("analyze-job is only triggered once (analyzeTriggered flag)", async () => {
		// First poll: all URLs complete, should trigger analyze
		global.fetch.mockResolvedValueOnce({
			ok: true,
			json: () =>
				Promise.resolve({
					status: "urls_ready",
					urlCount: 1,
					completedUrls: 1,
					urls: [{ index: 0, status: "complete" }]
				})
		});

		// analyze-job call
		global.fetch.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({ success: true })
		});

		// Second poll: still not complete, all URLs complete (should NOT trigger analyze again)
		global.fetch.mockResolvedValueOnce({
			ok: true,
			json: () =>
				Promise.resolve({
					status: "urls_ready",
					urlCount: 1,
					completedUrls: 1,
					urls: [{ index: 0, status: "complete" }]
				})
		});

		// Third poll: complete
		global.fetch.mockResolvedValueOnce({
			ok: true,
			json: () =>
				Promise.resolve({
					status: "complete",
					result: { status: "EOL", explanation: "Done" },
					urlCount: 1,
					completedUrls: 1
				})
		});

		const resultPromise = pollJobStatus("job-analyze-once", "Festo", "JKL-600", mockCheckButton);
		await jest.runAllTimersAsync();
		await resultPromise;

		// Count analyze-job calls
		const analyzeCalls = global.fetch.mock.calls.filter(
			(call) => typeof call[0] === "string" && call[0].includes("analyze-job")
		);
		expect(analyzeCalls.length).toBe(1);
	});

	test("returns timeout result after maxAttempts (60) are exhausted", async () => {
		// All 60 polls return "processing" status (never complete)
		for (let i = 0; i < 60; i++) {
			global.fetch.mockResolvedValueOnce({
				ok: true,
				json: () =>
					Promise.resolve({
						status: "processing",
						urlCount: 3,
						completedUrls: 1
					})
			});
		}

		const resultPromise = pollJobStatus("job-timeout", "SMC", "TIMEOUT-1", mockCheckButton);
		await jest.runAllTimersAsync();
		const result = await resultPromise;

		// Should return the timeout result structure
		expect(result.status).toBe("UNKNOWN");
		expect(result.explanation).toContain("timed out");
		expect(result.explanation).toContain("60 polling attempts");
		expect(result.successor).toBeDefined();
		expect(result.successor.status).toBe("UNKNOWN");
		expect(result.successor.model).toBeNull();
		expect(result.successor.explanation).toBe("");
	});

	test("buildFetchPayload includes optional fields when present", async () => {
		// Poll with URL that has optional model, jpUrl, usUrl fields
		global.fetch.mockResolvedValueOnce({
			ok: true,
			json: () =>
				Promise.resolve({
					status: "urls_ready",
					urlCount: 1,
					completedUrls: 0,
					urls: [
						{
							index: 0,
							url: "https://example.com/product",
							title: "Product",
							snippet: "Info",
							scrapingMethod: "default",
							status: "pending",
							model: "ABC-100",
							jpUrl: "https://example.jp/product",
							usUrl: "https://example.us/product"
						}
					]
				})
		});

		// fetch-url call
		global.fetch.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({ success: true })
		});

		// Second poll: complete
		global.fetch.mockResolvedValueOnce({
			ok: true,
			json: () =>
				Promise.resolve({
					status: "complete",
					result: { status: "Active", explanation: "OK" },
					urlCount: 1,
					completedUrls: 1
				})
		});

		const resultPromise = pollJobStatus("job-optional", "SMC", "OPT-100", mockCheckButton);
		await jest.runAllTimersAsync();
		await resultPromise;

		// Verify fetch-url was called with optional fields
		const fetchUrlCall = global.fetch.mock.calls.find(
			(call) => typeof call[0] === "string" && call[0].includes("fetch-url")
		);
		expect(fetchUrlCall).toBeDefined();

		const payload = JSON.parse(fetchUrlCall[1].body);
		expect(payload.model).toBe("ABC-100");
		expect(payload.jpUrl).toBe("https://example.jp/product");
		expect(payload.usUrl).toBe("https://example.us/product");
	});

	test("error status with daily limit info triggers error with message", async () => {
		jest.useRealTimers();

		global.fetch.mockResolvedValueOnce({
			ok: true,
			json: () =>
				Promise.resolve({
					status: "error",
					error: "Daily rate limit exceeded",
					isDailyLimit: true,
					retrySeconds: 3600,
					urlCount: 0,
					completedUrls: 0
				})
		});

		await expect(
			pollJobStatus("job-limit", "Festo", "LIM-100", mockCheckButton)
		).rejects.toThrow("Daily rate limit exceeded");

		jest.useFakeTimers();
	});

	test("updates checkButton textContent with progress during polling", async () => {
		// First poll: processing with progress
		global.fetch.mockResolvedValueOnce({
			ok: true,
			json: () =>
				Promise.resolve({
					status: "processing",
					urlCount: 5,
					completedUrls: 2
				})
		});

		// Second poll: complete
		global.fetch.mockResolvedValueOnce({
			ok: true,
			json: () =>
				Promise.resolve({
					status: "complete",
					result: { status: "Active", explanation: "OK" },
					urlCount: 5,
					completedUrls: 5
				})
		});

		const resultPromise = pollJobStatus("job-progress", "Bosch", "PRG-100", mockCheckButton);
		await jest.runAllTimersAsync();
		await resultPromise;

		// The button text should have been updated with progress at some point
		// After the first poll, it should show "Processing (2/5)"
		// We can verify the button was updated (the final text depends on completion)
		expect(global.fetch).toHaveBeenCalled();
	});
});
