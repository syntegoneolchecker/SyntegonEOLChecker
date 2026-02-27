/**
 * Extended tests for fire-and-forget.js
 * Covers: triggerFetchUrl deduplication logic, triggerAnalyzeJob, getInternalAuthHeaders
 * The base fire-and-forget.test.js covers fireAndForgetFetch core retry logic
 */

// Mock job-storage BEFORE requiring fire-and-forget
const mockGetJob = jest.fn();
jest.mock("../netlify/functions/lib/job-storage", () => ({
	getJob: mockGetJob
}));

jest.mock("../netlify/functions/lib/config", () => ({
	FIRE_AND_FORGET_MAX_RETRIES: 1,
	FIRE_AND_FORGET_RETRY_DELAY_MS: 10,
	FIRE_AND_FORGET_TIMEOUT_MS: 5000
}));

// Mock fetch globally
const originalFetch = global.fetch;

beforeEach(() => {
	jest.clearAllMocks();
	global.fetch = jest.fn().mockResolvedValue({ ok: true });
	delete process.env.INTERNAL_API_KEY;
	// Suppress logger noise
	jest.spyOn(console, "log").mockImplementation(() => {});
	jest.spyOn(console, "warn").mockImplementation(() => {});
	jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	global.fetch = originalFetch;
	jest.restoreAllMocks();
});

const {
	triggerFetchUrl,
	triggerAnalyzeJob,
	fireAndForgetFetch
} = require("../netlify/functions/lib/fire-and-forget");

describe("Fire and Forget - Extended", () => {
	describe("getInternalAuthHeaders", () => {
		test("should include INTERNAL_API_KEY when set", async () => {
			process.env.INTERNAL_API_KEY = "secret-internal-key";

			await triggerAnalyzeJob("http://base.com", "job-123");

			expect(global.fetch).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					headers: expect.objectContaining({
						"x-internal-key": "secret-internal-key",
						"Content-Type": "application/json"
					})
				})
			);
		});

		test("should not include x-internal-key when env var is not set", async () => {
			await triggerAnalyzeJob("http://base.com", "job-123");

			const headers = global.fetch.mock.calls[0][1].headers;
			expect(headers["x-internal-key"]).toBeUndefined();
			expect(headers["Content-Type"]).toBe("application/json");
		});
	});

	describe("triggerFetchUrl - deduplication", () => {
		test("should skip fetch when job not found", async () => {
			mockGetJob.mockResolvedValue(null);

			await triggerFetchUrl("http://base.com", {
				jobId: "job-missing",
				urlIndex: 0,
				url: "http://example.com"
			});

			// fetch should NOT be called (dedup skipped it)
			expect(global.fetch).not.toHaveBeenCalled();
		});

		test("should skip fetch when URL already complete", async () => {
			mockGetJob.mockResolvedValue({
				jobId: "job-123",
				urls: [{ index: 0, status: "complete", url: "http://example.com" }]
			});

			await triggerFetchUrl("http://base.com", {
				jobId: "job-123",
				urlIndex: 0,
				url: "http://example.com"
			});

			expect(global.fetch).not.toHaveBeenCalled();
		});

		test("should proceed with fetch when URL is pending", async () => {
			mockGetJob.mockResolvedValue({
				jobId: "job-123",
				urls: [{ index: 0, status: "pending", url: "http://example.com" }]
			});

			await triggerFetchUrl("http://base.com", {
				jobId: "job-123",
				urlIndex: 0,
				url: "http://example.com"
			});

			expect(global.fetch).toHaveBeenCalledWith(
				"http://base.com/.netlify/functions/fetch-url",
				expect.objectContaining({
					method: "POST"
				})
			);
		});

		test("should skip fetch when URL index not found in job", async () => {
			mockGetJob.mockResolvedValue({
				jobId: "job-123",
				urls: [{ index: 0, status: "pending", url: "http://example.com" }]
			});

			await triggerFetchUrl("http://base.com", {
				jobId: "job-123",
				urlIndex: 5, // index 5 doesn't exist
				url: "http://other.com"
			});

			expect(global.fetch).not.toHaveBeenCalled();
		});

		test("should proceed with fetch when dedup status check fails", async () => {
			// getJob throws an error — should still proceed (fail-open)
			mockGetJob.mockRejectedValue(new Error("Storage unavailable"));

			await triggerFetchUrl("http://base.com", {
				jobId: "job-123",
				urlIndex: 0,
				url: "http://example.com"
			});

			// Should proceed despite status check failure
			expect(global.fetch).toHaveBeenCalled();
		});

		test("should handle job with empty urls array", async () => {
			mockGetJob.mockResolvedValue({
				jobId: "job-123",
				urls: []
			});

			await triggerFetchUrl("http://base.com", {
				jobId: "job-123",
				urlIndex: 0,
				url: "http://example.com"
			});

			// URL at index 0 doesn't exist in empty array
			expect(global.fetch).not.toHaveBeenCalled();
		});

		test("should handle job with undefined urls", async () => {
			mockGetJob.mockResolvedValue({
				jobId: "job-123"
				// urls is undefined
			});

			await triggerFetchUrl("http://base.com", {
				jobId: "job-123",
				urlIndex: 0,
				url: "http://example.com"
			});

			// Should not crash, URL not found
			expect(global.fetch).not.toHaveBeenCalled();
		});
	});

	describe("triggerAnalyzeJob", () => {
		test("should call correct URL with jobId payload", async () => {
			await triggerAnalyzeJob("http://base.com", "job-456");

			expect(global.fetch).toHaveBeenCalledWith(
				"http://base.com/.netlify/functions/analyze-job",
				expect.objectContaining({
					method: "POST",
					body: JSON.stringify({ jobId: "job-456" })
				})
			);
		});
	});

	describe("fireAndForgetFetch - additional coverage", () => {
		test("should use config defaults when no config provided", async () => {
			global.fetch.mockResolvedValue({ ok: true });

			await fireAndForgetFetch("http://test.com", { method: "GET" });

			expect(global.fetch).toHaveBeenCalledTimes(1);
		});

		test("should include AbortSignal.timeout in fetch options", async () => {
			global.fetch.mockResolvedValue({ ok: true });

			await fireAndForgetFetch("http://test.com", { method: "POST" });

			const callOptions = global.fetch.mock.calls[0][1];
			expect(callOptions.signal).toBeDefined();
		});
	});
});
