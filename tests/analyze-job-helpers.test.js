// Mock dependencies before requiring the module
jest.mock("../netlify/functions/lib/job-storage", () => ({
	getJob: jest.fn(),
	saveFinalResult: jest.fn(),
	updateJobStatus: jest.fn()
}));

jest.mock("../netlify/functions/lib/auth-middleware", () => ({
	requireHybridAuth: jest.fn((handler) => handler)
}));

const { _internal } = require("../netlify/functions/analyze-job");
const {
	estimateTokenCount,
	parseTimeToSeconds,
	calculateContentLimits,
	processUrlContent,
	buildResultSection,
	GroqAnalyzer
} = _internal;

describe("Analyze Job - Helper Functions", () => {
	describe("estimateTokenCount", () => {
		it("should return 0 for null/empty input", () => {
			expect(estimateTokenCount(null)).toBe(0);
			expect(estimateTokenCount("")).toBe(0);
			expect(estimateTokenCount(undefined)).toBe(0);
		});

		it("should estimate tokens for pure ASCII text", () => {
			// 100 ASCII chars * 0.25 = 25 tokens
			const text = "a".repeat(100);
			expect(estimateTokenCount(text)).toBe(25);
		});

		it("should estimate higher token count for CJK text", () => {
			// 10 CJK chars * 2.5 = 25 tokens
			const text = "生産終了品代替品後継品";
			expect(estimateTokenCount(text)).toBe(Math.round(text.length * 2.5));
		});

		it("should handle mixed CJK and ASCII text", () => {
			// 4 CJK + 4 ASCII
			const text = "生産終了test";
			const expected = Math.round(4 * 2.5 + 4 * 0.25);
			expect(estimateTokenCount(text)).toBe(expected);
		});

		it("should count hiragana as CJK", () => {
			const text = "おはよう"; // 4 hiragana chars
			expect(estimateTokenCount(text)).toBe(Math.round(4 * 2.5));
		});

		it("should count katakana as CJK", () => {
			const text = "テスト"; // 3 katakana chars
			expect(estimateTokenCount(text)).toBe(Math.round(3 * 2.5));
		});

		it("should count full-width ASCII as CJK", () => {
			const text = "ＡＢＣ"; // 3 full-width chars
			expect(estimateTokenCount(text)).toBe(Math.round(3 * 2.5));
		});
	});

	describe("parseTimeToSeconds", () => {
		it("should parse seconds only", () => {
			expect(parseTimeToSeconds("30s")).toBe(30);
		});

		it("should parse seconds with decimals", () => {
			expect(parseTimeToSeconds("7.5s")).toBe(7.5);
		});

		it("should parse minutes and seconds", () => {
			expect(parseTimeToSeconds("7m54.336s")).toBeCloseTo(474.336, 2);
		});

		it("should parse hours, minutes, and seconds", () => {
			expect(parseTimeToSeconds("2h30m15s")).toBe(2 * 3600 + 30 * 60 + 15);
		});

		it("should parse minutes only", () => {
			expect(parseTimeToSeconds("5m")).toBe(300);
		});

		it("should parse hours only", () => {
			expect(parseTimeToSeconds("1h")).toBe(3600);
		});

		it("should return 0 for unrecognized format", () => {
			expect(parseTimeToSeconds("invalid")).toBe(0);
		});
	});

	describe("calculateContentLimits", () => {
		it("should return base limits at truncation level 0", () => {
			const { maxContentLength, maxTotalChars } = calculateContentLimits(0);
			expect(maxContentLength).toBe(6000);
			expect(maxTotalChars).toBe(6000 * 2 + 1000); // 13000
		});

		it("should reduce content length at level 1", () => {
			const { maxContentLength } = calculateContentLimits(1);
			expect(maxContentLength).toBe(6000 - 1500); // 4500
		});

		it("should reduce content length at level 2", () => {
			const { maxContentLength } = calculateContentLimits(2);
			expect(maxContentLength).toBe(6000 - 3000); // 3000
		});

		it("should not go below minimum content length", () => {
			// At level 3: 6000 - 4500 = 1500 (minimum)
			const { maxContentLength: level3 } = calculateContentLimits(3);
			expect(level3).toBe(1500);

			// At level 4: would be 0, but clamped to 1500
			const { maxContentLength: level4 } = calculateContentLimits(4);
			expect(level4).toBe(1500);
		});
	});

	describe("processUrlContent", () => {
		it("should return null for null/empty content", () => {
			expect(processUrlContent(null, 6000, "model", 0)).toBeNull();
			expect(processUrlContent(undefined, 6000, "model", 0)).toBeNull();
		});

		it("should return content unchanged if under threshold", () => {
			const content = "Short content about product XYZ";
			const result = processUrlContent(content, 6000, "XYZ", 0);
			expect(result).toBe(content);
		});

		it("should add table markers if not present", () => {
			const content = "| Col1 | Col2 |\n| Val1 | Val2 |";
			const result = processUrlContent(content, 6000, "model", 0);
			expect(result).toContain("=== TABLE START ===");
		});

		it("should not add table markers if already present", () => {
			const content = "=== TABLE START ===\n| Col1 | Col2 |\n=== TABLE END ===";
			const result = processUrlContent(content, 6000, "model", 0);
			// Should not have double markers
			const startCount = (result.match(/=== TABLE START ===/g) || []).length;
			expect(startCount).toBe(1);
		});

		it("should truncate content exceeding maxContentLength", () => {
			const content = "A".repeat(10000);
			const result = processUrlContent(content, 500, "model", 0);
			expect(result.length).toBeLessThanOrEqual(500);
		});
	});

	describe("buildResultSection", () => {
		it("should build a formatted result section", () => {
			const urlInfo = {
				title: "Product Page",
				url: "https://example.com",
				snippet: "A product snippet"
			};
			const result = { url: "https://example.com/page", fullContent: "Full content here" };
			const processedContent = "Processed content";

			const section = buildResultSection(urlInfo, result, processedContent, 0);
			expect(section).toContain("RESULT #1");
			expect(section).toContain("Title: Product Page");
			expect(section).toContain("URL: https://example.com/page");
			expect(section).toContain("FULL PAGE CONTENT:");
			expect(section).toContain("Processed content");
		});

		it("should show snippet when no full content", () => {
			const urlInfo = { title: "Page", url: "https://example.com", snippet: "Snippet text" };
			const result = { url: "https://example.com" };
			const section = buildResultSection(urlInfo, result, null, 0);
			expect(section).toContain("Snippet: Snippet text");
			expect(section).toContain("Could not fetch full content");
		});

		it("should use urlInfo.url if result has no url", () => {
			const urlInfo = { title: "Page", url: "https://fallback.com", snippet: "text" };
			const result = {};
			const section = buildResultSection(urlInfo, result, null, 0);
			expect(section).toContain("URL: https://fallback.com");
		});

		it("should use correct result number (1-indexed)", () => {
			const urlInfo = { title: "Page", url: "https://example.com", snippet: "" };
			const section = buildResultSection(urlInfo, {}, null, 4);
			expect(section).toContain("RESULT #5");
		});
	});

	describe("GroqAnalyzer", () => {
		let analyzer;

		beforeEach(() => {
			analyzer = new GroqAnalyzer();
		});

		describe("buildPrompt", () => {
			it("should include maker and model in prompt", () => {
				const prompt = analyzer.buildPrompt("Keyence", "LV-21A", "search results here");
				expect(prompt).toContain("LV-21A");
				expect(prompt).toContain("Keyence");
				expect(prompt).toContain("search results here");
			});

			it("should include analysis rules", () => {
				const prompt = analyzer.buildPrompt("Maker", "Model", "context");
				expect(prompt).toContain("DISCONTINUED");
				expect(prompt).toContain("ACTIVE");
				expect(prompt).toContain("UNKNOWN");
			});

			it("should request JSON-only response", () => {
				const prompt = analyzer.buildPrompt("Maker", "Model", "context");
				expect(prompt).toContain("JSON ONLY");
			});
		});

		describe("parseResponseText", () => {
			it("should parse valid JSON", () => {
				const json =
					'{"status": "ACTIVE", "explanation": "test", "successor": {"status": "UNKNOWN", "model": null, "explanation": "active"}}';
				const result = analyzer.parseResponseText(json);
				expect(result.status).toBe("ACTIVE");
			});

			it("should throw when JSON is not directly parseable and RE2.fromString is unavailable", () => {
				// RE2.fromString is used for JSON extraction fallback but may not be available
				// in all environments. When it's not, the function should throw.
				const text = 'Here is: {"status": "ACTIVE"} end';
				expect(() => analyzer.parseResponseText(text)).toThrow();
			});

			it("should throw on completely invalid input", () => {
				expect(() => analyzer.parseResponseText("no json here at all")).toThrow();
			});

			it("should throw on oversized response", () => {
				const oversized = "x".repeat(8192 * 5 + 1);
				expect(() => analyzer.parseResponseText(oversized)).toThrow(
					"exceeds maximum expected size"
				);
			});
		});

		describe("validateResult", () => {
			it("should accept valid result structure", () => {
				const result = {
					status: "ACTIVE",
					explanation: "Product is available",
					successor: { status: "UNKNOWN", model: null, explanation: "Active" }
				};
				expect(() => analyzer.validateResult(result)).not.toThrow();
			});

			it("should reject missing status", () => {
				expect(() =>
					analyzer.validateResult({
						explanation: "test",
						successor: {}
					})
				).toThrow("Invalid analysis result structure");
			});

			it("should reject missing explanation", () => {
				expect(() =>
					analyzer.validateResult({
						status: "ACTIVE",
						successor: {}
					})
				).toThrow("Invalid analysis result structure");
			});

			it("should reject missing successor", () => {
				expect(() =>
					analyzer.validateResult({
						status: "ACTIVE",
						explanation: "test"
					})
				).toThrow("Invalid analysis result structure");
			});
		});

		describe("extractRetryTime", () => {
			it("should extract retry time from error text", () => {
				const errorText = "Rate limit exceeded. Please try again in 7m54.336s";
				const result = analyzer.extractRetryTime(errorText);
				expect(result.seconds).toBeCloseTo(474.336, 2);
				expect(result.message).toContain("7m54.336s");
			});

			it("should return empty result when no time found", () => {
				const errorText = "Some other error";
				const result = analyzer.extractRetryTime(errorText);
				expect(result.seconds).toBeNull();
				expect(result.message).toBe("");
			});
		});

		describe("createPromptTooLargeError", () => {
			it("should create error with isPromptTooLarge flag", () => {
				const error = analyzer.createPromptTooLargeError("Request too large");
				expect(error.isPromptTooLarge).toBe(true);
				expect(error.originalError).toBe("Request too large");
			});
		});

		describe("calculateBackoffTime", () => {
			it("should use exponential backoff", () => {
				expect(analyzer.calculateBackoffTime(1)).toBe(2000);
				expect(analyzer.calculateBackoffTime(2)).toBe(4000);
				expect(analyzer.calculateBackoffTime(3)).toBe(8000);
			});
		});

		describe("getRequestBody", () => {
			it("should return correct request body structure", () => {
				const body = analyzer.getRequestBody("test prompt");
				expect(body.model).toBe("openai/gpt-oss-120b");
				expect(body.messages[0].role).toBe("user");
				expect(body.messages[0].content).toBe("test prompt");
				expect(body.temperature).toBe(0);
				expect(body.response_format).toEqual({ type: "json_object" });
			});
		});

		describe("extractGeneratedText", () => {
			it("should extract text from valid Groq response", () => {
				const groqData = {
					choices: [{ message: { content: "Generated text" } }]
				};
				expect(analyzer.extractGeneratedText(groqData)).toBe("Generated text");
			});

			it("should throw on unexpected format", () => {
				expect(() => analyzer.extractGeneratedText({})).toThrow(
					"Unexpected response format"
				);
				expect(() => analyzer.extractGeneratedText({ choices: [] })).toThrow(
					"Unexpected response format"
				);
			});
		});
	});
});
