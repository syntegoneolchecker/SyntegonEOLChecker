/**
 * Extended tests for netlify/functions/auto-eol-check-background.js
 * Covers all _internal exports: utility helpers, wakeRenderService, waitForGroqTokens,
 * findNextProduct, executeEOLCheck, JobPoller, updateProduct, disableAutoCheckForMissingData,
 * autoEolCheckBackgroundHandler, and extracted handler functions.
 */

// ========== MOCKS ==========

const mockGetStore = jest.fn();
const mockStoreGet = jest.fn();
const mockStoreSet = jest.fn();

jest.mock("@netlify/blobs", () => ({
	getStore: (...args) => {
		mockGetStore(...args);
		return { get: mockStoreGet, set: mockStoreSet };
	}
}));

const mockParseCSV = jest.fn();
const mockToCSV = jest.fn();
jest.mock("../netlify/functions/lib/csv-parser", () => ({
	parseCSV: mockParseCSV,
	toCSV: mockToCSV
}));

const mockLogger = {
	info: jest.fn(),
	warn: jest.fn(),
	error: jest.fn(),
	debug: jest.fn()
};
jest.mock("../netlify/functions/lib/logger", () => mockLogger);

jest.mock("../netlify/functions/lib/config", () => ({
	MAX_AUTO_CHECKS_PER_DAY: 20,
	MIN_SERPAPI_CREDITS_FOR_AUTO: 30,
	DEFAULT_SCRAPING_SERVICE_URL: "https://eolscrapingservice.onrender.com",
	DEFAULT_NETLIFY_SITE_URL: "https://syntegoneolchecker.netlify.app",
	DEVELOP_NETLIFY_SITE_URL: "https://develop--syntegoneolchecker.netlify.app"
}));

jest.mock("../netlify/functions/lib/auth-middleware", () => ({
	requireHybridAuth: jest.fn((handler) => handler)
}));

const mockUpdateJobStatus = jest.fn();
jest.mock("../netlify/functions/lib/job-storage", () => ({
	updateJobStatus: mockUpdateJobStatus
}));

// ========== GLOBALS ==========

const originalFetch = global.fetch;
const originalEnv = { ...process.env };

beforeEach(() => {
	jest.clearAllMocks();
	jest.useFakeTimers({ advanceTimers: true });

	global.fetch = jest.fn();

	process.env.SITE_ID = "test-site-id";
	process.env.NETLIFY_BLOBS_TOKEN = "test-token";
	process.env.SCRAPING_SERVICE_URL = "https://test-scraping.example.com";
	delete process.env.INTERNAL_API_KEY;
	delete process.env.DEPLOY_PRIME_URL;
	delete process.env.DEPLOY_URL;
	delete process.env.URL;

	mockStoreGet.mockReset();
	mockStoreSet.mockReset();
	mockGetStore.mockClear();
	mockParseCSV.mockReset();
	mockToCSV.mockReset();
	mockUpdateJobStatus.mockReset();
});

afterEach(() => {
	jest.useRealTimers();
	global.fetch = originalFetch;
	process.env = { ...originalEnv };
});

// ========== REQUIRE MODULE ==========

const {
	getInternalAuthHeaders,
	getGMT9Date,
	getGMT9DateTime,
	wakeRenderService,
	waitForGroqTokens,
	isAutoCheckEnabled,
	hasFinalEOLStatus,
	findNextProduct,
	executeEOLCheck,
	JobPoller,
	updateProduct,
	disableAutoCheckForMissingData,
	autoEolCheckBackgroundHandler,
	initializeFromEvent,
	validateAndPrepareForCheck,
	processNextProduct,
	determineChainContinuation,
	handleErrorState,
	updateAutoCheckState,
	triggerNextCheck,
	stopChain,
	prepareForEOLCheck
} = require("../netlify/functions/auto-eol-check-background")._internal;

// ========== HELPERS ==========

function makeRow({
	sap = "SAP001",
	col1 = "",
	col2 = "",
	model = "Model-X",
	manufacturer = "MakerA",
	status = "",
	comment = "",
	successor = "",
	successorComment = "",
	col9 = "",
	col10 = "",
	infoDate = "",
	autoCheck = ""
} = {}) {
	return [sap, col1, col2, model, manufacturer, status, comment, successor, successorComment, col9, col10, infoDate, autoCheck];
}

function makeCSVData(header, rows) {
	return { success: true, data: [header, ...rows], error: null };
}

const HEADER_ROW = ["SAP", "Col1", "Col2", "Model", "Manufacturer", "Status", "Comment", "Successor", "SuccComment", "Col9", "Col10", "InfoDate", "AutoCheck"];

// ========== TESTS ==========

