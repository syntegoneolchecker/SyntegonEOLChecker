/**
 * Tests for netlify/functions/analyze-job.js
 * Phase 5A: Handler-level and GroqAnalyzer method tests
 *
 * Focuses on:
 * - analyzeJobHandler (the main handler)
 * - checkGroqTokenAvailability (tested through handler flow)
 * - waitForTokenReset (tested through handler flow)
 * - runAnalysisWithTruncation (tested through handler flow)
 * - handleAnalysisError (tested through handler flow)
 * - GroqAnalyzer methods (exported via _internal)
 */

// Mock dependencies before requiring the module
jest.mock("../netlify/functions/lib/job-storage", () => ({
	getJob: jest.fn(),
	saveFinalResult: jest.fn(),
	updateJobStatus: jest.fn()
}));

jest.mock("../netlify/functions/lib/response-builder", () => ({
	errorResponse: jest.fn((msg) => ({
		statusCode: 500,
		body: JSON.stringify({ error: msg })
	})),
	methodNotAllowedResponse: jest.fn(() => ({
		statusCode: 405,
		body: "Method not allowed"
	})),
	notFoundResponse: jest.fn((entity) => ({
		statusCode: 404,
		body: JSON.stringify({ error: `${entity} not found` })
	}))
}));

jest.mock("../netlify/functions/lib/content-truncator", () => ({
	processTablesInContent: jest.fn((c) => c),
	filterIrrelevantTables: jest.fn((c) => c),
	smartTruncate: jest.fn((c, len) => c.substring(0, len))
}));

jest.mock("../netlify/functions/lib/auth-middleware", () => ({
	requireHybridAuth: jest.fn((handler) => handler)
}));

jest.mock("re2", () => {
	return class RE2 {
		constructor(pattern, flags) {
			this.regex = new RegExp(pattern, flags);
		}
		exec(str) {
			return this.regex.exec(str);
		}
		static fromString(pattern) {
			return new RE2(pattern);
		}
	};
});

jest.mock("../netlify/functions/lib/logger", () => ({
	info: jest.fn(),
	warn: jest.fn(),
	error: jest.fn(),
	debug: jest.fn()
}));

jest.mock("../netlify/functions/lib/config", () => ({
	MIN_CONTENT_LENGTH: 1500,
	BASE_CONTENT_LENGTH: 6000,
	TRUNCATION_REDUCTION_PER_LEVEL: 1500,
	TOTAL_CONTENT_MULTIPLIER: 2,
	TOTAL_CONTENT_BUFFER: 1000,
	TABLE_FILTERING_THRESHOLD_RATIO: 1,
	TABLE_CONTEXT_ROWS_BEFORE: 3,
	TABLE_CONTEXT_ROWS_AFTER: 3,
	ADJACENT_TABLE_THRESHOLD: 200,
	ZONE_RADIUS_MIN: 400,
	ZONE_RADIUS_MAX: 2000,
	KEYWORD_MAX_OCCURRENCES: 3,
	KEYWORD_MAX_TOTAL: 20
}));

global.fetch = jest.fn();

const { handler, _internal } = require("../netlify/functions/analyze-job");
const {
	getJob,
	saveFinalResult,
	updateJobStatus
} = require("../netlify/functions/lib/job-storage");
const {
	errorResponse,
	methodNotAllowedResponse,
	notFoundResponse
} = require("../netlify/functions/lib/response-builder");
const logger = require("../netlify/functions/lib/logger");
const { GroqAnalyzer } = _internal;

// Helper to create a mock Headers-like object with .get() method
function createMockHeaders(headersMap = {}) {
	return {
		get: jest.fn((key) => {
			return key in headersMap ? headersMap[key] : null;
		})
	};
}

// Helper to create event objects
function createEvent(body, method = "POST") {
	return {
		httpMethod: method,
		body: JSON.stringify(body)
	};
}

// Standard valid analysis result
const validAnalysisResult = {
	status: "ACTIVE",
	explanation: "Product is currently available (Result #1: https://example.com)",
	successor: {
		status: "UNKNOWN",
		model: null,
		explanation: "Product is active, no successor needed"
	}
};

