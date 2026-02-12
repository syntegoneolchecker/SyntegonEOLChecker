/**
 * Extended tests for netlify/functions/initialize-job.js
 * Phase 4 - Tests gaps not covered by initialize-job.test.js
 *
 * Covers: manufacturer strategies, PDF screening, helper functions,
 * URL prioritization, and handler flow edge cases.
 *
 * All internal functions are tested through the handler since
 * the module only exports `handler` (wrapped with requireHybridAuth).
 */

jest.mock("../netlify/functions/lib/job-storage", () => ({
	createJob: jest.fn(),
	saveJobUrls: jest.fn(),
	saveFinalResult: jest.fn(),
	saveUrlResult: jest.fn()
}));

jest.mock("../netlify/functions/lib/validators", () => ({
	validateInitializeJob: jest.fn(),
	sanitizeString: jest.fn((s) => s)
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
	...jest.requireActual("../netlify/functions/lib/config"),
	SERPAPI_SITES_TO_SEARCH: ["site1.com", "site2.com"],
	SERPAPI_ENGINE: "google",
	SERPAPI_GOOGLE_DOMAIN: "google.com",
	PDF_SCREENING_TIMEOUT_MS: 5000,
	PDF_SCREENING_MAX_SIZE_MB: 10,
	PDF_SCREENING_MAX_PAGES: 3,
	PDF_SCREENING_MIN_CHARS: 100
}));

jest.mock("../netlify/functions/lib/response-builder", () => ({
	getCorsOrigin: jest.fn(() => "*"),
	errorResponse: jest.fn((msg, detail, code) => ({
		statusCode: code || 500,
		body: JSON.stringify({ error: msg })
	})),
	validationErrorResponse: jest.fn((errors) => ({
		statusCode: 400,
		body: JSON.stringify({ errors })
	}))
}));

jest.mock("../netlify/functions/lib/auth-middleware", () => ({
	requireHybridAuth: jest.fn((handler) => handler)
}));

// Save original fetch
const originalFetch = global.fetch;
global.fetch = jest.fn();

const { handler } = require("../netlify/functions/initialize-job");
const {
	createJob,
	saveJobUrls,
	saveFinalResult,
	saveUrlResult
} = require("../netlify/functions/lib/job-storage");
const { validateInitializeJob } = require("../netlify/functions/lib/validators");
const { scrapeWithBrowserQL } = require("../netlify/functions/lib/browserql-scraper");
const { getJson } = require("serpapi");
const pdfParse = require("pdf-parse");
const { loadPdfjs } = require("../scraping-service/utils/pdfjs-loader");

// Helper to build a POST event
function postEvent(maker, model) {
	return {
		httpMethod: "POST",
		body: JSON.stringify({ maker, model }),
		headers: {}
	};
}

// Helper to set up valid request defaults
function setupValidRequest(jobId = "job-1") {
	validateInitializeJob.mockReturnValue({ valid: true });
	createJob.mockResolvedValue(jobId);
	saveJobUrls.mockResolvedValue(undefined);
	saveFinalResult.mockResolvedValue(undefined);
	saveUrlResult.mockResolvedValue(undefined);
}

// Helper to set up SerpAPI to return given organic results
function setupSerpAPI(results) {
	getJson.mockImplementation((params, callback) => {
		callback({ organic_results: results });
	});
}

// Helper to set up SerpAPI error
function setupSerpAPIError(errorMessage) {
	getJson.mockImplementation((params, callback) => {
		callback({ error: errorMessage });
	});
}

// Helper: mock global.fetch to return HTML
function mockFetchHtml(html, status = 200) {
	global.fetch.mockResolvedValue({
		ok: status >= 200 && status < 300,
		status,
		headers: new Map([["content-type", "text/html"]]),
		text: jest.fn().mockResolvedValue(html)
	});
}

const mockContext = {};