describe("auto-eol-check-background extended", () => {
	// =========================================================================
	// 1. Utility Helpers
	// =========================================================================
	describe("getInternalAuthHeaders", () => {
		test("returns Content-Type header when no INTERNAL_API_KEY", () => {
			delete process.env.INTERNAL_API_KEY;
			const headers = getInternalAuthHeaders();
			expect(headers).toEqual({ "Content-Type": "application/json" });
			expect(headers["x-internal-key"]).toBeUndefined();
		});

		test("includes x-internal-key when INTERNAL_API_KEY is set", () => {
			process.env.INTERNAL_API_KEY = "my-secret-key";
			const headers = getInternalAuthHeaders();
			expect(headers).toEqual({
				"Content-Type": "application/json",
				"x-internal-key": "my-secret-key"
			});
		});

		test("returns fresh headers each call (not cached)", () => {
			process.env.INTERNAL_API_KEY = "key1";
			const h1 = getInternalAuthHeaders();
			process.env.INTERNAL_API_KEY = "key2";
			const h2 = getInternalAuthHeaders();
			expect(h1["x-internal-key"]).toBe("key1");
			expect(h2["x-internal-key"]).toBe("key2");
		});
	});

	describe("getGMT9Date", () => {
		test("returns date string in YYYY-MM-DD format", () => {
			const result = getGMT9Date();
			expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		});

		test("applies GMT+9 offset correctly", () => {
			// Set time to 2024-01-15 20:00 UTC => 2024-01-16 05:00 GMT+9
			jest.setSystemTime(new Date("2024-01-15T20:00:00.000Z"));
			const result = getGMT9Date();
			expect(result).toBe("2024-01-16");
		});
	});

	describe("getGMT9DateTime", () => {
		test("returns a non-empty string", () => {
			const result = getGMT9DateTime();
			expect(typeof result).toBe("string");
			expect(result.length).toBeGreaterThan(0);
		});

		test("uses Asia/Tokyo timezone", () => {
			jest.setSystemTime(new Date("2024-06-15T12:30:00.000Z"));
			const result = getGMT9DateTime();
			// 12:30 UTC => 21:30 JST
			expect(result).toContain("9:30");
		});
	});

	describe("isAutoCheckEnabled", () => {
		test("returns true when column 12 is empty", () => {
			expect(isAutoCheckEnabled(makeRow({ autoCheck: "" }))).toBe(true);
		});

		test("returns true when column 12 is YES", () => {
			expect(isAutoCheckEnabled(makeRow({ autoCheck: "YES" }))).toBe(true);
		});

		test("returns false when column 12 is NO", () => {
			expect(isAutoCheckEnabled(makeRow({ autoCheck: "NO" }))).toBe(false);
		});

		test("returns false when column 12 is no (lowercase)", () => {
			expect(isAutoCheckEnabled(makeRow({ autoCheck: "no" }))).toBe(false);
		});

		test("returns false when column 12 is NO with whitespace", () => {
			expect(isAutoCheckEnabled(makeRow({ autoCheck: "  NO  " }))).toBe(false);
		});

		test("returns true when column 12 is undefined", () => {
			const row = makeRow();
			row[12] = undefined;
			expect(isAutoCheckEnabled(row)).toBe(true);
		});
	});

	describe("hasFinalEOLStatus", () => {
		test("returns true when status is DISCONTINUED", () => {
			expect(hasFinalEOLStatus(makeRow({ status: "DISCONTINUED" }))).toBe(true);
		});

		test("returns true when status is discontinued (lowercase)", () => {
			expect(hasFinalEOLStatus(makeRow({ status: "discontinued" }))).toBe(true);
		});

		test("returns false when status is ACTIVE", () => {
			expect(hasFinalEOLStatus(makeRow({ status: "ACTIVE" }))).toBe(false);
		});

		test("returns false when status is empty", () => {
			expect(hasFinalEOLStatus(makeRow({ status: "" }))).toBe(false);
		});

		test("returns false when status is undefined", () => {
			const row = makeRow();
			row[5] = undefined;
			expect(hasFinalEOLStatus(row)).toBe(false);
		});
	});

	// =========================================================================
	// 2. wakeRenderService
	// =========================================================================
	describe("wakeRenderService", () => {
		test("returns true on first successful health check", async () => {
			global.fetch = jest.fn().mockResolvedValue({ ok: true });

			const promise = wakeRenderService();
			// Advance past setTimeout waits
			await jest.advanceTimersByTimeAsync(1000);
			const result = await promise;

			expect(result).toBe(true);
			expect(global.fetch).toHaveBeenCalledTimes(1);
			expect(global.fetch).toHaveBeenCalledWith(
				"https://test-scraping.example.com/health",
				expect.objectContaining({ signal: expect.anything() })
			);
		});

		test("retries on non-ok response and succeeds on second attempt", async () => {
			let callCount = 0;
			global.fetch = jest.fn().mockImplementation(() => {
				callCount++;
				if (callCount === 1) {
					return Promise.resolve({ ok: false, status: 503 });
				}
				return Promise.resolve({ ok: true });
			});

			const promise = wakeRenderService();

			// First attempt fails, then waits 30s
			await jest.advanceTimersByTimeAsync(35000);
			// Second attempt succeeds
			await jest.advanceTimersByTimeAsync(5000);

			const result = await promise;
			expect(result).toBe(true);
			expect(global.fetch).toHaveBeenCalledTimes(2);
		});

		test("retries on fetch error and succeeds later", async () => {
			let callCount = 0;
			global.fetch = jest.fn().mockImplementation(() => {
				callCount++;
				if (callCount === 1) {
					return Promise.reject(new Error("Connection refused"));
				}
				return Promise.resolve({ ok: true });
			});

			const promise = wakeRenderService();

			await jest.advanceTimersByTimeAsync(35000);
			await jest.advanceTimersByTimeAsync(5000);

			const result = await promise;
			expect(result).toBe(true);
			// logger.warn is called with a single formatted string
			expect(mockLogger.warn).toHaveBeenCalledWith(
				expect.stringContaining("Attempt 1 failed")
			);
		});

		test("returns false after 2 minutes of failures", async () => {
			global.fetch = jest.fn().mockRejectedValue(new Error("timeout"));

			const promise = wakeRenderService();

			// Advance past 2 minutes (120s) + buffer
			await jest.advanceTimersByTimeAsync(150000);

			const result = await promise;
			expect(result).toBe(false);
			expect(mockLogger.error).toHaveBeenCalledWith(
				expect.stringContaining("Failed to wake Render service")
			);
		});

		test("uses DEFAULT_SCRAPING_SERVICE_URL when env var not set", async () => {
			delete process.env.SCRAPING_SERVICE_URL;
			global.fetch = jest.fn().mockResolvedValue({ ok: true });

			const promise = wakeRenderService();
			await jest.advanceTimersByTimeAsync(1000);
			await promise;

			expect(global.fetch).toHaveBeenCalledWith(
				"https://eolscrapingservice.onrender.com/health",
				expect.anything()
			);
		});
	});

	// =========================================================================
	// 3. waitForGroqTokens
	// =========================================================================
	describe("waitForGroqTokens", () => {
		const siteUrl = "https://test-site.example.com";

		test("returns immediately when resetSeconds is null (N/A)", async () => {
			global.fetch = jest.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ resetSeconds: null })
			});

			const promise = waitForGroqTokens(siteUrl);
			await jest.advanceTimersByTimeAsync(100);
			await promise;

			expect(mockLogger.info).toHaveBeenCalledWith("Groq tokens fully reset (N/A)");
		});

		test("returns immediately when resetSeconds is undefined", async () => {
			global.fetch = jest.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({})
			});

			const promise = waitForGroqTokens(siteUrl);
			await jest.advanceTimersByTimeAsync(100);
			await promise;

			expect(mockLogger.info).toHaveBeenCalledWith("Groq tokens fully reset (N/A)");
		});

		test("waits for resetSeconds + 1 when resetSeconds > 0", async () => {
			global.fetch = jest.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ resetSeconds: 5 })
			});

			const promise = waitForGroqTokens(siteUrl);

			// Should wait for (5 + 1) * 1000 = 6000ms
			await jest.advanceTimersByTimeAsync(6100);
			await promise;

			expect(mockLogger.info).toHaveBeenCalledWith(
				expect.stringContaining("Groq tokens reset in 5s")
			);
			expect(mockLogger.info).toHaveBeenCalledWith("Groq tokens should be reset now");
		});

		test("returns true when resetSeconds is 0", async () => {
			global.fetch = jest.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ resetSeconds: 0 })
			});

			const promise = waitForGroqTokens(siteUrl);
			await jest.advanceTimersByTimeAsync(100);
			const result = await promise;

			expect(result).toBe(true);
		});

		test("returns undefined when fetch fails (proceeds anyway)", async () => {
			global.fetch = jest.fn().mockRejectedValue(new Error("Network error"));

			const result = await waitForGroqTokens(siteUrl);

			expect(result).toBeUndefined();
			expect(mockLogger.error).toHaveBeenCalledWith(
				"Error checking Groq tokens:",
				"Network error"
			);
		});

		test("returns undefined when response is not ok", async () => {
			global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });

			const result = await waitForGroqTokens(siteUrl);

			expect(result).toBeUndefined();
		});

		test("calls get-groq-usage with internal auth headers", async () => {
			process.env.INTERNAL_API_KEY = "groq-key";
			global.fetch = jest.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ resetSeconds: null })
			});

			const promise = waitForGroqTokens(siteUrl);
			await jest.advanceTimersByTimeAsync(100);
			await promise;

			expect(global.fetch).toHaveBeenCalledWith(
				`${siteUrl}/.netlify/functions/get-groq-usage`,
				{
					headers: {
						"Content-Type": "application/json",
						"x-internal-key": "groq-key"
					}
				}
			);
		});
	});

	// =========================================================================
	// 4. findNextProduct
	// =========================================================================
	describe("findNextProduct", () => {
		test("returns null when database is empty (no CSV content)", async () => {
			mockStoreGet.mockResolvedValue(null);

			const result = await findNextProduct();
			expect(result).toBeNull();
			expect(mockLogger.info).toHaveBeenCalledWith("No products in database");
		});

		test("returns null when CSV has only header row", async () => {
			mockStoreGet.mockResolvedValue("header-csv");
			mockParseCSV.mockReturnValue({ success: true, data: [HEADER_ROW] });

			const result = await findNextProduct();
			expect(result).toBeNull();
			expect(mockLogger.info).toHaveBeenCalledWith("No products in database (only headers)");
		});

		test("returns null when CSV parsing fails", async () => {
			mockStoreGet.mockResolvedValue("bad-csv");
			mockParseCSV.mockReturnValue({ success: false, error: "Invalid format" });

			const result = await findNextProduct();
			expect(result).toBeNull();
			expect(mockLogger.error).toHaveBeenCalledWith("CSV parsing failed:", "Invalid format");
		});

		test("returns null when all products have Auto Check disabled (NO)", async () => {
			mockStoreGet.mockResolvedValue("csv-data");
			mockParseCSV.mockReturnValue(makeCSVData(HEADER_ROW, [
				makeRow({ sap: "SAP001", autoCheck: "NO" }),
				makeRow({ sap: "SAP002", autoCheck: "NO" })
			]));

			const result = await findNextProduct();
			expect(result).toBeNull();
			expect(mockLogger.info).toHaveBeenCalledWith("No products with Auto Check enabled");
		});

		test("returns null when all enabled products are DISCONTINUED", async () => {
			mockStoreGet.mockResolvedValue("csv-data");
			mockParseCSV.mockReturnValue(makeCSVData(HEADER_ROW, [
				makeRow({ sap: "SAP001", status: "DISCONTINUED", autoCheck: "" }),
				makeRow({ sap: "SAP002", status: "DISCONTINUED", autoCheck: "YES" })
			]));

			const result = await findNextProduct();
			expect(result).toBeNull();
			expect(mockLogger.info).toHaveBeenCalledWith(
				"No products to check (all are either Auto Check disabled or DISCONTINUED)"
			);
		});

		test("prioritizes unchecked products (empty Information Date)", async () => {
			const uncheckedRow = makeRow({ sap: "SAP001", infoDate: "", autoCheck: "" });
			const checkedRow = makeRow({ sap: "SAP002", infoDate: "2024-01-01", autoCheck: "" });

			mockStoreGet.mockResolvedValue("csv-data");
			mockParseCSV.mockReturnValue(makeCSVData(HEADER_ROW, [checkedRow, uncheckedRow]));

			const result = await findNextProduct();
			expect(result[0]).toBe("SAP001");
		});

		test("returns first unchecked product when multiple unchecked exist", async () => {
			const row1 = makeRow({ sap: "SAP001", infoDate: "", autoCheck: "" });
			const row2 = makeRow({ sap: "SAP002", infoDate: "", autoCheck: "" });

			mockStoreGet.mockResolvedValue("csv-data");
			mockParseCSV.mockReturnValue(makeCSVData(HEADER_ROW, [row1, row2]));

			const result = await findNextProduct();
			expect(result[0]).toBe("SAP001");
		});

		test("selects oldest-dated product when all are checked", async () => {
			const oldRow = makeRow({ sap: "SAP001", infoDate: "2023-06-01", autoCheck: "" });
			const newRow = makeRow({ sap: "SAP002", infoDate: "2024-01-15", autoCheck: "" });

			mockStoreGet.mockResolvedValue("csv-data");
			mockParseCSV.mockReturnValue(makeCSVData(HEADER_ROW, [newRow, oldRow]));

			const result = await findNextProduct();
			expect(result[0]).toBe("SAP001");
		});

		test("skips disabled and discontinued, returns valid product", async () => {
			const disabledRow = makeRow({ sap: "SAP001", autoCheck: "NO" });
			const discontinuedRow = makeRow({ sap: "SAP002", status: "DISCONTINUED", autoCheck: "" });
			const validRow = makeRow({ sap: "SAP003", infoDate: "", autoCheck: "" });

			mockStoreGet.mockResolvedValue("csv-data");
			mockParseCSV.mockReturnValue(makeCSVData(HEADER_ROW, [disabledRow, discontinuedRow, validRow]));

			const result = await findNextProduct();
			expect(result[0]).toBe("SAP003");
		});

		test("logs CSV parsing warnings but continues", async () => {
			mockStoreGet.mockResolvedValue("csv-data");
			mockParseCSV.mockReturnValue({
				success: true,
				data: [HEADER_ROW, makeRow({ sap: "SAP001", infoDate: "", autoCheck: "" })],
				error: "Some warning"
			});

			const result = await findNextProduct();
			expect(result).not.toBeNull();
			expect(mockLogger.warn).toHaveBeenCalledWith("CSV parsing warnings:", "Some warning");
		});

		test("returns null on unexpected error (catch block)", async () => {
			mockStoreGet.mockRejectedValue(new Error("Blob storage error"));

			const result = await findNextProduct();
			expect(result).toBeNull();
			expect(mockLogger.error).toHaveBeenCalledWith(
				"Error finding next product:",
				expect.any(Error)
			);
		});
	});

	// =========================================================================
	// 5. executeEOLCheck
	// =========================================================================
	describe("executeEOLCheck", () => {
		const siteUrl = "https://test-site.example.com";

		test("returns false and disables auto-check when model is missing", async () => {
			const product = makeRow({ sap: "SAP001", model: "", manufacturer: "MakerA" });

			// Mock disableAutoCheckForMissingData's store calls
			mockStoreGet.mockResolvedValue("csv-data");
			mockParseCSV.mockReturnValue(makeCSVData(HEADER_ROW, [product]));
			mockToCSV.mockReturnValue("updated-csv");
			mockStoreSet.mockResolvedValue();

			const result = await executeEOLCheck(product, siteUrl);
			expect(result).toBe(false);
			expect(mockLogger.info).toHaveBeenCalledWith(
				expect.stringContaining("Missing model")
			);
		});

		test("returns false and disables auto-check when manufacturer is missing", async () => {
			const product = makeRow({ sap: "SAP001", model: "Model-X", manufacturer: "" });

			mockStoreGet.mockResolvedValue("csv-data");
			mockParseCSV.mockReturnValue(makeCSVData(HEADER_ROW, [product]));
			mockToCSV.mockReturnValue("updated-csv");
			mockStoreSet.mockResolvedValue();

			const result = await executeEOLCheck(product, siteUrl);
			expect(result).toBe(false);
			expect(mockLogger.info).toHaveBeenCalledWith(
				expect.stringContaining("Missing manufacturer")
			);
		});

		test("returns false and disables auto-check when both model and manufacturer missing", async () => {
			const product = makeRow({ sap: "SAP001", model: "", manufacturer: "" });

			mockStoreGet.mockResolvedValue("csv-data");
			mockParseCSV.mockReturnValue(makeCSVData(HEADER_ROW, [product]));
			mockToCSV.mockReturnValue("updated-csv");
			mockStoreSet.mockResolvedValue();

			const result = await executeEOLCheck(product, siteUrl);
			expect(result).toBe(false);
			expect(mockLogger.info).toHaveBeenCalledWith(
				expect.stringContaining("Missing manufacturer/model")
			);
		});

		test("returns false when initialize-job returns non-ok", async () => {
			const product = makeRow({ sap: "SAP001", model: "Model-X", manufacturer: "MakerA" });
			global.fetch = jest.fn().mockResolvedValue({
				ok: false,
				status: 500,
				text: () => Promise.resolve("Server error")
			});

			const result = await executeEOLCheck(product, siteUrl);
			expect(result).toBe(false);
			expect(mockLogger.error).toHaveBeenCalledWith(
				"Job initialization failed:",
				500,
				"Server error"
			);
		});

		test("returns false when no jobId is returned", async () => {
			const product = makeRow({ sap: "SAP001", model: "Model-X", manufacturer: "MakerA" });
			global.fetch = jest.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({})
			});

			const result = await executeEOLCheck(product, siteUrl);
			expect(result).toBe(false);
			expect(mockLogger.error).toHaveBeenCalledWith("No job ID received");
		});

		test("returns false when polling returns null", async () => {
			const product = makeRow({ sap: "SAP001", model: "Model-X", manufacturer: "MakerA" });

			// init-job succeeds
			global.fetch = jest.fn()
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ jobId: "job-123" })
				});

			// JobPoller.poll will call jobStore.get which returns null repeatedly
			mockStoreGet.mockResolvedValue(null);

			const promise = executeEOLCheck(product, siteUrl);

			// Advance timers for all 60 poll attempts (2s each)
			for (let i = 0; i < 65; i++) {
				await jest.advanceTimersByTimeAsync(2100);
			}

			const result = await promise;
			expect(result).toBe(false);
		});

		test("returns true on successful check with completed job", async () => {
			const product = makeRow({ sap: "SAP001", model: "Model-X", manufacturer: "MakerA" });
			const finalResult = {
				status: "ACTIVE",
				explanation: "Product is active",
				successor: { model: null, explanation: "" }
			};

			// init-job succeeds
			global.fetch = jest.fn()
				.mockResolvedValueOnce({
					ok: true,
					json: () => Promise.resolve({ jobId: "job-123" })
				})
				// updateAutoCheckState and other fetch calls
				.mockResolvedValue({ ok: true });

			// Job store returns complete job on first poll
			mockStoreGet.mockResolvedValueOnce({
				status: "complete",
				finalResult
			});

			// For updateProduct
			mockStoreGet.mockResolvedValueOnce("csv-data");
			mockParseCSV.mockReturnValue(makeCSVData(HEADER_ROW, [product]));
			mockToCSV.mockReturnValue("updated-csv");
			mockStoreSet.mockResolvedValue();

			const promise = executeEOLCheck(product, siteUrl);
			await jest.advanceTimersByTimeAsync(3000);
			const result = await promise;

			expect(result).toBe(true);
		});

		test("returns false when fetch throws an error", async () => {
			const product = makeRow({ sap: "SAP001", model: "Model-X", manufacturer: "MakerA" });
			global.fetch = jest.fn().mockRejectedValue(new Error("Network failure"));

			const result = await executeEOLCheck(product, siteUrl);
			expect(result).toBe(false);
			expect(mockLogger.error).toHaveBeenCalledWith("EOL check error:", expect.any(Error));
		});
	});

	// =========================================================================
	// 6. JobPoller class
	// =========================================================================
	describe("JobPoller", () => {
		const siteUrl = "https://test-site.example.com";
		let poller;

		beforeEach(() => {
			poller = new JobPoller("job-123", "MakerA", "Model-X", siteUrl);
		});

		test("constructor initializes all properties correctly", () => {
			expect(poller.jobId).toBe("job-123");
			expect(poller.manufacturer).toBe("MakerA");
			expect(poller.model).toBe("Model-X");
			expect(poller.siteUrl).toBe(siteUrl);
			expect(poller.maxAttempts).toBe(60);
			expect(poller.attempts).toBe(0);
			expect(poller.analyzeTriggered).toBe(false);
			expect(poller.fetchTriggered).toBe(false);
			expect(poller.completionResult).toBeNull();
		});

		test("initializeStorage creates job store and assigns updateJobStatus", () => {
			expect(poller.jobStore).toBeDefined();
			expect(poller.jobStore.get).toBeDefined();
			expect(poller.updateJobStatus).toBe(mockUpdateJobStatus);
		});

		describe("poll()", () => {
			test("returns finalResult when job is immediately complete", async () => {
				const finalResult = {
					status: "ACTIVE",
					explanation: "Active product",
					successor: { model: null, explanation: "" }
				};

				mockStoreGet.mockResolvedValue({
					status: "complete",
					finalResult
				});

				const promise = poller.poll();
				await jest.advanceTimersByTimeAsync(3000);
				const result = await promise;

				expect(result).toEqual(finalResult);
				expect(poller.attempts).toBe(1);
			});

			test("returns timeout result after maxAttempts", async () => {
				// At attempt 15, a health check is performed. We need fetch to succeed for it.
				global.fetch = jest.fn().mockResolvedValue({
					ok: true,
					json: () => Promise.resolve({ memory: { rss: 100 }, requestCount: 1 })
				});

				mockStoreGet.mockResolvedValue({
					status: "processing",
					urls: []
				});

				const promise = poller.poll();

				for (let i = 0; i < 65; i++) {
					await jest.advanceTimersByTimeAsync(2100);
				}

				const result = await promise;
				expect(result.status).toBe("UNKNOWN");
				expect(result.explanation).toContain("timed out");
				expect(poller.attempts).toBe(60);
			});

			test("returns error result when job status is error", async () => {
				mockStoreGet.mockResolvedValue({
					status: "error",
					error: "Groq API failed"
				});

				const promise = poller.poll();
				await jest.advanceTimersByTimeAsync(3000);
				const result = await promise;

				expect(result.status).toBe("UNKNOWN");
				expect(result.explanation).toContain("Groq API failed");
			});
		});

		describe("pollAttempt()", () => {
			test("handles missing job (null from store)", async () => {
				mockStoreGet.mockResolvedValueOnce(null);

				poller.attempts = 1;
				const promise = poller.pollAttempt();
				await jest.advanceTimersByTimeAsync(5000);
				await promise;

				expect(mockLogger.error).toHaveBeenCalledWith(
					expect.stringContaining("not found in Blobs storage")
				);
				expect(poller.completionResult).toBeNull();
			});

			test("sets completionResult when job is complete", async () => {
				const finalResult = { status: "EOL", explanation: "End of life" };
				mockStoreGet.mockResolvedValue({
					status: "complete",
					finalResult
				});

				poller.attempts = 1;
				await poller.pollAttempt();

				expect(poller.completionResult).toEqual(finalResult);
			});

			test("sets completionResult when job has error", async () => {
				mockStoreGet.mockResolvedValue({
					status: "error",
					error: "Some error"
				});

				poller.attempts = 1;
				await poller.pollAttempt();

				expect(poller.completionResult).not.toBeNull();
				expect(poller.completionResult.status).toBe("UNKNOWN");
			});

			test("calls orchestrateWorkflow for in-progress job", async () => {
				mockStoreGet.mockResolvedValue({
					status: "processing",
					urls: []
				});

				poller.attempts = 1;
				const spy = jest.spyOn(poller, "orchestrateWorkflow");

				const promise = poller.pollAttempt();
				await jest.advanceTimersByTimeAsync(3000);
				await promise;

				expect(spy).toHaveBeenCalled();
			});
		});

		describe("logProgress()", () => {
			test("logs at every 30th attempt", () => {
				poller.attempts = 30;
				poller.logProgress();
				expect(mockLogger.info).toHaveBeenCalledWith(
					expect.stringContaining("Polling attempt 30/60")
				);
			});

			test("does not log at non-30th attempts", () => {
				mockLogger.info.mockClear();
				poller.attempts = 15;
				poller.logProgress();
				// logProgress only logs for attempts % 30 === 0
				const infoCalls = mockLogger.info.mock.calls.filter(
					call => typeof call[0] === "string" && call[0].includes("Polling attempt")
				);
				expect(infoCalls.length).toBe(0);
			});

			test("logs at attempt 60", () => {
				poller.attempts = 60;
				poller.logProgress();
				expect(mockLogger.info).toHaveBeenCalledWith(
					expect.stringContaining("Polling attempt 60/60")
				);
			});
		});

		describe("checkRenderHealthIfNeeded()", () => {
			test("performs health check at attempt 15", async () => {
				poller.attempts = 15;

				global.fetch = jest.fn().mockResolvedValue({
					ok: true,
					json: () => Promise.resolve({ memory: { rss: 200 }, requestCount: 5 })
				});

				await poller.checkRenderHealthIfNeeded();

				expect(global.fetch).toHaveBeenCalledWith(
					expect.stringContaining("/health"),
					expect.anything()
				);
				expect(mockLogger.info).toHaveBeenCalledWith(
					expect.stringContaining("Render service healthy")
				);
			});

			test("does nothing at attempts other than 15", async () => {
				poller.attempts = 14;
				global.fetch = jest.fn();

				await poller.checkRenderHealthIfNeeded();
				expect(global.fetch).not.toHaveBeenCalled();

				poller.attempts = 16;
				await poller.checkRenderHealthIfNeeded();
				expect(global.fetch).not.toHaveBeenCalled();
			});

			test("throws health check failure error when service is unhealthy", async () => {
				poller.attempts = 15;

				global.fetch = jest.fn().mockResolvedValue({
					ok: false,
					status: 500
				});

				try {
					await poller.checkRenderHealthIfNeeded();
					expect(true).toBe(false); // Should not reach
				} catch (err) {
					expect(err.isHealthCheckFailure).toBe(true);
					expect(err.result.status).toBe("UNKNOWN");
					expect(err.result.explanation).toContain("scraping service appears to have crashed");
				}
			});

			test("throws health check failure error when fetch throws", async () => {
				poller.attempts = 15;

				global.fetch = jest.fn().mockRejectedValue(new Error("Connection timeout"));

				try {
					await poller.checkRenderHealthIfNeeded();
					expect(true).toBe(false); // Should not reach
				} catch (err) {
					expect(err.isHealthCheckFailure).toBe(true);
					expect(err.result.status).toBe("UNKNOWN");
				}
			});
		});

		describe("handleJobCompletion()", () => {
			test("returns finalResult when job is complete", async () => {
				const finalResult = { status: "ACTIVE", explanation: "All good" };
				poller.attempts = 5;

				const result = await poller.handleJobCompletion({
					status: "complete",
					finalResult
				});

				expect(result).toEqual(finalResult);
			});

			test("returns null when job is not complete", async () => {
				const result = await poller.handleJobCompletion({
					status: "processing"
				});

				expect(result).toBeNull();
			});

			test("returns null when complete but no finalResult", async () => {
				const result = await poller.handleJobCompletion({
					status: "complete",
					finalResult: null
				});

				expect(result).toBeNull();
			});
		});

		describe("handleJobError()", () => {
			test("returns UNKNOWN result when job has error status", async () => {
				const result = await poller.handleJobError({
					status: "error",
					error: "LLM quota exceeded"
				});

				expect(result).toEqual({
					status: "UNKNOWN",
					explanation: "Job failed: LLM quota exceeded",
					successor: { status: "UNKNOWN", model: null, explanation: "" }
				});
			});

			test("returns null when job does not have error status", async () => {
				const result = await poller.handleJobError({
					status: "processing"
				});

				expect(result).toBeNull();
			});
		});

		describe("triggerFetchIfNeeded()", () => {
			test("triggers fetch when status is urls_ready and not yet triggered", async () => {
				const job = {
					status: "urls_ready",
					urls: [{ index: 0, url: "https://example.com/page", title: "Page", snippet: "test", scrapingMethod: "render" }]
				};

				mockUpdateJobStatus.mockResolvedValue();
				global.fetch = jest.fn().mockResolvedValue({ ok: true });

				await poller.triggerFetchIfNeeded(job);

				expect(poller.fetchTriggered).toBe(true);
				expect(mockUpdateJobStatus).toHaveBeenCalledWith("job-123", "fetching", null, {});
			});

			test("does not trigger fetch when already triggered", async () => {
				poller.fetchTriggered = true;
				const job = { status: "urls_ready", urls: [{ index: 0, url: "https://example.com" }] };

				await poller.triggerFetchIfNeeded(job);

				expect(mockUpdateJobStatus).not.toHaveBeenCalled();
			});

			test("does not trigger fetch when status is not urls_ready", async () => {
				const job = { status: "processing", urls: [] };

				await poller.triggerFetchIfNeeded(job);

				expect(poller.fetchTriggered).toBe(false);
			});
		});

		describe("triggerFetchUrl()", () => {
			test("updates job status and fires fetch request", async () => {
				const job = {
					urls: [{
						index: 0,
						url: "https://example.com/page",
						title: "Page Title",
						snippet: "Some snippet",
						scrapingMethod: "render"
					}]
				};

				mockUpdateJobStatus.mockResolvedValue();
				global.fetch = jest.fn().mockResolvedValue({ ok: true });
				poller.attempts = 3;

				await poller.triggerFetchUrl(job);

				expect(mockUpdateJobStatus).toHaveBeenCalledWith("job-123", "fetching", null, {});
				expect(global.fetch).toHaveBeenCalledWith(
					`${siteUrl}/.netlify/functions/fetch-url`,
					expect.objectContaining({
						method: "POST",
						body: expect.stringContaining("job-123")
					})
				);
			});

			test("handles empty urls array gracefully", async () => {
				const job = { urls: [] };
				mockUpdateJobStatus.mockResolvedValue();

				await poller.triggerFetchUrl(job);

				// updateJobStatus still called, but no fetch fired
				expect(mockUpdateJobStatus).toHaveBeenCalled();
			});
		});

		describe("buildFetchPayload()", () => {
			test("builds payload with all fields", () => {
				const url = {
					index: 2,
					url: "https://example.com",
					title: "Title",
					snippet: "Snippet",
					scrapingMethod: "render",
					model: "ModelOverride"
				};

				const payload = poller.buildFetchPayload(url);

				expect(payload).toEqual({
					jobId: "job-123",
					urlIndex: 2,
					url: "https://example.com",
					title: "Title",
					snippet: "Snippet",
					scrapingMethod: "render",
					model: "ModelOverride"
				});
			});

			test("omits model field when not present in url", () => {
				const url = {
					index: 0,
					url: "https://example.com",
					title: "Title",
					snippet: "Snippet",
					scrapingMethod: "http"
				};

				const payload = poller.buildFetchPayload(url);
				expect(payload.model).toBeUndefined();
			});
		});

		describe("triggerAnalysisIfNeeded()", () => {
			test("triggers analysis when all URLs complete and not yet triggered", async () => {
				const job = {
					status: "fetching",
					urls: [
						{ status: "complete" },
						{ status: "complete" }
					]
				};

				global.fetch = jest.fn().mockResolvedValue({
					ok: true,
					json: () => Promise.resolve({ result: { status: "ACTIVE" } })
				});
				mockStoreGet.mockResolvedValue({ status: "complete", finalResult: { status: "ACTIVE" } });

				await poller.triggerAnalysisIfNeeded(job);

				expect(poller.analyzeTriggered).toBe(true);
			});

			test("does not trigger when already triggered", async () => {
				poller.analyzeTriggered = true;
				const job = {
					status: "fetching",
					urls: [{ status: "complete" }]
				};

				global.fetch = jest.fn();
				await poller.triggerAnalysisIfNeeded(job);

				expect(global.fetch).not.toHaveBeenCalled();
			});

			test("does not trigger when URLs are not all complete", async () => {
				const job = {
					status: "fetching",
					urls: [
						{ status: "complete" },
						{ status: "pending" }
					]
				};

				global.fetch = jest.fn();
				await poller.triggerAnalysisIfNeeded(job);

				expect(poller.analyzeTriggered).toBe(false);
			});

			test("does not trigger when status is already analyzing", async () => {
				const job = {
					status: "analyzing",
					urls: [{ status: "complete" }]
				};

				global.fetch = jest.fn();
				await poller.triggerAnalysisIfNeeded(job);

				expect(poller.analyzeTriggered).toBe(false);
			});

			test("does not trigger when status is already complete", async () => {
				const job = {
					status: "complete",
					urls: [{ status: "complete" }]
				};

				global.fetch = jest.fn();
				await poller.triggerAnalysisIfNeeded(job);

				expect(poller.analyzeTriggered).toBe(false);
			});

			test("does not trigger when urls array is empty", async () => {
				const job = {
					status: "fetching",
					urls: []
				};

				global.fetch = jest.fn();
				await poller.triggerAnalysisIfNeeded(job);

				expect(poller.analyzeTriggered).toBe(false);
			});
		});

		describe("callAnalyzeJob()", () => {
			test("calls analyze-job endpoint and returns result", async () => {
				global.fetch = jest.fn().mockResolvedValue({
					ok: true,
					json: () => Promise.resolve({ result: { status: "EOL" } })
				});
				mockStoreGet.mockResolvedValue({ status: "processing" });

				const result = await poller.callAnalyzeJob();
				expect(result).toEqual({ status: "EOL" });
				expect(global.fetch).toHaveBeenCalledWith(
					`${siteUrl}/.netlify/functions/analyze-job`,
					expect.objectContaining({
						method: "POST",
						body: JSON.stringify({ jobId: "job-123" })
					})
				);
			});

			test("throws when analyze-job returns non-ok response", async () => {
				global.fetch = jest.fn().mockResolvedValue({
					ok: false,
					status: 500,
					text: () => Promise.resolve("Internal error")
				});

				await expect(poller.callAnalyzeJob()).rejects.toThrow("analyze-job failed: 500 - Internal error");
			});
		});

		describe("handleAnalyzeJobError()", () => {
			test("logs warning for timeout errors", () => {
				const error = new Error("timeout");
				error.name = "TimeoutError";
				poller.handleAnalyzeJobError(error);

				expect(mockLogger.warn).toHaveBeenCalledWith(
					expect.stringContaining("analyze-job timed out")
				);
			});

			test("logs error for non-timeout errors", () => {
				const error = new Error("Something broke");
				poller.handleAnalyzeJobError(error);

				expect(mockLogger.error).toHaveBeenCalledWith(
					expect.stringContaining("analyze-job error: Something broke")
				);
			});

			test("treats message containing timeout as timeout error", () => {
				const error = new Error("Request timeout after 25s");
				poller.handleAnalyzeJobError(error);

				expect(mockLogger.warn).toHaveBeenCalledWith(
					expect.stringContaining("analyze-job timed out")
				);
			});
		});

		describe("handlePollingError()", () => {
			test("re-throws health check failure result", async () => {
				const error = new Error("Health check");
				error.isHealthCheckFailure = true;
				error.result = { status: "UNKNOWN", explanation: "crashed" };

				await expect(poller.handlePollingError(error)).rejects.toEqual(error.result);
			});

			test("logs error and waits for non-health-check errors", async () => {
				const error = new Error("Random error");
				poller.attempts = 5;

				const promise = poller.handlePollingError(error);
				await jest.advanceTimersByTimeAsync(2100);
				await promise;

				expect(mockLogger.error).toHaveBeenCalledWith(
					expect.stringContaining("Polling error (attempt 5): Random error")
				);
			});
		});

		describe("handleTimeout()", () => {
			test("returns UNKNOWN result with timeout message", () => {
				const result = poller.handleTimeout();

				expect(result.status).toBe("UNKNOWN");
				expect(result.explanation).toContain("timed out");
				expect(result.explanation).toContain("2 minutes");
				expect(result.successor).toEqual({
					status: "UNKNOWN",
					model: null,
					explanation: ""
				});
			});
		});

		describe("waitForNextPoll()", () => {
			test("waits for 2000ms", async () => {
				const start = Date.now();
				const promise = poller.waitForNextPoll();
				await jest.advanceTimersByTimeAsync(2000);
				await promise;
				// If we got here, the promise resolved after timer advance
				expect(true).toBe(true);
			});
		});

		describe("orchestrateWorkflow()", () => {
			test("calls triggerFetchIfNeeded and triggerAnalysisIfNeeded", async () => {
				const fetchSpy = jest.spyOn(poller, "triggerFetchIfNeeded").mockResolvedValue();
				const analyzeSpy = jest.spyOn(poller, "triggerAnalysisIfNeeded").mockResolvedValue();

				const job = { status: "processing", urls: [] };
				await poller.orchestrateWorkflow(job);

				expect(fetchSpy).toHaveBeenCalledWith(job);
				expect(analyzeSpy).toHaveBeenCalledWith(job);
			});
		});

		describe("performHealthCheck()", () => {
			test("succeeds when health endpoint returns ok", async () => {
				global.fetch = jest.fn().mockResolvedValue({
					ok: true,
					json: () => Promise.resolve({ memory: { rss: 150 }, requestCount: 10 })
				});

				await poller.performHealthCheck();

				expect(mockLogger.info).toHaveBeenCalledWith(
					expect.stringContaining("Render service healthy")
				);
			});

			test("throws when health endpoint returns non-ok", async () => {
				global.fetch = jest.fn().mockResolvedValue({
					ok: false,
					status: 503
				});

				await expect(poller.performHealthCheck()).rejects.toThrow(
					"Render service unhealthy (HTTP 503)"
				);
			});
		});

		describe("handleHealthCheckFailure()", () => {
			test("throws error with isHealthCheckFailure flag and result", async () => {
				const error = new Error("Connection refused");

				try {
					await poller.handleHealthCheckFailure(error);
					expect(true).toBe(false); // Should not reach
				} catch (thrown) {
					expect(thrown.isHealthCheckFailure).toBe(true);
					expect(thrown.result.status).toBe("UNKNOWN");
					expect(thrown.result.explanation).toContain("scraping service appears to have crashed");
				}
			});
		});

		describe("checkJobCompletionAfterAnalysis()", () => {
			test("returns finalResult when job is complete after analysis", async () => {
				const finalResult = { status: "EOL", explanation: "Discontinued" };
				mockStoreGet.mockResolvedValue({
					status: "complete",
					finalResult
				});

				const result = await poller.checkJobCompletionAfterAnalysis();
				expect(result).toEqual(finalResult);
			});

			test("returns null when job is not complete after analysis", async () => {
				mockStoreGet.mockResolvedValue({
					status: "analyzing"
				});

				const result = await poller.checkJobCompletionAfterAnalysis();
				expect(result).toBeNull();
			});
		});
	});

	// =========================================================================
	// 7. updateProduct
	// =========================================================================
	describe("updateProduct", () => {
		const result = {
			status: "EOL",
			explanation: "Product discontinued in 2024",
			successor: { model: "Model-Y", explanation: "Direct replacement" }
		};

		test("updates the correct row columns and saves CSV", async () => {
			const row = makeRow({ sap: "SAP001" });
			mockStoreGet.mockResolvedValue("csv-data");
			mockParseCSV.mockReturnValue(makeCSVData(HEADER_ROW, [row]));
			mockToCSV.mockReturnValue("updated-csv");
			mockStoreSet.mockResolvedValue();

			await updateProduct("SAP001", result);

			// Verify row was updated
			expect(row[5]).toBe("EOL");
			expect(row[6]).toBe("Product discontinued in 2024");
			expect(row[7]).toBe("Model-Y");
			expect(row[8]).toBe("Direct replacement");
			expect(row[11]).toBeTruthy(); // GMT+9 date time

			expect(mockToCSV).toHaveBeenCalled();
			expect(mockStoreSet).toHaveBeenCalledWith("database.csv", "updated-csv");
			expect(mockLogger.info).toHaveBeenCalledWith("Database updated for SAP001");
		});

		test("handles missing database gracefully", async () => {
			mockStoreGet.mockResolvedValue(null);

			await updateProduct("SAP001", result);

			expect(mockLogger.error).toHaveBeenCalledWith("Database not found");
			expect(mockStoreSet).not.toHaveBeenCalled();
		});

		test("handles missing product in database", async () => {
			mockStoreGet.mockResolvedValue("csv-data");
			mockParseCSV.mockReturnValue(makeCSVData(HEADER_ROW, [
				makeRow({ sap: "SAP999" })
			]));

			await updateProduct("SAP001", result);

			expect(mockLogger.error).toHaveBeenCalledWith("Product SAP001 not found in database");
			expect(mockStoreSet).not.toHaveBeenCalled();
		});

		test("handles CSV parsing failure", async () => {
			mockStoreGet.mockResolvedValue("bad-csv");
			mockParseCSV.mockReturnValue({ success: false, error: "Parse error" });

			await updateProduct("SAP001", result);

			expect(mockLogger.error).toHaveBeenCalledWith(
				"CSV parsing failed during product update:",
				"Parse error"
			);
		});

		test("handles result with missing successor", async () => {
			const partialResult = { status: "UNKNOWN", explanation: "No data" };
			const row = makeRow({ sap: "SAP001" });
			mockStoreGet.mockResolvedValue("csv-data");
			mockParseCSV.mockReturnValue(makeCSVData(HEADER_ROW, [row]));
			mockToCSV.mockReturnValue("updated-csv");
			mockStoreSet.mockResolvedValue();

			await updateProduct("SAP001", partialResult);

			expect(row[5]).toBe("UNKNOWN");
			expect(row[7]).toBe("");
			expect(row[8]).toBe("");
		});

		test("handles store error gracefully via catch block", async () => {
			mockStoreGet.mockRejectedValue(new Error("Store unavailable"));

			await updateProduct("SAP001", result);

			expect(mockLogger.error).toHaveBeenCalledWith(
				"Error updating product:",
				expect.any(Error)
			);
		});
	});

	// =========================================================================
	// 8. disableAutoCheckForMissingData
	// =========================================================================
	describe("disableAutoCheckForMissingData", () => {
		test("updates row with disabled message and saves CSV", async () => {
			const row = makeRow({ sap: "SAP001", autoCheck: "YES" });
			mockStoreGet.mockResolvedValue("csv-data");
			mockParseCSV.mockReturnValue(makeCSVData(HEADER_ROW, [row]));
			mockToCSV.mockReturnValue("updated-csv");
			mockStoreSet.mockResolvedValue();

			await disableAutoCheckForMissingData("SAP001", "model");

			expect(row[6]).toBe("Auto Check disabled: Missing model information");
			expect(row[12]).toBe("NO");
			expect(row[11]).toBeTruthy(); // GMT+9 date time
			expect(mockStoreSet).toHaveBeenCalledWith("database.csv", "updated-csv");
		});

		test("handles missing database", async () => {
			mockStoreGet.mockResolvedValue(null);

			// Should not throw since the function logs and returns
			await disableAutoCheckForMissingData("SAP001", "manufacturer");

			expect(mockLogger.error).toHaveBeenCalledWith("Database not found");
		});

		test("handles missing product", async () => {
			mockStoreGet.mockResolvedValue("csv-data");
			mockParseCSV.mockReturnValue(makeCSVData(HEADER_ROW, [
				makeRow({ sap: "SAP999" })
			]));

			await disableAutoCheckForMissingData("SAP001", "model");

			expect(mockLogger.error).toHaveBeenCalledWith("Product SAP001 not found in database");
		});

		test("handles CSV parsing failure and rethrows", async () => {
			mockStoreGet.mockResolvedValue("bad-csv");
			mockParseCSV.mockReturnValue({ success: false, error: "Bad format" });

			await expect(disableAutoCheckForMissingData("SAP001", "model")).rejects.toThrow(
				"CSV parsing failed: Bad format"
			);
		});

		test("sets correct message for manufacturer/model field", async () => {
			const row = makeRow({ sap: "SAP001" });
			mockStoreGet.mockResolvedValue("csv-data");
			mockParseCSV.mockReturnValue(makeCSVData(HEADER_ROW, [row]));
			mockToCSV.mockReturnValue("updated-csv");
			mockStoreSet.mockResolvedValue();

			await disableAutoCheckForMissingData("SAP001", "manufacturer/model");

			expect(row[6]).toBe("Auto Check disabled: Missing manufacturer/model information");
		});

		test("rethrows on store error", async () => {
			mockStoreGet.mockRejectedValue(new Error("Storage failure"));

			await expect(disableAutoCheckForMissingData("SAP001", "model")).rejects.toThrow(
				"Storage failure"
			);
		});
	});

	// =========================================================================
	// 9. validateAndPrepareForCheck
	// =========================================================================
	describe("validateAndPrepareForCheck", () => {
		const siteUrl = "https://test-site.example.com";

		test("returns shouldContinue: false when disabled", async () => {
			global.fetch = jest.fn().mockResolvedValue({ ok: true });

			const state = { enabled: false, dailyCounter: 0, lastResetDate: "2024-01-01" };
			const store = { get: jest.fn() };

			const result = await validateAndPrepareForCheck(state, siteUrl, store);

			expect(result.shouldContinue).toBe(false);
			expect(result.reason).toBe("Disabled");
			expect(global.fetch).toHaveBeenCalled(); // updateAutoCheckState called
		});

		test("resets counter on new day and returns shouldContinue: true", async () => {
			jest.setSystemTime(new Date("2024-06-15T20:00:00.000Z"));
			global.fetch = jest.fn().mockResolvedValue({ ok: true });

			const currentGMT9 = getGMT9Date();
			const state = { enabled: true, dailyCounter: 15, lastResetDate: "2024-06-15" };
			// lastResetDate doesn't match current GMT+9 date
			const store = {
				get: jest.fn().mockResolvedValue({ enabled: true, dailyCounter: 0, lastResetDate: currentGMT9 })
			};

			const result = await validateAndPrepareForCheck(state, siteUrl, store);

			expect(result.shouldContinue).toBe(true);
			expect(result.updatedState).toBeDefined();
		});

		test("returns shouldContinue: false when daily limit reached", async () => {
			jest.setSystemTime(new Date("2024-06-15T10:00:00.000Z"));
			global.fetch = jest.fn().mockResolvedValue({ ok: true });

			const currentGMT9 = getGMT9Date();
			const state = { enabled: true, dailyCounter: 20, lastResetDate: currentGMT9 };
			const store = { get: jest.fn() };

			const result = await validateAndPrepareForCheck(state, siteUrl, store);

			expect(result.shouldContinue).toBe(false);
			expect(result.reason).toBe("Daily limit reached");
		});

		test("returns shouldContinue: true when under daily limit", async () => {
			jest.setSystemTime(new Date("2024-06-15T10:00:00.000Z"));
			global.fetch = jest.fn().mockResolvedValue({ ok: true });

			const currentGMT9 = getGMT9Date();
			const state = { enabled: true, dailyCounter: 5, lastResetDate: currentGMT9 };
			const store = { get: jest.fn() };

			const result = await validateAndPrepareForCheck(state, siteUrl, store);

			expect(result.shouldContinue).toBe(true);
			expect(result.updatedState).toBeUndefined();
		});

		test("returns shouldContinue: false at exact daily limit", async () => {
			jest.setSystemTime(new Date("2024-06-15T10:00:00.000Z"));
			global.fetch = jest.fn().mockResolvedValue({ ok: true });

			const currentGMT9 = getGMT9Date();
			const state = { enabled: true, dailyCounter: 20, lastResetDate: currentGMT9 };
			const store = { get: jest.fn() };

			const result = await validateAndPrepareForCheck(state, siteUrl, store);

			expect(result.shouldContinue).toBe(false);
		});
	});

	// =========================================================================
	// 10. processNextProduct
	// =========================================================================
	describe("processNextProduct", () => {
		const siteUrl = "https://test-site.example.com";

		test("stops chain when no product found", async () => {
			global.fetch = jest.fn().mockResolvedValue({ ok: true });
			// findNextProduct returns null
			mockStoreGet.mockResolvedValue(null);

			const state = { enabled: true, dailyCounter: 5 };
			const store = { get: jest.fn() };

			const result = await processNextProduct(state, siteUrl, store);

			expect(result.shouldStopChain).toBe(true);
			expect(result.reason).toBe("No products to check");
		});

		test("stops chain when auto-check disabled before EOL check", async () => {
			// findNextProduct returns a product
			const product = makeRow({ sap: "SAP001", model: "Model-X", manufacturer: "MakerA", infoDate: "" });
			mockStoreGet.mockResolvedValueOnce("csv-data"); // findNextProduct: csvStore.get
			mockParseCSV.mockReturnValue(makeCSVData(HEADER_ROW, [product]));

			const store = {
				get: jest.fn().mockResolvedValue({ enabled: false, dailyCounter: 5, isRunning: true })
			};

			global.fetch = jest.fn().mockResolvedValue({ ok: true });

			const state = { enabled: true, dailyCounter: 5 };
			const result = await processNextProduct(state, siteUrl, store);

			expect(result.shouldStopChain).toBe(true);
			expect(result.reason).toBe("Disabled before check");
		});

		test("executes check and increments counter on success", async () => {
			const product = makeRow({ sap: "SAP001", model: "Model-X", manufacturer: "MakerA", infoDate: "" });
			const finalResult = {
				status: "ACTIVE",
				explanation: "Active product",
				successor: { model: null, explanation: "" }
			};

			// findNextProduct
			mockStoreGet
				.mockResolvedValueOnce("csv-data"); // findNextProduct: csvStore.get
			mockParseCSV.mockReturnValueOnce(makeCSVData(HEADER_ROW, [product]));

			const store = {
				get: jest.fn().mockResolvedValue({ enabled: true, dailyCounter: 5, isRunning: true })
			};

			// executeEOLCheck: init-job
			global.fetch = jest.fn()
				.mockResolvedValueOnce({ // init-job
					ok: true,
					json: () => Promise.resolve({ jobId: "job-123" })
				})
				.mockResolvedValue({ ok: true }); // subsequent calls

			// JobPoller: job store returns complete
			mockStoreGet
				.mockResolvedValueOnce({ status: "complete", finalResult }) // poll
				.mockResolvedValueOnce("csv-data"); // updateProduct: csvStore.get
			mockParseCSV.mockReturnValueOnce(makeCSVData(HEADER_ROW, [product]));
			mockToCSV.mockReturnValue("updated-csv");
			mockStoreSet.mockResolvedValue();

			const state = { enabled: true, dailyCounter: 5 };
			const promise = processNextProduct(state, siteUrl, store);
			await jest.advanceTimersByTimeAsync(5000);
			const result = await promise;

			expect(result.shouldStopChain).toBe(false);
			expect(result.newCounter).toBe(6);
			expect(result.shouldContinue).toBe(true);
		});

		test("increments counter even when EOL check fails", async () => {
			const product = makeRow({ sap: "SAP001", model: "Model-X", manufacturer: "MakerA", infoDate: "" });

			// findNextProduct
			mockStoreGet.mockResolvedValueOnce("csv-data");
			mockParseCSV.mockReturnValueOnce(makeCSVData(HEADER_ROW, [product]));

			const store = {
				get: jest.fn().mockResolvedValue({ enabled: true, dailyCounter: 3, isRunning: true })
			};

			// executeEOLCheck: init-job fails
			global.fetch = jest.fn()
				.mockResolvedValueOnce({
					ok: false,
					status: 500,
					text: () => Promise.resolve("Error")
				})
				.mockResolvedValue({ ok: true });

			const state = { enabled: true, dailyCounter: 3 };
			const result = await processNextProduct(state, siteUrl, store);

			expect(result.shouldStopChain).toBe(false);
			expect(result.newCounter).toBe(4);
		});

		test("uses pre-check state counter for incrementing", async () => {
			const product = makeRow({ sap: "SAP001", model: "Model-X", manufacturer: "MakerA", infoDate: "" });

			mockStoreGet.mockResolvedValueOnce("csv-data");
			mockParseCSV.mockReturnValueOnce(makeCSVData(HEADER_ROW, [product]));

			const store = {
				get: jest.fn().mockResolvedValue({ enabled: true, dailyCounter: 10, isRunning: true })
			};

			global.fetch = jest.fn()
				.mockResolvedValueOnce({
					ok: false,
					status: 500,
					text: () => Promise.resolve("Error")
				})
				.mockResolvedValue({ ok: true });

			const state = { enabled: true, dailyCounter: 10 };
			const result = await processNextProduct(state, siteUrl, store);

			expect(result.newCounter).toBe(11);
		});
	});

	// =========================================================================
	// 11. determineChainContinuation
	// =========================================================================
	describe("determineChainContinuation", () => {
		const siteUrl = "https://test-site.example.com";

		test("triggers next check when enabled and under limit", async () => {
			const store = {
				get: jest.fn().mockResolvedValue({ enabled: true, dailyCounter: 5, isRunning: true })
			};

			global.fetch = jest.fn().mockResolvedValue({ ok: true });

			await determineChainContinuation(siteUrl, store);

			expect(mockLogger.info).toHaveBeenCalledWith(
				expect.stringContaining("Slider still enabled, triggering next check")
			);
		});

		test("stops chain when daily limit reached", async () => {
			const store = {
				get: jest.fn().mockResolvedValue({ enabled: true, dailyCounter: 20, isRunning: true })
			};

			global.fetch = jest.fn().mockResolvedValue({ ok: true });

			await determineChainContinuation(siteUrl, store);

			expect(mockLogger.info).toHaveBeenCalledWith(
				expect.stringContaining("Chain stopped: daily limit reached")
			);
		});

		test("stops chain when disabled", async () => {
			const store = {
				get: jest.fn().mockResolvedValue({ enabled: false, dailyCounter: 5, isRunning: true })
			};

			global.fetch = jest.fn().mockResolvedValue({ ok: true });

			await determineChainContinuation(siteUrl, store);

			expect(mockLogger.info).toHaveBeenCalledWith(
				expect.stringContaining("Chain stopped: slider disabled")
			);
		});

		test("stops chain when both disabled and at limit", async () => {
			const store = {
				get: jest.fn().mockResolvedValue({ enabled: false, dailyCounter: 20, isRunning: true })
			};

			global.fetch = jest.fn().mockResolvedValue({ ok: true });

			await determineChainContinuation(siteUrl, store);

			// enabled is false, so reason is "slider disabled"
			expect(mockLogger.info).toHaveBeenCalledWith(
				expect.stringContaining("Chain stopped: slider disabled")
			);
		});
	});

	// =========================================================================
	// 12. autoEolCheckBackgroundHandler
	// =========================================================================
	describe("autoEolCheckBackgroundHandler", () => {
		const siteUrl = "https://test-site.example.com";

		function makeEvent(body = {}) {
			return { body: JSON.stringify(body) };
		}

		test("returns 200 when state is not initialized", async () => {
			mockStoreGet.mockResolvedValue(null); // store.get("state") returns null

			const event = makeEvent({ siteUrl });
			const result = await autoEolCheckBackgroundHandler(event, {});

			expect(result.statusCode).toBe(200);
			expect(result.body).toBe("State not initialized");
		});

		test("returns 200 when auto-check is disabled", async () => {
			mockStoreGet.mockResolvedValue({ enabled: false, dailyCounter: 0 });
			global.fetch = jest.fn().mockResolvedValue({ ok: true });

			const event = makeEvent({ siteUrl });
			const result = await autoEolCheckBackgroundHandler(event, {});

			expect(result.statusCode).toBe(200);
			expect(result.body).toBe("Disabled");
		});

		test("returns 200 when daily limit reached", async () => {
			jest.setSystemTime(new Date("2024-06-15T10:00:00.000Z"));
			const currentGMT9 = getGMT9Date();

			mockStoreGet.mockResolvedValue({
				enabled: true,
				dailyCounter: 20,
				lastResetDate: currentGMT9
			});
			global.fetch = jest.fn().mockResolvedValue({ ok: true });

			const event = makeEvent({ siteUrl });
			const result = await autoEolCheckBackgroundHandler(event, {});

			expect(result.statusCode).toBe(200);
			expect(result.body).toBe("Daily limit reached");
		});

		test("returns 200 when Render service not ready on first check", async () => {
			jest.setSystemTime(new Date("2024-06-15T10:00:00.000Z"));
			const currentGMT9 = getGMT9Date();

			mockStoreGet.mockResolvedValue({
				enabled: true,
				dailyCounter: 0,
				lastResetDate: currentGMT9
			});

			// wakeRenderService fails - return non-ok responses
			global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 });

			const event = makeEvent({ siteUrl });
			const promise = autoEolCheckBackgroundHandler(event, {});

			// Advance past wakeRenderService's 2-minute timeout (120s) plus buffer
			// wakeRenderService has multiple 30s waits, advance in chunks
			for (let i = 0; i < 10; i++) {
				await jest.advanceTimersByTimeAsync(30000);
			}
			const result = await promise;

			expect(result.statusCode).toBe(200);
			expect(result.body).toBe("Render not ready");
		});

		test("returns 200 when no products to check", async () => {
			jest.setSystemTime(new Date("2024-06-15T10:00:00.000Z"));
			const currentGMT9 = getGMT9Date();

			// First call: initializeFromEvent store.get("state")
			// Second call: findNextProduct csvStore.get (null = no products)
			let callCount = 0;
			mockStoreGet.mockImplementation(() => {
				callCount++;
				if (callCount <= 1) {
					return Promise.resolve({
						enabled: true,
						dailyCounter: 1, // Not 0 to skip wakeRenderService
						lastResetDate: currentGMT9,
						isRunning: true
					});
				}
				// Groq usage
				if (callCount === 2) {
					return Promise.resolve(null); // No CSV
				}
				return Promise.resolve(null);
			});

			global.fetch = jest.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ resetSeconds: null })
			});

			const event = makeEvent({ siteUrl });
			const promise = autoEolCheckBackgroundHandler(event, {});
			await jest.advanceTimersByTimeAsync(5000);
			const result = await promise;

			expect(result.statusCode).toBe(200);
			expect(result.body).toBe("No products to check");
		});

		test("returns 500 on unexpected error and calls handleErrorState", async () => {
			// Force an error by making event.body invalid JSON
			const event = { body: "{invalid json" };
			global.fetch = jest.fn().mockResolvedValue({ ok: true });

			const result = await autoEolCheckBackgroundHandler(event, {});

			expect(result.statusCode).toBe(500);
			const body = JSON.parse(result.body);
			expect(body.error).toBeDefined();
		});

		test("uses siteUrl from event body when provided", async () => {
			mockStoreGet.mockResolvedValue(null);

			const event = makeEvent({ siteUrl: "https://custom-site.example.com" });
			await autoEolCheckBackgroundHandler(event, {});

			expect(mockLogger.info).toHaveBeenCalledWith(
				expect.stringContaining("https://custom-site.example.com")
			);
		});

		test("falls back to environment variables when siteUrl not in body", async () => {
			process.env.DEPLOY_PRIME_URL = "https://deploy-prime.example.com";
			mockStoreGet.mockResolvedValue(null);

			const event = makeEvent({});
			await autoEolCheckBackgroundHandler(event, {});

			expect(mockLogger.info).toHaveBeenCalledWith(
				expect.stringContaining("https://deploy-prime.example.com")
			);
		});
	});

	// =========================================================================
	// 13. handleErrorState, updateAutoCheckState, triggerNextCheck, stopChain, prepareForEOLCheck
	// =========================================================================
	describe("handleErrorState", () => {
		test("calls updateAutoCheckState with isRunning: false using siteUrl from event", async () => {
			global.fetch = jest.fn().mockResolvedValue({ ok: true });

			await handleErrorState({ body: JSON.stringify({ siteUrl: "https://my-site.example.com" }) });

			expect(global.fetch).toHaveBeenCalledWith(
				"https://my-site.example.com/.netlify/functions/set-auto-check-state",
				expect.objectContaining({
					method: "POST",
					body: JSON.stringify({ isRunning: false })
				})
			);
		});

		test("falls back to env vars when siteUrl not in event body", async () => {
			process.env.DEPLOY_PRIME_URL = "https://fallback.example.com";
			global.fetch = jest.fn().mockResolvedValue({ ok: true });

			await handleErrorState({ body: "{}" });

			expect(global.fetch).toHaveBeenCalledWith(
				"https://fallback.example.com/.netlify/functions/set-auto-check-state",
				expect.anything()
			);
		});

		test("handles errors in handleErrorState gracefully", async () => {
			global.fetch = jest.fn().mockRejectedValue(new Error("Network down"));

			// Should not throw
			await handleErrorState({ body: "{}" });

			expect(mockLogger.error).toHaveBeenCalledWith(
				"Failed to update state on error:",
				expect.any(Error)
			);
		});
	});

	describe("updateAutoCheckState", () => {
		test("sends POST request to set-auto-check-state endpoint", async () => {
			global.fetch = jest.fn().mockResolvedValue({ ok: true });

			await updateAutoCheckState("https://site.example.com", { isRunning: false, dailyCounter: 5 });

			expect(global.fetch).toHaveBeenCalledWith(
				"https://site.example.com/.netlify/functions/set-auto-check-state",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ isRunning: false, dailyCounter: 5 })
				}
			);
		});

		test("includes INTERNAL_API_KEY in headers when set", async () => {
			process.env.INTERNAL_API_KEY = "secret";
			global.fetch = jest.fn().mockResolvedValue({ ok: true });

			await updateAutoCheckState("https://site.example.com", { isRunning: true });

			expect(global.fetch).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({
					headers: expect.objectContaining({
						"x-internal-key": "secret"
					})
				})
			);
		});
	});

	describe("triggerNextCheck", () => {
		test("fires fetch to auto-eol-check-background endpoint", async () => {
			global.fetch = jest.fn().mockResolvedValue({ ok: true });

			await triggerNextCheck("https://site.example.com");

			expect(global.fetch).toHaveBeenCalledWith(
				"https://site.example.com/.netlify/functions/auto-eol-check-background",
				expect.objectContaining({
					method: "POST",
					body: expect.stringContaining("chain")
				})
			);
			expect(mockLogger.info).toHaveBeenCalledWith("Next check triggered");
		});

		test("logs error when fetch call throws in outer try-catch", async () => {
			// The inner .catch handles promise rejection, test the outer catch
			global.fetch = jest.fn().mockImplementation(() => {
				throw new Error("Sync error");
			});

			await triggerNextCheck("https://site.example.com");

			expect(mockLogger.error).toHaveBeenCalledWith(
				"Error triggering next check:",
				"Sync error"
			);
		});
	});

	describe("stopChain", () => {
		test("logs daily limit reason when enabled is true", async () => {
			global.fetch = jest.fn().mockResolvedValue({ ok: true });

			await stopChain("https://site.example.com", { enabled: true, dailyCounter: 20 });

			expect(mockLogger.info).toHaveBeenCalledWith(
				expect.stringContaining("daily limit reached")
			);
		});

		test("logs slider disabled reason when enabled is false", async () => {
			global.fetch = jest.fn().mockResolvedValue({ ok: true });

			await stopChain("https://site.example.com", { enabled: false, dailyCounter: 5 });

			expect(mockLogger.info).toHaveBeenCalledWith(
				expect.stringContaining("slider disabled")
			);
		});

		test("calls updateAutoCheckState with isRunning: false", async () => {
			global.fetch = jest.fn().mockResolvedValue({ ok: true });

			await stopChain("https://site.example.com", { enabled: true, dailyCounter: 20 });

			expect(global.fetch).toHaveBeenCalledWith(
				"https://site.example.com/.netlify/functions/set-auto-check-state",
				expect.objectContaining({
					body: JSON.stringify({ isRunning: false })
				})
			);
		});
	});

	describe("prepareForEOLCheck", () => {
		test("calls waitForGroqTokens and waits 2 seconds", async () => {
			global.fetch = jest.fn().mockResolvedValue({
				ok: true,
				json: () => Promise.resolve({ resetSeconds: null })
			});

			const promise = prepareForEOLCheck("https://site.example.com");
			await jest.advanceTimersByTimeAsync(3000);
			await promise;

			expect(global.fetch).toHaveBeenCalledWith(
				"https://site.example.com/.netlify/functions/get-groq-usage",
				expect.anything()
			);
		});
	});

	describe("initializeFromEvent", () => {
		test("extracts siteUrl from event body", async () => {
			const event = { body: JSON.stringify({ siteUrl: "https://passed-site.example.com" }) };

			const { siteUrl, store } = await initializeFromEvent(event);

			expect(siteUrl).toBe("https://passed-site.example.com");
			expect(store).toBeDefined();
		});

		test("falls back to DEPLOY_PRIME_URL when no siteUrl in body", async () => {
			process.env.DEPLOY_PRIME_URL = "https://deploy-prime.example.com";
			const event = { body: JSON.stringify({}) };

			const { siteUrl } = await initializeFromEvent(event);

			expect(siteUrl).toBe("https://deploy-prime.example.com");
		});

		test("falls back to DEPLOY_URL when DEPLOY_PRIME_URL not set", async () => {
			delete process.env.DEPLOY_PRIME_URL;
			process.env.DEPLOY_URL = "https://deploy-url.example.com";
			const event = { body: JSON.stringify({}) };

			const { siteUrl } = await initializeFromEvent(event);

			expect(siteUrl).toBe("https://deploy-url.example.com");
		});

		test("falls back to URL env var", async () => {
			delete process.env.DEPLOY_PRIME_URL;
			delete process.env.DEPLOY_URL;
			process.env.URL = "https://url-env.example.com";
			const event = { body: JSON.stringify({}) };

			const { siteUrl } = await initializeFromEvent(event);

			expect(siteUrl).toBe("https://url-env.example.com");
		});

		test("falls back to DEVELOP_NETLIFY_SITE_URL config", async () => {
			delete process.env.DEPLOY_PRIME_URL;
			delete process.env.DEPLOY_URL;
			delete process.env.URL;
			const event = { body: JSON.stringify({}) };

			const { siteUrl } = await initializeFromEvent(event);

			expect(siteUrl).toBe("https://develop--syntegoneolchecker.netlify.app");
		});

		test("handles empty body string", async () => {
			const event = { body: "" };

			const { siteUrl } = await initializeFromEvent(event);

			// Falls through to env/config
			expect(siteUrl).toBeDefined();
		});

		test("creates store with correct config", async () => {
			process.env.SITE_ID = "my-site-id";
			process.env.NETLIFY_BLOBS_TOKEN = "my-token";
			const event = { body: JSON.stringify({ siteUrl: "https://example.com" }) };

			await initializeFromEvent(event);

			expect(mockGetStore).toHaveBeenCalledWith({
				name: "auto-check-state",
				siteID: "my-site-id",
				token: "my-token"
			});
		});
	});
});