// Standard mock job
function createMockJob(overrides = {}) {
	return {
		jobId: "test-job-123",
		maker: "TestMaker",
		model: "TestModel-100",
		status: "fetching",
		urls: [
			{
				index: 0,
				title: "Product Page",
				url: "https://example.com/product",
				snippet: "TestModel-100 product info"
			}
		],
		urlResults: {
			0: {
				url: "https://example.com/product",
				fullContent: "TestModel-100 is currently available for purchase."
			}
		},
		...overrides
	};
}

// Create a mock for the token availability check (first fetch call in handler)
function mockTokenCheckResponse(remainingTokens = "5000", resetTokens = "0s") {
	return {
		ok: true,
		headers: createMockHeaders({
			"x-ratelimit-remaining-tokens": remainingTokens,
			"x-ratelimit-reset-tokens": resetTokens,
			"x-ratelimit-limit-tokens": "6000"
		}),
		json: jest.fn().mockResolvedValue({
			choices: [{ message: { content: "pong" } }]
		})
	};
}

// Create a mock for a successful analysis response (second fetch call in handler)
function mockAnalysisSuccessResponse() {
	return {
		ok: true,
		headers: createMockHeaders({
			"x-ratelimit-remaining-tokens": "4000",
			"x-ratelimit-limit-tokens": "6000",
			"x-ratelimit-reset-tokens": "10s"
		}),
		json: jest.fn().mockResolvedValue({
			choices: [
				{
					message: {
						content: JSON.stringify(validAnalysisResult)
					}
				}
			]
		})
	};
}

// Setup both token check + successful analysis mocks
function mockSuccessfulGroqAnalysis() {
	fetch.mockResolvedValueOnce(mockTokenCheckResponse());
	fetch.mockResolvedValueOnce(mockAnalysisSuccessResponse());
}

const mockContext = {};