describe("initialize-job extended tests", () => {
	beforeEach(() => {
		jest.clearAllMocks();
		process.env.SERPAPI_API_KEY = "test-key";
		global.fetch.mockReset();
	});

	afterAll(() => {
		global.fetch = originalFetch;
	});

	// =========================================================================
	// 1. MANUFACTURER STRATEGIES
	// =========================================================================
	describe("Manufacturer strategies", () => {
		test("KEYENCE returns keyence_interactive strategy with model", async () => {
			setupValidRequest("job-keyence");

			const result = await handler(postEvent("KEYENCE", "IV-500CA"), mockContext);

			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			expect(body.jobId).toBe("job-keyence");
			expect(body.strategy).toBe("direct_url");
			expect(body.scrapingMethod).toBe("keyence_interactive");

			// Verify the URL entry includes the model
			expect(saveJobUrls).toHaveBeenCalledWith(
				"job-keyence",
				expect.arrayContaining([
					expect.objectContaining({
						scrapingMethod: "keyence_interactive",
						model: "IV-500CA"
					})
				]),
				mockContext
			);
		});

		test("TAKIGEN with product found extracts product URL", async () => {
			setupValidRequest("job-takigen");

			const takigenHtml = `
				<div class="p-4 flex flex-wrap flex-col md:flex-row">
					<a href="/products/detail/A-1038/A-1038">Product A-1038</a>
				</div>
			`;
			mockFetchHtml(takigenHtml);

			const result = await handler(postEvent("TAKIGEN", "A-1038"), mockContext);

			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			expect(body.jobId).toBe("job-takigen");
			expect(body.strategy).toBe("takigen_extracted_url");
			expect(body.extractedUrl).toBe(
				"https://www.takigen.co.jp/products/detail/A-1038/A-1038"
			);

			expect(saveJobUrls).toHaveBeenCalledWith(
				"job-takigen",
				expect.arrayContaining([
					expect.objectContaining({
						url: "https://www.takigen.co.jp/products/detail/A-1038/A-1038"
					})
				]),
				mockContext
			);
		});

		test("TAKIGEN with no product found falls back to SerpAPI", async () => {
			setupValidRequest("job-takigen-fallback");

			// Return HTML with no matching product div
			const emptyHtml = "<html><body>No products</body></html>";
			mockFetchHtml(emptyHtml);

			// SerpAPI fallback returns no results
			setupSerpAPI([]);

			const result = await handler(postEvent("TAKIGEN", "UNKNOWN-MODEL"), mockContext);

			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			// Should have fallen back to SerpAPI, which returned no results
			expect(body.status).toBe("complete");
			expect(body.message).toContain("No search results");
			expect(saveFinalResult).toHaveBeenCalled();
		});

		test("TAKIGEN fetch error falls back to SerpAPI", async () => {
			setupValidRequest("job-takigen-err");

			// Simulate fetch failure
			global.fetch.mockRejectedValue(new Error("Network error"));

			// SerpAPI fallback
			setupSerpAPI([
				{ link: "https://example.com/p1", title: "Result 1", snippet: "Snip" }
			]);

			const result = await handler(postEvent("TAKIGEN", "A-1038"), mockContext);

			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			// Falls back to SerpAPI since validation scraping failed
			expect(body.urlCount).toBe(1);
		});

		test("NISSIN ELECTRONIC with 404 page falls back to SerpAPI", async () => {
			setupValidRequest("job-nissin-404");

			// Return HTML containing 404 pattern
			mockFetchHtml("<html><body><h1>Page not found</h1></body></html>");

			// SerpAPI fallback returns no results
			setupSerpAPI([]);

			const result = await handler(postEvent("NISSIN ELECTRONIC", "NE-100"), mockContext);

			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			expect(body.status).toBe("complete");
			expect(body.message).toContain("No search results");
		});

		test("NISSIN ELECTRONIC with 404 pattern ページが見つかりません falls back to SerpAPI", async () => {
			setupValidRequest("job-nissin-jp404");

			mockFetchHtml("<html><body>ページが見つかりません</body></html>");

			setupSerpAPI([]);

			const result = await handler(
				postEvent("NISSIN ELECTRONIC", "NE-200"),
				mockContext
			);

			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			expect(body.status).toBe("complete");
		});

		test("NISSIN ELECTRONIC with valid page uses direct URL", async () => {
			setupValidRequest("job-nissin-ok");

			// Return HTML without 404 patterns
			mockFetchHtml(
				"<html><body><h1>NE-100 Product Details</h1><p>Active product</p></body></html>"
			);

			const result = await handler(postEvent("NISSIN ELECTRONIC", "NE-100"), mockContext);

			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			expect(body.jobId).toBe("job-nissin-ok");
			expect(body.strategy).toBe("nissin_validated_url");

			expect(saveJobUrls).toHaveBeenCalledWith(
				"job-nissin-ok",
				expect.arrayContaining([
					expect.objectContaining({
						url: "https://nissin-ele.co.jp/product/NE-100"
					})
				]),
				mockContext
			);
		});

		test("NTN with no results on motion.com falls back to SerpAPI", async () => {
			setupValidRequest("job-ntn-noresults");

			scrapeWithBrowserQL.mockResolvedValue({
				content: "no results for: 6200Z"
			});

			setupSerpAPI([]);

			const result = await handler(postEvent("NTN", "6200Z"), mockContext);

			expect(result.statusCode).toBe(200);
			expect(scrapeWithBrowserQL).toHaveBeenCalledWith(
				expect.stringContaining("motion.com/products/search")
			);
			const body = JSON.parse(result.body);
			expect(body.status).toBe("complete");
		});

		test("NTN with results found saves URL with scraped content", async () => {
			setupValidRequest("job-ntn-ok");

			scrapeWithBrowserQL.mockResolvedValue({
				content: "NTN 6200Z bearing - available for purchase. Product details here."
			});

			const result = await handler(postEvent("NTN", "6200Z"), mockContext);

			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			expect(body.jobId).toBe("job-ntn-ok");
			expect(body.strategy).toBe("validated_direct_url");
			expect(body.contentLength).toBeGreaterThan(0);

			// Should save both URLs and URL result (content already scraped)
			expect(saveJobUrls).toHaveBeenCalled();
			expect(saveUrlResult).toHaveBeenCalledWith(
				"job-ntn-ok",
				0,
				expect.objectContaining({
					fullContent: expect.stringContaining("NTN 6200Z bearing")
				}),
				mockContext
			);
		});

		test("NTN BrowserQL scrape failure falls back to SerpAPI", async () => {
			setupValidRequest("job-ntn-err");

			scrapeWithBrowserQL.mockRejectedValue(new Error("BrowserQL timeout"));

			setupSerpAPI([
				{ link: "https://example.com/ntn", title: "NTN", snippet: "Bearing" }
			]);

			const result = await handler(postEvent("NTN", "6200Z"), mockContext);

			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			// Should have fallen back to SerpAPI after BrowserQL failure
			expect(body.urlCount).toBe(1);
		});

		test("MURR uses direct URL strategy", async () => {
			setupValidRequest("job-murr");

			const result = await handler(postEvent("MURR", "7000-12345"), mockContext);

			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			expect(body.strategy).toBe("direct_url");

			expect(saveJobUrls).toHaveBeenCalledWith(
				"job-murr",
				expect.arrayContaining([
					expect.objectContaining({
						url: expect.stringContaining("shop.murrinc.com"),
						scrapingMethod: "render"
					})
				]),
				mockContext
			);
		});

		test("NBK returns nbk_interactive strategy with model", async () => {
			setupValidRequest("job-nbk");

			const result = await handler(postEvent("NBK", "MJC-65-EWH"), mockContext);

			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			expect(body.strategy).toBe("direct_url");
			expect(body.scrapingMethod).toBe("nbk_interactive");

			expect(saveJobUrls).toHaveBeenCalledWith(
				"job-nbk",
				expect.arrayContaining([
					expect.objectContaining({
						scrapingMethod: "nbk_interactive",
						model: "MJC-65-EWH"
					})
				]),
				mockContext
			);
		});

		test("Unknown manufacturer returns null and falls back to SerpAPI", async () => {
			setupValidRequest("job-unknown");

			setupSerpAPI([
				{ link: "https://example.com/result1", title: "Result 1", snippet: "S1" }
			]);

			const result = await handler(postEvent("ACME CORP", "XYZ-999"), mockContext);

			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			expect(body.jobId).toBe("job-unknown");
			// SerpAPI was used, not direct_url
			expect(getJson).toHaveBeenCalled();
		});

		test("SMC direct URL includes encoded model in URL", async () => {
			setupValidRequest("job-smc");

			const result = await handler(postEvent("SMC", "SY3120-5LZ"), mockContext);

			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			expect(body.strategy).toBe("direct_url");

			expect(saveJobUrls).toHaveBeenCalledWith(
				"job-smc",
				expect.arrayContaining([
					expect.objectContaining({
						url: expect.stringContaining("SY3120-5LZ"),
						scrapingMethod: "render"
					})
				]),
				mockContext
			);
		});

		test("ORIENTAL MOTOR uses browserql scraping method", async () => {
			setupValidRequest("job-om");

			const result = await handler(postEvent("ORIENTAL MOTOR", "BLM230"), mockContext);

			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			expect(body.strategy).toBe("direct_url");
			expect(body.scrapingMethod).toBe("browserql");

			expect(saveJobUrls).toHaveBeenCalledWith(
				"job-om",
				expect.arrayContaining([
					expect.objectContaining({
						url: expect.stringContaining("orientalmotor.co.jp"),
						scrapingMethod: "browserql"
					})
				]),
				mockContext
			);
		});

		test("MISUMI uses render scraping with keyword-encoded URL", async () => {
			setupValidRequest("job-misumi");

			const result = await handler(postEvent("MISUMI", "HFSB5-2020"), mockContext);

			expect(result.statusCode).toBe(200);

			expect(saveJobUrls).toHaveBeenCalledWith(
				"job-misumi",
				expect.arrayContaining([
					expect.objectContaining({
						url: expect.stringContaining("Keyword=HFSB5-2020"),
						scrapingMethod: "render"
					})
				]),
				mockContext
			);
		});
	});

	// =========================================================================
	// 2. PDF SCREENING (tested through SerpAPI search flow)
	// =========================================================================
	describe("PDF screening through SerpAPI flow", () => {
		test("non-PDF URL passes screening and is selected", async () => {
			setupValidRequest("job-html");

			setupSerpAPI([
				{
					link: "https://example.com/product-page",
					title: "Product Page",
					snippet: "Regular HTML"
				}
			]);

			const result = await handler(postEvent("ACME", "MODEL-1"), mockContext);

			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			expect(body.urlCount).toBe(1);
			// fetch should NOT be called for non-PDF screening
			// (fetch is only called for PDF text check, not for HTML URLs)
		});

		test("PDF URL with successful pdf-parse extraction passes screening", async () => {
			setupValidRequest("job-pdf-ok");

			setupSerpAPI([
				{
					link: "https://example.com/datasheet.pdf",
					title: "Datasheet PDF",
					snippet: "PDF"
				}
			]);

			// Mock fetch for PDF download
			const pdfBuffer = Buffer.from("fake-pdf-content");
			global.fetch.mockResolvedValue({
				ok: true,
				status: 200,
				headers: {
					get: (key) => {
						if (key === "content-type") return "application/pdf";
						if (key === "content-length") return "1000";
						return null;
					}
				},
				arrayBuffer: jest.fn().mockResolvedValue(pdfBuffer.buffer)
			});

			// pdf-parse returns text with enough chars
			pdfParse.mockResolvedValue({
				text: "A".repeat(200) // 200 chars > 100 min
			});

			const result = await handler(postEvent("ACME", "MODEL-PDF"), mockContext);

			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			expect(body.urlCount).toBe(1);
			expect(pdfParse).toHaveBeenCalled();
		});

		test("PDF URL with HTTP error fails screening, next URL tried", async () => {
			setupValidRequest("job-pdf-httperr");

			setupSerpAPI([
				{
					link: "https://example.com/bad.pdf",
					title: "Bad PDF",
					snippet: "Broken"
				},
				{
					link: "https://example.com/good-page",
					title: "Good Page",
					snippet: "HTML"
				}
			]);

			// First call (PDF screening) returns HTTP error
			global.fetch.mockResolvedValueOnce({
				ok: false,
				status: 404,
				headers: {
					get: () => null
				}
			});

			const result = await handler(postEvent("ACME", "MODEL-ERR"), mockContext);

			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			// The PDF failed, but the HTML URL should pass
			expect(body.urlCount).toBe(1);
		});

		test("PDF URL with non-PDF content type fails screening", async () => {
			setupValidRequest("job-pdf-notpdf");

			setupSerpAPI([
				{
					link: "https://example.com/fake.pdf",
					title: "Fake PDF",
					snippet: "Not actually PDF"
				},
				{
					link: "https://example.com/real-page",
					title: "Real Page",
					snippet: "HTML"
				}
			]);

			global.fetch.mockResolvedValueOnce({
				ok: true,
				status: 200,
				headers: {
					get: (key) => {
						if (key === "content-type") return "text/html";
						return null;
					}
				}
			});

			const result = await handler(postEvent("ACME", "MODEL-CT"), mockContext);

			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			// PDF failed (not PDF content type), HTML page passed
			expect(body.urlCount).toBe(1);
		});

		test("PDF URL too large fails screening", async () => {
			setupValidRequest("job-pdf-large");

			setupSerpAPI([
				{
					link: "https://example.com/huge.pdf",
					title: "Huge PDF",
					snippet: "Very large"
				},
				{
					link: "https://example.com/page",
					title: "Page",
					snippet: "HTML"
				}
			]);

			// 20MB > 10MB limit
			global.fetch.mockResolvedValueOnce({
				ok: true,
				status: 200,
				headers: {
					get: (key) => {
						if (key === "content-type") return "application/pdf";
						if (key === "content-length") return String(20 * 1024 * 1024);
						return null;
					}
				}
			});

			const result = await handler(postEvent("ACME", "MODEL-BIG"), mockContext);

			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			expect(body.urlCount).toBe(1);
		});

		test("PDF where pdf-parse fails but pdfjs-dist succeeds passes screening", async () => {
			setupValidRequest("job-pdf-pdfjs");

			setupSerpAPI([
				{
					link: "https://example.com/cjk-doc.pdf",
					title: "CJK PDF",
					snippet: "Japanese text"
				}
			]);

			const pdfBuffer = Buffer.from("fake-pdf");
			global.fetch.mockResolvedValue({
				ok: true,
				status: 200,
				headers: {
					get: (key) => {
						if (key === "content-type") return "application/pdf";
						if (key === "content-length") return "5000";
						return null;
					}
				},
				arrayBuffer: jest.fn().mockResolvedValue(pdfBuffer.buffer)
			});

			// pdf-parse throws error
			pdfParse.mockRejectedValue(new Error("pdf-parse: cannot read"));

			// pdfjs-dist succeeds with enough chars (> 100 min)
			const longText = "A".repeat(150);
			const mockPage = {
				getTextContent: jest.fn().mockResolvedValue({
					items: [{ str: longText }]
				})
			};
			const mockDoc = {
				numPages: 2,
				getPage: jest.fn().mockResolvedValue(mockPage)
			};
			loadPdfjs.mockResolvedValue({
				getDocument: jest.fn().mockReturnValue({
					promise: Promise.resolve(mockDoc)
				})
			});

			const result = await handler(postEvent("ACME", "MODEL-CJK"), mockContext);

			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			expect(body.urlCount).toBe(1);
			expect(loadPdfjs).toHaveBeenCalled();
		});

		test("PDF where both pdf-parse and pdfjs-dist fail, screening rejects", async () => {
			setupValidRequest("job-pdf-bothfail");

			setupSerpAPI([
				{
					link: "https://example.com/image-only.pdf",
					title: "Image PDF",
					snippet: "Scanned"
				},
				{
					link: "https://example.com/fallback-html",
					title: "Fallback HTML",
					snippet: "HTML page"
				}
			]);

			const pdfBuffer = Buffer.from("fake-pdf");
			global.fetch.mockResolvedValueOnce({
				ok: true,
				status: 200,
				headers: {
					get: (key) => {
						if (key === "content-type") return "application/pdf";
						if (key === "content-length") return "5000";
						return null;
					}
				},
				arrayBuffer: jest.fn().mockResolvedValue(pdfBuffer.buffer)
			});

			// pdf-parse returns 0 chars
			pdfParse.mockResolvedValue({ text: "" });

			// pdfjs-dist also returns 0 chars
			const mockPage = {
				getTextContent: jest.fn().mockResolvedValue({ items: [] })
			};
			const mockDoc = {
				numPages: 1,
				getPage: jest.fn().mockResolvedValue(mockPage)
			};
			loadPdfjs.mockResolvedValue({
				getDocument: jest.fn().mockReturnValue({
					promise: Promise.resolve(mockDoc)
				})
			});

			const result = await handler(postEvent("ACME", "MODEL-IMG"), mockContext);

			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			// PDF rejected, HTML fallback passed
			expect(body.urlCount).toBe(1);
		});

		test("PDF timeout (AbortError) fails screening", async () => {
			setupValidRequest("job-pdf-timeout");

			setupSerpAPI([
				{
					link: "https://example.com/slow.pdf",
					title: "Slow PDF",
					snippet: "Timeout"
				},
				{
					link: "https://example.com/quick-page",
					title: "Quick Page",
					snippet: "HTML"
				}
			]);

			const abortError = new Error("The operation was aborted");
			abortError.name = "AbortError";
			global.fetch.mockRejectedValueOnce(abortError);

			const result = await handler(postEvent("ACME", "MODEL-SLOW"), mockContext);

			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			// PDF timed out, HTML fallback should pass
			expect(body.urlCount).toBe(1);
		});

		test("PDF with too few chars fails screening", async () => {
			setupValidRequest("job-pdf-fewchars");

			setupSerpAPI([
				{
					link: "https://example.com/sparse.pdf",
					title: "Sparse PDF",
					snippet: "Almost empty"
				},
				{
					link: "https://example.com/html-ok",
					title: "HTML OK",
					snippet: "Good HTML"
				}
			]);

			const pdfBuffer = Buffer.from("sparse-pdf");
			global.fetch.mockResolvedValueOnce({
				ok: true,
				status: 200,
				headers: {
					get: (key) => {
						if (key === "content-type") return "application/pdf";
						if (key === "content-length") return "2000";
						return null;
					}
				},
				arrayBuffer: jest.fn().mockResolvedValue(pdfBuffer.buffer)
			});

			// pdf-parse returns text, but fewer than 100 chars (min)
			pdfParse.mockResolvedValue({ text: "short text" }); // 10 chars < 100

			const result = await handler(postEvent("ACME", "MODEL-SHORT"), mockContext);

			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			// PDF rejected (too few chars), HTML fallback passed
			expect(body.urlCount).toBe(1);
		});

		test("screenAndSelectUrls selects up to maxUrls (2) valid URLs", async () => {
			setupValidRequest("job-multi");

			setupSerpAPI([
				{
					link: "https://example.com/page1",
					title: "Page 1",
					snippet: "First"
				},
				{
					link: "https://example.com/page2",
					title: "Page 2",
					snippet: "Second"
				},
				{
					link: "https://example.com/page3",
					title: "Page 3",
					snippet: "Third"
				}
			]);

			const result = await handler(postEvent("ACME", "MODEL-MULTI"), mockContext);

			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			// Should select at most 2 URLs
			expect(body.urlCount).toBe(2);
		});

		test("all PDFs fail screening results in no valid URLs", async () => {
			setupValidRequest("job-allpdf-fail");

			setupSerpAPI([
				{
					link: "https://example.com/bad1.pdf",
					title: "Bad PDF 1",
					snippet: "Broken"
				},
				{
					link: "https://example.com/bad2.pdf",
					title: "Bad PDF 2",
					snippet: "Also broken"
				}
			]);

			// Both PDFs return HTTP error
			global.fetch
				.mockResolvedValueOnce({
					ok: false,
					status: 500,
					headers: { get: () => null }
				})
				.mockResolvedValueOnce({
					ok: false,
					status: 500,
					headers: { get: () => null }
				});

			const result = await handler(postEvent("ACME", "MODEL-ALLBAD"), mockContext);

			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			// No valid URLs found, should handle as no results
			expect(body.status).toBe("complete");
			expect(body.message).toContain("No search results");
			expect(saveFinalResult).toHaveBeenCalled();
		});
	});

	// =========================================================================
	// 3. HELPER FUNCTIONS (tested through handler behavior)
	// =========================================================================
	describe("isPdfUrl detection through handler", () => {
		test("detects .pdf extension", async () => {
			setupValidRequest("job-ispdf-ext");

			setupSerpAPI([
				{
					link: "https://example.com/doc.pdf",
					title: "PDF Doc",
					snippet: "Extension"
				}
			]);

			// PDF screening will be triggered - mock the fetch
			global.fetch.mockResolvedValue({
				ok: false,
				status: 404,
				headers: { get: () => null }
			});

			await handler(postEvent("ACME", "M1"), mockContext);

			// fetch was called because isPdfUrl detected .pdf
			expect(global.fetch).toHaveBeenCalledWith(
				"https://example.com/doc.pdf",
				expect.any(Object)
			);
		});

		test("detects /pdf/ in URL path", async () => {
			setupValidRequest("job-ispdf-path");

			setupSerpAPI([
				{
					link: "https://example.com/pdf/document",
					title: "PDF Path",
					snippet: "Path"
				}
			]);

			global.fetch.mockResolvedValue({
				ok: false,
				status: 404,
				headers: { get: () => null }
			});

			await handler(postEvent("ACME", "M2"), mockContext);

			// fetch was called because isPdfUrl detected /pdf/
			expect(global.fetch).toHaveBeenCalledWith(
				"https://example.com/pdf/document",
				expect.any(Object)
			);
		});

		test("detects data_pdf in URL", async () => {
			setupValidRequest("job-ispdf-datapdf");

			setupSerpAPI([
				{
					link: "https://example.com/data_pdf_download",
					title: "Data PDF",
					snippet: "Data"
				}
			]);

			global.fetch.mockResolvedValue({
				ok: false,
				status: 404,
				headers: { get: () => null }
			});

			await handler(postEvent("ACME", "M3"), mockContext);

			// fetch was called because isPdfUrl detected data_pdf
			expect(global.fetch).toHaveBeenCalledWith(
				"https://example.com/data_pdf_download",
				expect.any(Object)
			);
		});
	});

	describe("hasNoSearchResults detection through NTN handler", () => {
		test("detects 'no results for:' pattern in NTN scrape content", async () => {
			setupValidRequest("job-noresults-pattern");

			scrapeWithBrowserQL.mockResolvedValue({
				content: "Showing no results for: 6200Z - try different search terms"
			});

			setupSerpAPI([]);

			const result = await handler(postEvent("NTN", "6200Z"), mockContext);

			expect(result.statusCode).toBe(200);
			// Should have fallen back to SerpAPI
			expect(getJson).toHaveBeenCalled();
		});

		test("returns false for content with actual results", async () => {
			setupValidRequest("job-hasresults");

			scrapeWithBrowserQL.mockResolvedValue({
				content: "NTN 6200Z Bearing - Deep groove ball bearing. Available for purchase."
			});

			const result = await handler(postEvent("NTN", "6200Z"), mockContext);

			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			// Should NOT have fallen back - uses validated direct URL
			expect(body.strategy).toBe("validated_direct_url");
			expect(getJson).not.toHaveBeenCalled();
		});

		test("returns true for null/empty content (NTN scrape returns empty)", async () => {
			setupValidRequest("job-emptycontent");

			scrapeWithBrowserQL.mockResolvedValue({
				content: ""
			});

			setupSerpAPI([]);

			await handler(postEvent("NTN", "6200Z"), mockContext);

			// Empty content => hasNoSearchResults returns true => fallback
			expect(getJson).toHaveBeenCalled();
		});
	});

	describe("is404Page detection through NISSIN ELECTRONIC handler", () => {
		test("detects '404 not found' pattern", async () => {
			setupValidRequest("job-404-notfound");

			mockFetchHtml("<html><body>404 Not Found</body></html>");
			setupSerpAPI([]);

			const result = await handler(
				postEvent("NISSIN ELECTRONIC", "NE-300"),
				mockContext
			);

			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			expect(body.status).toBe("complete");
		});

		test("detects '404 error' pattern", async () => {
			setupValidRequest("job-404-error");

			mockFetchHtml("<html><body>404 Error - The page you requested was not found</body></html>");
			setupSerpAPI([]);

			const result = await handler(
				postEvent("NISSIN ELECTRONIC", "NE-400"),
				mockContext
			);

			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			expect(body.status).toBe("complete");
		});

		test("returns false for valid product content", async () => {
			setupValidRequest("job-404-valid");

			mockFetchHtml(
				"<html><body><h1>Product NE-500</h1><p>Active semiconductor device</p></body></html>"
			);

			const result = await handler(
				postEvent("NISSIN ELECTRONIC", "NE-500"),
				mockContext
			);

			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			expect(body.strategy).toBe("nissin_validated_url");
		});
	});

	describe("extractTakigenProductUrl through TAKIGEN handler", () => {
		test("extracts product path from valid HTML", async () => {
			setupValidRequest("job-takigen-extract");

			const html = `<html><body>
				<div class="p-4 flex flex-wrap flex-col md:flex-row">
					<a href="/products/detail/C-1234/C-1234-2">Product C-1234</a>
					<a href="/products/detail/C-5678/C-5678">Product C-5678</a>
				</div>
			</body></html>`;
			mockFetchHtml(html);

			const result = await handler(postEvent("TAKIGEN", "C-1234"), mockContext);

			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			expect(body.strategy).toBe("takigen_extracted_url");
			// Should extract the first product path
			expect(body.extractedUrl).toBe(
				"https://www.takigen.co.jp/products/detail/C-1234/C-1234-2"
			);
		});

		test("returns null when div not found in HTML", async () => {
			setupValidRequest("job-takigen-nodiv");

			const html = '<html><body><div class="other-class">No products</div></body></html>';
			mockFetchHtml(html);

			setupSerpAPI([]);

			const result = await handler(postEvent("TAKIGEN", "MISSING"), mockContext);

			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			// Should fall back since no product found
			expect(body.status).toBe("complete");
		});

		test("returns null when no href found in div", async () => {
			setupValidRequest("job-takigen-nohref");

			const html = `<html><body>
				<div class="p-4 flex flex-wrap flex-col md:flex-row">
					<span>No links here</span>
				</div>
			</body></html>`;
			mockFetchHtml(html);

			setupSerpAPI([]);

			const result = await handler(postEvent("TAKIGEN", "NOLINK"), mockContext);

			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			expect(body.status).toBe("complete");
		});
	});

	// =========================================================================
	// 4. URL PRIORITIZATION (tested through SerpAPI flow)
	// =========================================================================
	describe("URL prioritization through SerpAPI flow", () => {
		test("exact model match at end of URL is prioritized first", async () => {
			setupValidRequest("job-prio-exact");

			setupSerpAPI([
				{
					link: "https://example.com/other-page",
					title: "Other",
					snippet: "Not matching"
				},
				{
					link: "https://example.com/products/ABC-123",
					title: "Exact Match",
					snippet: "Product page"
				}
			]);

			const result = await handler(postEvent("ACME", "ABC-123"), mockContext);

			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			expect(body.urlCount).toBe(2);

			// The exact match URL should be first in the saved URLs
			const savedUrls = saveJobUrls.mock.calls[0][1];
			expect(savedUrls[0].url).toBe("https://example.com/products/ABC-123");
		});

		test("case insensitive URL model matching", async () => {
			setupValidRequest("job-prio-case");

			setupSerpAPI([
				{
					link: "https://example.com/general",
					title: "General",
					snippet: "Info"
				},
				{
					link: "https://example.com/product/abc-123",
					title: "Product",
					snippet: "Match"
				}
			]);

			const result = await handler(postEvent("ACME", "ABC-123"), mockContext);

			expect(result.statusCode).toBe(200);
			const savedUrls = saveJobUrls.mock.calls[0][1];
			// abc-123 should match ABC-123 case-insensitively and be first
			expect(savedUrls[0].url).toBe("https://example.com/product/abc-123");
		});

		test("no exact matches keeps original search result order", async () => {
			setupValidRequest("job-prio-none");

			setupSerpAPI([
				{
					link: "https://example.com/page-one",
					title: "First",
					snippet: "First result"
				},
				{
					link: "https://example.com/page-two",
					title: "Second",
					snippet: "Second result"
				}
			]);

			const result = await handler(postEvent("ACME", "NOMATCH-999"), mockContext);

			expect(result.statusCode).toBe(200);
			const savedUrls = saveJobUrls.mock.calls[0][1];
			expect(savedUrls[0].url).toBe("https://example.com/page-one");
			expect(savedUrls[1].url).toBe("https://example.com/page-two");
		});

		test("skips results with missing link", async () => {
			setupValidRequest("job-prio-nolink");

			setupSerpAPI([
				{ link: null, title: "No Link", snippet: "Missing" },
				{
					link: "https://example.com/valid",
					title: "Valid",
					snippet: "Good"
				},
				{ title: "Also No Link", snippet: "Missing too" }
			]);

			const result = await handler(postEvent("ACME", "MODEL-X"), mockContext);

			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			expect(body.urlCount).toBe(1);
		});

		test("empty results array from SerpAPI triggers no results handling", async () => {
			setupValidRequest("job-prio-empty");

			setupSerpAPI([]);

			const result = await handler(postEvent("ACME", "MODEL-EMPTY"), mockContext);

			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			expect(body.status).toBe("complete");
			expect(body.message).toContain("No search results");
		});

		test("multiple exact matches all come before regular results", async () => {
			setupValidRequest("job-prio-multi");

			setupSerpAPI([
				{
					link: "https://site-a.com/info",
					title: "Info A",
					snippet: "Regular"
				},
				{
					link: "https://site-b.com/product/MODEL-X",
					title: "Match B",
					snippet: "Exact"
				},
				{
					link: "https://site-c.com/catalog/MODEL-X",
					title: "Match C",
					snippet: "Also exact"
				},
				{
					link: "https://site-d.com/other",
					title: "Info D",
					snippet: "Regular"
				}
			]);

			const result = await handler(postEvent("ACME", "MODEL-X"), mockContext);

			expect(result.statusCode).toBe(200);
			// Max 2 URLs selected; both should be exact matches since they're first
			const savedUrls = saveJobUrls.mock.calls[0][1];
			expect(savedUrls[0].url).toBe("https://site-b.com/product/MODEL-X");
			expect(savedUrls[1].url).toBe("https://site-c.com/catalog/MODEL-X");
		});
	});

	// =========================================================================
	// 5. HANDLER FLOW TESTS
	// =========================================================================
	describe("Handler flow edge cases", () => {
		test("OPTIONS returns 204 with CORS headers", async () => {
			const event = { httpMethod: "OPTIONS" };
			const result = await handler(event, mockContext);

			expect(result.statusCode).toBe(204);
			expect(result.headers["Access-Control-Allow-Origin"]).toBe("*");
			expect(result.headers["Access-Control-Allow-Headers"]).toBe("Content-Type");
			expect(result.headers["Access-Control-Allow-Methods"]).toBe("POST, OPTIONS");
			expect(result.body).toBe("");
		});

		test("non-POST method returns 405", async () => {
			const event = { httpMethod: "GET" };
			const result = await handler(event, mockContext);

			expect(result.statusCode).toBe(405);
		});

		test("PUT method returns 405", async () => {
			const event = { httpMethod: "PUT" };
			const result = await handler(event, mockContext);

			expect(result.statusCode).toBe(405);
		});

		test("validation failure returns 400 with error details", async () => {
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
			expect(body.errors).toEqual(["maker is required", "model is required"]);
		});

		test("invalid JSON body returns 500 error", async () => {
			const event = {
				httpMethod: "POST",
				body: "not-valid-json{{"
			};

			const result = await handler(event, mockContext);

			expect(result.statusCode).toBe(500);
			const body = JSON.parse(result.body);
			expect(body.error).toBe("Internal server error");
		});

		test("createJob failure returns 500 error", async () => {
			validateInitializeJob.mockReturnValue({ valid: true });
			createJob.mockRejectedValue(new Error("Database connection lost"));

			const event = postEvent("ACME", "MODEL-1");
			const result = await handler(event, mockContext);

			expect(result.statusCode).toBe(500);
		});

		test("successful SerpAPI search flow end-to-end", async () => {
			setupValidRequest("job-e2e");

			setupSerpAPI([
				{
					link: "https://example.com/product-MODEL-1",
					title: "Product MODEL-1",
					snippet: "Full product info"
				},
				{
					link: "https://example.com/related",
					title: "Related Info",
					snippet: "Also relevant"
				}
			]);

			const result = await handler(postEvent("ACME", "MODEL-1"), mockContext);

			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			expect(body.jobId).toBe("job-e2e");
			expect(body.status).toBe("urls_ready");
			expect(body.urlCount).toBe(2);

			// Verify createJob was called with maker and model
			expect(createJob).toHaveBeenCalledWith("ACME", "MODEL-1", mockContext);

			// Verify saveJobUrls was called with properly structured URLs
			expect(saveJobUrls).toHaveBeenCalledWith(
				"job-e2e",
				expect.arrayContaining([
					expect.objectContaining({
						index: 0,
						url: "https://example.com/product-MODEL-1",
						title: "Product MODEL-1"
					}),
					expect.objectContaining({
						index: 1,
						url: "https://example.com/related",
						title: "Related Info"
					})
				]),
				mockContext
			);
		});

		test("SerpAPI 'no results' error triggers handleNoSearchResults gracefully", async () => {
			setupValidRequest("job-serp-noresults-err");

			setupSerpAPIError(
				"Google hasn't returned any results for this query."
			);

			const result = await handler(postEvent("ACME", "RARE-MODEL"), mockContext);

			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			expect(body.status).toBe("complete");
			expect(body.strategy).toBe("no_results");
			expect(saveFinalResult).toHaveBeenCalledWith(
				"job-serp-noresults-err",
				expect.objectContaining({
					status: "UNKNOWN",
					explanation: "No search results found"
				}),
				mockContext
			);
		});

		test("SerpAPI real error returns 500", async () => {
			setupValidRequest("job-serp-apierr");

			setupSerpAPIError("API key invalid");

			const result = await handler(postEvent("ACME", "MODEL-ERR"), mockContext);

			expect(result.statusCode).toBe(500);
		});

		test("SerpAPI returns organic_results undefined treated as empty", async () => {
			setupValidRequest("job-serp-undefined");

			getJson.mockImplementation((params, callback) => {
				callback({}); // No organic_results key at all
			});

			const result = await handler(postEvent("ACME", "MODEL-UNDEF"), mockContext);

			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			expect(body.status).toBe("complete");
			expect(body.message).toContain("No search results");
		});

		test("search query includes configured sites", async () => {
			setupValidRequest("job-query-sites");

			let capturedParams = null;
			getJson.mockImplementation((params, callback) => {
				capturedParams = params;
				callback({ organic_results: [] });
			});

			await handler(postEvent("ACME", "MODEL-Q"), mockContext);

			expect(capturedParams).not.toBeNull();
			expect(capturedParams.q).toContain("site:site1.com");
			expect(capturedParams.q).toContain("site:site2.com");
			expect(capturedParams.engine).toBe("google");
			expect(capturedParams.google_domain).toBe("google.com");
		});
	});

	// =========================================================================
	// Additional edge case tests
	// =========================================================================
	describe("Edge cases and boundary conditions", () => {
		test("model with special characters is encoded in manufacturer URL", async () => {
			setupValidRequest("job-special");

			const result = await handler(postEvent("SMC", "SY 3120/5LZ"), mockContext);

			expect(result.statusCode).toBe(200);
			expect(saveJobUrls).toHaveBeenCalledWith(
				"job-special",
				expect.arrayContaining([
					expect.objectContaining({
						url: expect.stringContaining(
							encodeURIComponent("SY 3120/5LZ")
						)
					})
				]),
				mockContext
			);
		});

		test("maker with leading/trailing spaces is trimmed in getManufacturerUrl", async () => {
			setupValidRequest("job-trim");

			// The getManufacturerUrl function does .trim() on maker
			// But sanitizeString mock returns as-is, so the trim happens inside getManufacturerUrl
			const result = await handler(postEvent("  SMC  ", "MODEL1"), mockContext);

			// Since sanitizeString mock returns "  SMC  " as-is,
			// getManufacturerUrl trims to "SMC" internally but the switch case uses normalizedMaker
			// Actually looking at the code: normalizedMaker = maker.trim()
			// But maker comes from sanitizeString which returns as-is
			// However the switch uses normalizedMaker which is trimmed
			// But wait - the handler uses sanitizeString result which is "  SMC  "
			// Then getManufacturerUrl trims it to "SMC"
			// So it should match the SMC case
			expect(result.statusCode).toBe(200);
			const body = JSON.parse(result.body);
			expect(body.strategy).toBe("direct_url");
		});

		test("KEYENCE URL entry includes base URL", async () => {
			setupValidRequest("job-keyence-url");

			const result = await handler(postEvent("KEYENCE", "LR-ZB250"), mockContext);

			expect(result.statusCode).toBe(200);
			expect(saveJobUrls).toHaveBeenCalledWith(
				"job-keyence-url",
				expect.arrayContaining([
					expect.objectContaining({
						url: "https://www.keyence.co.jp/"
					})
				]),
				mockContext
			);
		});

		test("NISSIN ELECTRONIC fetch throws error, falls back to SerpAPI", async () => {
			setupValidRequest("job-nissin-fetcherr");

			global.fetch.mockRejectedValue(new Error("DNS resolution failed"));
			setupSerpAPI([]);

			const result = await handler(
				postEvent("NISSIN ELECTRONIC", "NE-ERR"),
				mockContext
			);

			expect(result.statusCode).toBe(200);
			// Should have fallen back to SerpAPI
			expect(getJson).toHaveBeenCalled();
		});

		test("NBK URL includes full query string with model", async () => {
			setupValidRequest("job-nbk-url");

			const result = await handler(postEvent("NBK", "MSCS-30"), mockContext);

			expect(result.statusCode).toBe(200);
			expect(saveJobUrls).toHaveBeenCalledWith(
				"job-nbk-url",
				expect.arrayContaining([
					expect.objectContaining({
						url: expect.stringContaining("q=MSCS-30")
					})
				]),
				mockContext
			);
		});
	});
});