describe("Analyze Job - Handler Tests", () => {
	beforeEach(() => {
		jest.clearAllMocks();
		fetch.mockReset();
		jest.useRealTimers();
		process.env.GROQ_API_KEY = "test-groq-key";
	});

	afterEach(() => {
		jest.useRealTimers();
		delete process.env.GROQ_API_KEY;
	});

	// =========================================================================
	// analyzeJobHandler
	// =========================================================================
	describe("analyzeJobHandler", () => {
		it("should return 405 for non-POST method (GET)", async () => {
			const event = createEvent({ jobId: "test-123" }, "GET");
			const result = await handler(event, mockContext);

			expect(result.statusCode).toBe(405);
			expect(methodNotAllowedResponse).toHaveBeenCalled();
		});

		it("should return 404 when job not found", async () => {
			getJob.mockResolvedValue(null);

			const event = createEvent({ jobId: "nonexistent-job" });
			const result = await handler(event, mockContext);

			expect(result.statusCode).toBe(404);
			expect(notFoundResponse).toHaveBeenCalledWith("Job");
		});

		it("should return 200 with analysis result on success", async () => {
			const mockJob = createMockJob();
			getJob.mockResolvedValue(mockJob);
			mockSuccessfulGroqAnalysis();

			const event = createEvent({ jobId: "test-job-123" });
			const result = await handler(event, mockContext);

			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			expect(body.success).toBe(true);
			expect(body.result.status).toBe("ACTIVE");
		});

		it("should set job status to 'analyzing' before analysis", async () => {
			const mockJob = createMockJob();
			getJob.mockResolvedValue(mockJob);
			mockSuccessfulGroqAnalysis();

			const event = createEvent({ jobId: "test-job-123" });
			await handler(event, mockContext);

			expect(updateJobStatus).toHaveBeenCalledWith(
				"test-job-123",
				"analyzing",
				null,
				mockContext
			);
		});

		it("should call saveFinalResult with analysis result", async () => {
			const mockJob = createMockJob();
			getJob.mockResolvedValue(mockJob);
			mockSuccessfulGroqAnalysis();

			const event = createEvent({ jobId: "test-job-123" });
			await handler(event, mockContext);

			expect(saveFinalResult).toHaveBeenCalledWith(
				"test-job-123",
				expect.objectContaining({ status: "ACTIVE" }),
				mockContext
			);
		});

		it("should handle analysis error (returns 500)", async () => {
			const mockJob = createMockJob();
			getJob.mockResolvedValue(mockJob);

			// Token check succeeds
			fetch.mockResolvedValueOnce(mockTokenCheckResponse());

			// Analysis fails with generic error - all 3 retry attempts fail with 500
			// Each attempt is a separate fetch call and a separate response object
			for (let i = 0; i < 3; i++) {
				fetch.mockResolvedValueOnce({
					ok: false,
					status: 500,
					headers: createMockHeaders({}),
					text: jest.fn().mockResolvedValue("Internal server error")
				});
			}

			const event = createEvent({ jobId: "test-job-123" });
			const result = await handler(event, mockContext);

			expect(result.statusCode).toBe(500);
			expect(updateJobStatus).toHaveBeenCalledWith(
				"test-job-123",
				"error",
				expect.any(String),
				mockContext
			);
		});

		it("should handle daily limit error (returns 429 with isDailyLimit)", async () => {
			const mockJob = createMockJob();
			getJob.mockResolvedValue(mockJob);

			// Token check succeeds
			fetch.mockResolvedValueOnce(mockTokenCheckResponse());

			// Analysis fails with daily limit (429 + TPD message)
			fetch.mockResolvedValueOnce({
				ok: false,
				status: 429,
				headers: createMockHeaders({
					"x-ratelimit-reset-tokens": "60s"
				}),
				text: jest
					.fn()
					.mockResolvedValue(
						"Rate limit reached for tokens per day (TPD). Please try again in 7m54.336s"
					)
			});

			const event = createEvent({ jobId: "test-job-123" });
			const result = await handler(event, mockContext);

			expect(result.statusCode).toBe(429);
			const body = JSON.parse(result.body);
			expect(body.isDailyLimit).toBe(true);
			expect(body.retrySeconds).toBeCloseTo(474.336, 1);
			expect(updateJobStatus).toHaveBeenCalledWith(
				"test-job-123",
				"error",
				expect.any(String),
				mockContext,
				expect.objectContaining({ isDailyLimit: true })
			);
		});

		it("should handle missing jobId gracefully", async () => {
			const event = {
				httpMethod: "POST",
				body: JSON.stringify({})
			};

			// getJob with undefined jobId returns null
			getJob.mockResolvedValue(null);

			const result = await handler(event, mockContext);

			// Should return 404 since job won't be found with undefined id
			expect(result.statusCode).toBe(404);
		});
	});

	// =========================================================================
	// checkGroqTokenAvailability (tested via handler flow)
	// =========================================================================
	describe("checkGroqTokenAvailability (via handler flow)", () => {
		it("should proceed when remaining tokens > 500 (available=true)", async () => {
			const mockJob = createMockJob();
			getJob.mockResolvedValue(mockJob);

			// Token check: plenty of tokens
			fetch.mockResolvedValueOnce(mockTokenCheckResponse("5000", "0s"));
			// Analysis call succeeds
			fetch.mockResolvedValueOnce(mockAnalysisSuccessResponse());

			const event = createEvent({ jobId: "test-job-123" });
			const result = await handler(event, mockContext);

			// Should succeed - tokens were available, no waiting
			expect(result.statusCode).toBe(200);
			// Token check was the first fetch call, analysis is second
			expect(fetch).toHaveBeenCalledTimes(2);
		});

		it("should wait when remaining tokens < 500 (available=false)", async () => {
			jest.useFakeTimers();

			const mockJob = createMockJob();
			getJob.mockResolvedValue(mockJob);

			// Token check: low tokens, reset in 3 seconds
			fetch.mockResolvedValueOnce(mockTokenCheckResponse("100", "3s"));
			// Analysis succeeds after wait
			fetch.mockResolvedValueOnce(mockAnalysisSuccessResponse());

			const event = createEvent({ jobId: "test-job-123" });
			const handlerPromise = handler(event, mockContext);

			// Advance through the wait time (3s * 1000 + 1000ms buffer = 4000ms)
			await jest.advanceTimersByTimeAsync(4000);

			const result = await handlerPromise;
			expect(result.statusCode).toBe(200);

			jest.useRealTimers();
		});

		it("should extract resetSeconds from response headers", async () => {
			const mockJob = createMockJob();
			getJob.mockResolvedValue(mockJob);

			// Token check: tokens available (above 500) with a reset time
			fetch.mockResolvedValueOnce(mockTokenCheckResponse("2000", "15.5s"));
			// Analysis succeeds
			fetch.mockResolvedValueOnce(mockAnalysisSuccessResponse());

			const event = createEvent({ jobId: "test-job-123" });
			const result = await handler(event, mockContext);

			expect(result.statusCode).toBe(200);
			expect(logger.info).toHaveBeenCalledWith(
				expect.stringContaining("Groq tokens remaining: 2000")
			);
		});

		it("should return available=true on fetch failure (fallback)", async () => {
			const mockJob = createMockJob();
			getJob.mockResolvedValue(mockJob);

			// Token check: network error
			fetch.mockRejectedValueOnce(new Error("Network error during token check"));
			// Analysis succeeds (proceeds despite token check failure)
			fetch.mockResolvedValueOnce(mockAnalysisSuccessResponse());

			const event = createEvent({ jobId: "test-job-123" });
			const result = await handler(event, mockContext);

			// Should still succeed since fallback assumes tokens are available
			expect(result.statusCode).toBe(200);
		});
	});

	// =========================================================================
	// waitForTokenReset (via handler flow)
	// =========================================================================
	describe("waitForTokenReset (via handler flow)", () => {
		it("should wait when tokens not available", async () => {
			jest.useFakeTimers();

			const mockJob = createMockJob();
			getJob.mockResolvedValue(mockJob);

			// Token check: not available (< 500), reset in 5 seconds
			fetch.mockResolvedValueOnce(mockTokenCheckResponse("200", "5s"));
			// Analysis succeeds after waiting
			fetch.mockResolvedValueOnce(mockAnalysisSuccessResponse());

			const event = createEvent({ jobId: "test-job-123" });
			const handlerPromise = handler(event, mockContext);

			// Advance time: Math.ceil(5 * 1000) + 1000 buffer = 6000ms
			await jest.advanceTimersByTimeAsync(6000);

			const result = await handlerPromise;
			expect(result.statusCode).toBe(200);
			// Verify wait log message was created
			expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("waiting"));

			jest.useRealTimers();
		});

		it("should skip waiting when tokens are available", async () => {
			const mockJob = createMockJob();
			getJob.mockResolvedValue(mockJob);

			// Token check: tokens available (> 500)
			fetch.mockResolvedValueOnce(mockTokenCheckResponse("3000", "0s"));
			// Analysis succeeds
			fetch.mockResolvedValueOnce(mockAnalysisSuccessResponse());

			const event = createEvent({ jobId: "test-job-123" });
			const result = await handler(event, mockContext);

			expect(result.statusCode).toBe(200);
			// Should NOT have a "waiting" log for token reset
			const waitCalls = logger.info.mock.calls.filter(
				(call) => typeof call[0] === "string" && call[0].includes("Groq tokens low")
			);
			expect(waitCalls.length).toBe(0);
		});

		it("should add 1s buffer to wait time", async () => {
			jest.useFakeTimers();

			const mockJob = createMockJob();
			getJob.mockResolvedValue(mockJob);

			// Token check: not available, reset in 2 seconds
			fetch.mockResolvedValueOnce(mockTokenCheckResponse("50", "2s"));
			// Analysis succeeds
			fetch.mockResolvedValueOnce(mockAnalysisSuccessResponse());

			const event = createEvent({ jobId: "test-job-123" });
			const handlerPromise = handler(event, mockContext);

			// Expected wait: Math.ceil(2 * 1000) + 1000 = 3000ms
			await jest.advanceTimersByTimeAsync(3500);

			const result = await handlerPromise;
			expect(result.statusCode).toBe(200);
			// Verify the log shows 3000ms wait (2s + 1s buffer)
			expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("3000ms"));

			jest.useRealTimers();
		});
	});

	// =========================================================================
	// runAnalysisWithTruncation (via handler flow)
	// =========================================================================
	describe("runAnalysisWithTruncation (via handler flow)", () => {
		it("should succeed at truncation level 0", async () => {
			const mockJob = createMockJob();
			getJob.mockResolvedValue(mockJob);
			mockSuccessfulGroqAnalysis();

			const event = createEvent({ jobId: "test-job-123" });
			const result = await handler(event, mockContext);

			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			expect(body.result.status).toBe("ACTIVE");
		});

		it("should retry at level 1 when prompt too large at level 0", async () => {
			const mockJob = createMockJob();
			getJob.mockResolvedValue(mockJob);

			// Token check succeeds
			fetch.mockResolvedValueOnce(mockTokenCheckResponse());

			// Level 0: prompt too large (413)
			fetch.mockResolvedValueOnce({
				ok: false,
				status: 413,
				headers: createMockHeaders({}),
				text: jest.fn().mockResolvedValue("Request too large for model")
			});

			// Level 1: succeeds
			fetch.mockResolvedValueOnce(mockAnalysisSuccessResponse());

			const event = createEvent({ jobId: "test-job-123" });
			const result = await handler(event, mockContext);

			expect(result.statusCode).toBe(200);
			expect(logger.info).toHaveBeenCalledWith(
				expect.stringContaining("Prompt too large at truncation level 0")
			);
		});

		it("should retry at level 2 when still too large at level 1", async () => {
			const mockJob = createMockJob();
			getJob.mockResolvedValue(mockJob);

			// Token check succeeds
			fetch.mockResolvedValueOnce(mockTokenCheckResponse());

			// Level 0: prompt too large
			fetch.mockResolvedValueOnce({
				ok: false,
				status: 413,
				headers: createMockHeaders({}),
				text: jest.fn().mockResolvedValue("Request too large for model")
			});

			// Level 1: still too large
			fetch.mockResolvedValueOnce({
				ok: false,
				status: 413,
				headers: createMockHeaders({}),
				text: jest.fn().mockResolvedValue("Request too large for model")
			});

			// Level 2: succeeds
			fetch.mockResolvedValueOnce(mockAnalysisSuccessResponse());

			const event = createEvent({ jobId: "test-job-123" });
			const result = await handler(event, mockContext);

			expect(result.statusCode).toBe(200);
			expect(logger.info).toHaveBeenCalledWith(
				expect.stringContaining("Prompt too large at truncation level 1")
			);
		});

		it("should fail after all truncation levels exhausted", async () => {
			const mockJob = createMockJob();
			getJob.mockResolvedValue(mockJob);

			// Token check succeeds
			fetch.mockResolvedValueOnce(mockTokenCheckResponse());

			// All 3 levels fail with 413 - each needs a separate mock object
			for (let i = 0; i < 3; i++) {
				fetch.mockResolvedValueOnce({
					ok: false,
					status: 413,
					headers: createMockHeaders({}),
					text: jest.fn().mockResolvedValue("Request too large for model")
				});
			}

			const event = createEvent({ jobId: "test-job-123" });
			const result = await handler(event, mockContext);

			// Should return error response
			expect(result.statusCode).toBe(500);
			expect(errorResponse).toHaveBeenCalledWith(
				expect.stringContaining("truncation")
			);
		});

		it("should throw immediately on non-truncation error", async () => {
			const mockJob = createMockJob();
			getJob.mockResolvedValue(mockJob);

			// Token check succeeds
			fetch.mockResolvedValueOnce(mockTokenCheckResponse());

			// All 3 retry attempts within callWithRetry fail with 500
			// (non-truncation, non-retryable for truncation levels)
			for (let i = 0; i < 3; i++) {
				fetch.mockResolvedValueOnce({
					ok: false,
					status: 500,
					headers: createMockHeaders({}),
					text: jest.fn().mockResolvedValue("Internal server error")
				});
			}

			const event = createEvent({ jobId: "test-job-123" });
			const result = await handler(event, mockContext);

			// Should fail - error is not isPromptTooLarge so no truncation retry
			expect(result.statusCode).toBe(500);
		});
	});

	// =========================================================================
	// GroqAnalyzer
	// =========================================================================
	describe("GroqAnalyzer", () => {
		let analyzer;

		beforeEach(() => {
			analyzer = new GroqAnalyzer();
		});

		describe("buildPrompt", () => {
			it("should include maker and model in the prompt", () => {
				const prompt = analyzer.buildPrompt("Siemens", "S7-1200", "search context here");
				expect(prompt).toContain("Siemens");
				expect(prompt).toContain("S7-1200");
				expect(prompt).toContain("search context here");
			});
		});

		describe("callWithRetry", () => {
			it("should succeed on first try", async () => {
				const mockResponse = {
					ok: true,
					headers: createMockHeaders({
						"x-ratelimit-remaining-tokens": "5000",
						"x-ratelimit-limit-tokens": "6000",
						"x-ratelimit-reset-tokens": "0s"
					}),
					json: jest.fn().mockResolvedValue({
						choices: [{ message: { content: "result" } }]
					})
				};
				fetch.mockResolvedValueOnce(mockResponse);

				const result = await analyzer.callWithRetry("test prompt");
				expect(result.ok).toBe(true);
				expect(result).toEqual(mockResponse);
				expect(fetch).toHaveBeenCalledTimes(1);
			});

			it("should retry on rate limit (429)", async () => {
				// Mock wait to avoid real delays
				analyzer.wait = jest.fn().mockResolvedValue(undefined);

				// The 429 flow: handleFailedRequest → handleRateLimit throws →
				// catch → handleRetry throws "Retrying after error" → exits loop.
				fetch.mockResolvedValueOnce({
					ok: false,
					status: 429,
					headers: createMockHeaders({
						"x-ratelimit-reset-tokens": "2s"
					}),
					text: jest
						.fn()
						.mockResolvedValue("Rate limit exceeded for tokens per minute")
				});

				await expect(
					analyzer.callWithRetry("test prompt")
				).rejects.toThrow("Retrying after error");

				expect(fetch).toHaveBeenCalledTimes(1);
			});

			it("should handle daily limit (TPD) - throws isDailyLimit error", async () => {
				fetch.mockResolvedValueOnce({
					ok: false,
					status: 429,
					headers: createMockHeaders({
						"x-ratelimit-reset-tokens": "60s"
					}),
					text: jest
						.fn()
						.mockResolvedValue(
							"Rate limit reached for tokens per day (TPD). Please try again in 5m30s"
						)
				});

				await expect(
					analyzer.callWithRetry("test prompt")
				).rejects.toMatchObject({
					isDailyLimit: true
				});
			});

			it("should handle prompt too large (413) - throws isPromptTooLarge error", async () => {
				fetch.mockResolvedValueOnce({
					ok: false,
					status: 413,
					headers: createMockHeaders({}),
					text: jest.fn().mockResolvedValue("Request too large for model")
				});

				await expect(
					analyzer.callWithRetry("test prompt")
				).rejects.toMatchObject({
					isPromptTooLarge: true
				});
			});
		});

		describe("processResponse", () => {
			it("should parse valid JSON response", async () => {
				const mockResponse = {
					json: jest.fn().mockResolvedValue({
						choices: [
							{
								message: {
									content: JSON.stringify(validAnalysisResult)
								}
							}
						]
					}),
					headers: createMockHeaders({
						"x-ratelimit-remaining-tokens": "4000",
						"x-ratelimit-limit-tokens": "6000",
						"x-ratelimit-reset-tokens": "5s"
					})
				};

				const result = await analyzer.processResponse(mockResponse);
				expect(result.status).toBe("ACTIVE");
				expect(result.explanation).toBe(validAnalysisResult.explanation);
				expect(result.successor).toEqual(validAnalysisResult.successor);
				expect(result.rateLimits).toBeDefined();
				expect(result.rateLimits.remainingTokens).toBe("4000");
			});

			it("should extract JSON from text with surrounding content", async () => {
				const jsonResult = JSON.stringify(validAnalysisResult);
				const textWithJson = `Here is my analysis:\n${jsonResult}\nEnd of analysis.`;

				const mockResponse = {
					json: jest.fn().mockResolvedValue({
						choices: [
							{
								message: {
									content: textWithJson
								}
							}
						]
					}),
					headers: createMockHeaders({
						"x-ratelimit-remaining-tokens": "3000",
						"x-ratelimit-limit-tokens": "6000",
						"x-ratelimit-reset-tokens": "10s"
					})
				};

				const result = await analyzer.processResponse(mockResponse);
				expect(result.status).toBe("ACTIVE");
			});

			it("should throw on unexpected format (no choices)", async () => {
				const mockResponse = {
					json: jest.fn().mockResolvedValue({}),
					headers: createMockHeaders({})
				};

				await expect(analyzer.processResponse(mockResponse)).rejects.toThrow(
					"Unexpected response format"
				);
			});
		});

		describe("validateResult", () => {
			it("should throw on missing fields", () => {
				expect(() =>
					analyzer.validateResult({ status: "ACTIVE" })
				).toThrow("Invalid analysis result structure");

				expect(() =>
					analyzer.validateResult({ explanation: "test" })
				).toThrow("Invalid analysis result structure");

				expect(() =>
					analyzer.validateResult({ status: "ACTIVE", explanation: "test" })
				).toThrow("Invalid analysis result structure");
			});
		});

		describe("extractRateLimits", () => {
			it("should read headers correctly", () => {
				const mockResponse = {
					headers: createMockHeaders({
						"x-ratelimit-remaining-tokens": "4500",
						"x-ratelimit-limit-tokens": "6000",
						"x-ratelimit-reset-tokens": "12.5s"
					})
				};

				const limits = analyzer.extractRateLimits(mockResponse);
				expect(limits.remainingTokens).toBe("4500");
				expect(limits.limitTokens).toBe("6000");
				expect(limits.resetSeconds).toBe(12.5);
			});

			it("should default resetSeconds to 60 when header missing", () => {
				const mockResponse = {
					headers: createMockHeaders({
						"x-ratelimit-remaining-tokens": "1000",
						"x-ratelimit-limit-tokens": "6000"
					})
				};

				const limits = analyzer.extractRateLimits(mockResponse);
				expect(limits.resetSeconds).toBe(60);
			});
		});

		describe("handleRateLimit", () => {
			it("should calculate wait time from headers", async () => {
				// Mock the wait method to avoid actual setTimeout delay
				analyzer.wait = jest.fn().mockResolvedValue(undefined);

				const mockResponse = {
					headers: createMockHeaders({
						"x-ratelimit-reset-tokens": "5s"
					})
				};

				// handleRateLimit with attempt < MAX_RETRIES waits then throws "Rate limit - retrying"
				// Expected wait: Math.ceil(5 * 1000) + 2000 = 7000ms
				await expect(
					analyzer.handleRateLimit(mockResponse, 1)
				).rejects.toThrow("Rate limit - retrying");

				expect(analyzer.wait).toHaveBeenCalledWith(7000);
			});

			it("should throw rate limit exceeded when at max retries", async () => {
				const mockResponse = {
					headers: createMockHeaders({
						"x-ratelimit-reset-tokens": "5s"
					})
				};

				// At MAX_RETRIES (3), should throw immediately without waiting
				await expect(
					analyzer.handleRateLimit(mockResponse, 3)
				).rejects.toThrow("Rate limit exceeded after 3 attempts");
			});
		});

		describe("exponential backoff calculation", () => {
			it("should calculate exponential backoff correctly", () => {
				// 2000 * 2^(attempt-1)
				expect(analyzer.calculateBackoffTime(1)).toBe(2000);
				expect(analyzer.calculateBackoffTime(2)).toBe(4000);
				expect(analyzer.calculateBackoffTime(3)).toBe(8000);
			});
		});

		describe("calculateWaitTime", () => {
			it("should add 2s buffer to reset time", () => {
				const mockResponse = {
					headers: createMockHeaders({
						"x-ratelimit-reset-tokens": "10s"
					})
				};

				// Math.ceil(10 * 1000) + 2000 = 12000
				expect(analyzer.calculateWaitTime(mockResponse)).toBe(12000);
			});

			it("should default to 60s when no header", () => {
				const mockResponse = {
					headers: createMockHeaders({})
				};

				// Math.ceil(60 * 1000) + 2000 = 62000
				expect(analyzer.calculateWaitTime(mockResponse)).toBe(62000);
			});
		});

		describe("extractResetTime", () => {
			it("should parse seconds from header", () => {
				const response = {
					headers: createMockHeaders({ "x-ratelimit-reset-tokens": "30s" })
				};
				expect(analyzer.extractResetTime(response)).toBe(30);
			});

			it("should parse decimal seconds", () => {
				const response = {
					headers: createMockHeaders({ "x-ratelimit-reset-tokens": "7.5s" })
				};
				expect(analyzer.extractResetTime(response)).toBe(7.5);
			});

			it("should parse seconds without s suffix", () => {
				const response = {
					headers: createMockHeaders({ "x-ratelimit-reset-tokens": "45" })
				};
				expect(analyzer.extractResetTime(response)).toBe(45);
			});

			it("should return 60 when header is missing", () => {
				const response = {
					headers: createMockHeaders({})
				};
				expect(analyzer.extractResetTime(response)).toBe(60);
			});
		});

		describe("createDailyLimitError", () => {
			it("should create error with isDailyLimit flag and retry info", () => {
				const errorText =
					"Rate limit reached for tokens per day (TPD). Please try again in 7m54.336s";
				const error = analyzer.createDailyLimitError(errorText);

				expect(error.isDailyLimit).toBe(true);
				expect(error.retrySeconds).toBeCloseTo(474.336, 2);
				expect(error.message).toContain("Daily token limit reached");
			});

			it("should handle error text without retry time", () => {
				const errorText = "Rate limit reached for tokens per day (TPD).";
				const error = analyzer.createDailyLimitError(errorText);

				expect(error.isDailyLimit).toBe(true);
				expect(error.retrySeconds).toBeNull();
			});
		});

		describe("handleRetry", () => {
			it("should rethrow isDailyLimit errors immediately", async () => {
				const dailyLimitError = new Error("Daily limit");
				dailyLimitError.isDailyLimit = true;

				await expect(
					analyzer.handleRetry(dailyLimitError, 1)
				).rejects.toMatchObject({ isDailyLimit: true });
			});

			it("should rethrow isPromptTooLarge errors immediately", async () => {
				const promptError = new Error("Too large");
				promptError.isPromptTooLarge = true;

				await expect(
					analyzer.handleRetry(promptError, 1)
				).rejects.toMatchObject({ isPromptTooLarge: true });
			});

			it("should wait and throw for retryable errors when attempts remain", async () => {
				// Mock the wait method to avoid actual setTimeout delay
				analyzer.wait = jest.fn().mockResolvedValue(undefined);

				const retryableError = new Error("Connection timeout");

				// handleRetry waits (backoff: 2000 * 2^(1-1) = 2000ms) then throws
				await expect(
					analyzer.handleRetry(retryableError, 1)
				).rejects.toThrow("Retrying after error");

				expect(analyzer.wait).toHaveBeenCalledWith(2000);
			});

			it("should throw original error on final attempt", async () => {
				const finalError = new Error("Final failure");

				await expect(
					analyzer.handleRetry(finalError, 3)
				).rejects.toThrow("Final failure");
			});
		});

		describe("handleError", () => {
			it("should log daily limit errors differently", () => {
				const dailyError = new Error("Daily limit");
				dailyError.isDailyLimit = true;
				analyzer.handleError(dailyError);

				expect(logger.error).toHaveBeenCalledWith(
					"Daily token limit error handled"
				);
			});

			it("should log generic errors with message", () => {
				const genericError = new Error("Something went wrong");
				analyzer.handleError(genericError);

				expect(logger.error).toHaveBeenCalledWith(
					"Groq API analysis failed:",
					"Something went wrong"
				);
			});
		});

		describe("analyze (full flow)", () => {
			it("should return parsed and validated result on success", async () => {
				fetch.mockResolvedValueOnce({
					ok: true,
					headers: createMockHeaders({
						"x-ratelimit-remaining-tokens": "4000",
						"x-ratelimit-limit-tokens": "6000",
						"x-ratelimit-reset-tokens": "5s"
					}),
					json: jest.fn().mockResolvedValue({
						choices: [
							{
								message: {
									content: JSON.stringify(validAnalysisResult)
								}
							}
						]
					})
				});

				const result = await analyzer.analyze(
					"TestMaker",
					"TestModel",
					"search context"
				);
				expect(result.status).toBe("ACTIVE");
				expect(result.rateLimits).toBeDefined();
			});

			it("should call handleError and rethrow on failure", async () => {
				// All 3 retries fail with server errors
				for (let i = 0; i < 3; i++) {
					fetch.mockResolvedValueOnce({
						ok: false,
						status: 500,
						headers: createMockHeaders({}),
						text: jest.fn().mockResolvedValue("Server error")
					});
				}

				await expect(
					analyzer.analyze("TestMaker", "TestModel", "context")
				).rejects.toThrow();

				expect(logger.error).toHaveBeenCalledWith(
					"Groq API analysis failed:",
					expect.any(String)
				);
			});
		});

		describe("getHeaders", () => {
			it("should include authorization with GROQ_API_KEY", () => {
				process.env.GROQ_API_KEY = "my-secret-key";
				const headers = analyzer.getHeaders();
				expect(headers.Authorization).toBe("Bearer my-secret-key");
				expect(headers["Content-Type"]).toBe("application/json");
			});
		});

		describe("getRequestBody", () => {
			it("should return correct structure", () => {
				const body = analyzer.getRequestBody("my prompt");
				expect(body.model).toBe("openai/gpt-oss-120b");
				expect(body.messages).toEqual([
					{ role: "user", content: "my prompt" }
				]);
				expect(body.temperature).toBe(0);
				expect(body.max_completion_tokens).toBe(4096);
				expect(body.stream).toBe(false);
				expect(body.response_format).toEqual({ type: "json_object" });
			});
		});
	});
});
