/**
 * Tests for netlify/functions/auto-eol-check-background.js
 * Tests helper functions by re-implementing their logic
 */

const mockGetStore = jest.fn();
jest.mock("@netlify/blobs", () => ({
	getStore: mockGetStore
}));

jest.mock("../netlify/functions/lib/csv-parser", () => ({
	parseCSV: jest.fn(),
	toCSV: jest.fn()
}));

jest.mock("../netlify/functions/lib/logger", () => ({
	info: jest.fn(),
	warn: jest.fn(),
	error: jest.fn(),
	debug: jest.fn()
}));

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

jest.mock("../netlify/functions/lib/job-storage", () => ({
	updateJobStatus: jest.fn()
}));

const originalEnv = { ...process.env };
const originalFetch = global.fetch;

describe("auto-eol-check-background", () => {
	beforeEach(() => {
		jest.clearAllMocks();

		global.fetch = jest.fn();
		process.env = { ...originalEnv };
		process.env.SITE_ID = "test-site";
		process.env.NETLIFY_TOKEN = "test-token";
		delete process.env.INTERNAL_API_KEY;

		jest.spyOn(console, "log").mockImplementation(() => {});
		jest.spyOn(console, "warn").mockImplementation(() => {});
		jest.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		global.fetch = originalFetch;
		process.env = { ...originalEnv };
		console.log.mockRestore();
		console.warn.mockRestore();
		console.error.mockRestore();
	});

	describe("isAutoCheckEnabled (re-implementation)", () => {
		// Re-implements: const autoCheckValue = (row[12] || "").trim().toUpperCase(); return autoCheckValue !== "NO";
		function isAutoCheckEnabled(row) {
			const autoCheckValue = (row[12] || "").trim().toUpperCase();
			return autoCheckValue !== "NO";
		}

		test("returns false when row[12] is 'NO'", () => {
			const row = new Array(13).fill("");
			row[12] = "NO";
			expect(isAutoCheckEnabled(row)).toBe(false);
		});

		test("returns false when row[12] is 'no' (case insensitive)", () => {
			const row = new Array(13).fill("");
			row[12] = "no";
			expect(isAutoCheckEnabled(row)).toBe(false);
		});

		test("returns false when row[12] is ' NO ' (with whitespace)", () => {
			const row = new Array(13).fill("");
			row[12] = " NO ";
			expect(isAutoCheckEnabled(row)).toBe(false);
		});

		test("returns true when row[12] is empty string", () => {
			const row = new Array(13).fill("");
			row[12] = "";
			expect(isAutoCheckEnabled(row)).toBe(true);
		});

		test("returns true when row[12] is 'YES'", () => {
			const row = new Array(13).fill("");
			row[12] = "YES";
			expect(isAutoCheckEnabled(row)).toBe(true);
		});

		test("returns true when row[12] is undefined", () => {
			const row = new Array(12).fill("");
			// row[12] is undefined since array only has 12 elements
			expect(isAutoCheckEnabled(row)).toBe(true);
		});

		test("returns true when row[12] is any other value", () => {
			const row = new Array(13).fill("");
			row[12] = "MAYBE";
			expect(isAutoCheckEnabled(row)).toBe(true);
		});
	});

	describe("hasFinalEOLStatus (re-implementation)", () => {
		// Re-implements: const eolStatus = (row[5] || "").trim().toUpperCase(); return eolStatus === "DISCONTINUED";
		function hasFinalEOLStatus(row) {
			const eolStatus = (row[5] || "").trim().toUpperCase();
			return eolStatus === "DISCONTINUED";
		}

		test("returns true when row[5] is 'DISCONTINUED'", () => {
			const row = new Array(13).fill("");
			row[5] = "DISCONTINUED";
			expect(hasFinalEOLStatus(row)).toBe(true);
		});

		test("returns true when row[5] is 'discontinued' (case insensitive)", () => {
			const row = new Array(13).fill("");
			row[5] = "discontinued";
			expect(hasFinalEOLStatus(row)).toBe(true);
		});

		test("returns true when row[5] is ' DISCONTINUED ' (with whitespace)", () => {
			const row = new Array(13).fill("");
			row[5] = " DISCONTINUED ";
			expect(hasFinalEOLStatus(row)).toBe(true);
		});

		test("returns false when row[5] is 'ACTIVE'", () => {
			const row = new Array(13).fill("");
			row[5] = "ACTIVE";
			expect(hasFinalEOLStatus(row)).toBe(false);
		});

		test("returns false when row[5] is empty string", () => {
			const row = new Array(13).fill("");
			row[5] = "";
			expect(hasFinalEOLStatus(row)).toBe(false);
		});

		test("returns false when row[5] is undefined", () => {
			const row = new Array(5).fill("");
			// row[5] is undefined
			expect(hasFinalEOLStatus(row)).toBe(false);
		});

		test("returns false when row[5] is 'UNKNOWN'", () => {
			const row = new Array(13).fill("");
			row[5] = "UNKNOWN";
			expect(hasFinalEOLStatus(row)).toBe(false);
		});

		test("returns false when row[5] is 'EOL'", () => {
			const row = new Array(13).fill("");
			row[5] = "EOL";
			expect(hasFinalEOLStatus(row)).toBe(false);
		});
	});

	describe("getGMT9Date (re-implementation)", () => {
		// Re-implements: const now = new Date(); const gmt9Time = new Date(now.getTime() + 9 * 60 * 60 * 1000); return gmt9Time.toISOString().split("T")[0];
		function getGMT9Date() {
			const now = new Date();
			const gmt9Time = new Date(now.getTime() + 9 * 60 * 60 * 1000);
			return gmt9Time.toISOString().split("T")[0];
		}

		test("returns a string in YYYY-MM-DD format", () => {
			const result = getGMT9Date();
			expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		});

		test("returns correct date when UTC time + 9 crosses midnight", () => {
			// Fixed UTC time: 2025-03-15T20:00:00Z
			// GMT+9 = 2025-03-16T05:00:00 (next day)
			const fixedDate = new Date("2025-03-15T20:00:00Z");
			const gmt9Time = new Date(fixedDate.getTime() + 9 * 60 * 60 * 1000);
			const result = gmt9Time.toISOString().split("T")[0];

			expect(result).toBe("2025-03-16");
		});

		test("returns same date when UTC time + 9 does not cross midnight", () => {
			// Fixed UTC time: 2025-03-15T10:00:00Z
			// GMT+9 = 2025-03-15T19:00:00 (same day)
			const fixedDate = new Date("2025-03-15T10:00:00Z");
			const gmt9Time = new Date(fixedDate.getTime() + 9 * 60 * 60 * 1000);
			const result = gmt9Time.toISOString().split("T")[0];

			expect(result).toBe("2025-03-15");
		});
	});

	describe("getGMT9DateTime (re-implementation)", () => {
		// Re-implements: const now = new Date(); return now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" });
		function getGMT9DateTime() {
			const now = new Date();
			return now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" });
		}

		test("returns a non-empty string", () => {
			const result = getGMT9DateTime();
			expect(typeof result).toBe("string");
			expect(result.length).toBeGreaterThan(0);
		});

		test("contains date-like components (month/day/year)", () => {
			const result = getGMT9DateTime();
			// en-US locale format: M/D/YYYY, H:MM:SS AM/PM
			expect(result).toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/);
		});

		test("contains time-like components", () => {
			const result = getGMT9DateTime();
			// Should contain time separator (colon)
			expect(result).toContain(":");
		});
	});

	describe("getInternalAuthHeaders (re-implementation)", () => {
		// Re-implements the getInternalAuthHeaders function
		function getInternalAuthHeaders() {
			const headers = { "Content-Type": "application/json" };
			if (process.env.INTERNAL_API_KEY) {
				headers["x-internal-key"] = process.env.INTERNAL_API_KEY;
			}
			return headers;
		}

		test("returns only Content-Type when INTERNAL_API_KEY is not set", () => {
			delete process.env.INTERNAL_API_KEY;

			const headers = getInternalAuthHeaders();

			expect(headers).toEqual({ "Content-Type": "application/json" });
			expect(headers["x-internal-key"]).toBeUndefined();
		});

		test("includes x-internal-key when INTERNAL_API_KEY is set", () => {
			process.env.INTERNAL_API_KEY = "test-internal-key";

			const headers = getInternalAuthHeaders();

			expect(headers).toEqual({
				"Content-Type": "application/json",
				"x-internal-key": "test-internal-key"
			});
		});

		test("uses the exact value of INTERNAL_API_KEY", () => {
			process.env.INTERNAL_API_KEY = "abc-123-xyz";

			const headers = getInternalAuthHeaders();

			expect(headers["x-internal-key"]).toBe("abc-123-xyz");
		});

		test("does not include key when INTERNAL_API_KEY is empty string", () => {
			process.env.INTERNAL_API_KEY = "";

			const headers = getInternalAuthHeaders();

			// Empty string is falsy so key should not be present
			expect(headers["x-internal-key"]).toBeUndefined();
		});
	});

	describe("handler module exports", () => {
		test("exports a handler function", () => {
			jest.resetModules();
			const mod = require("../netlify/functions/auto-eol-check-background");
			expect(mod.handler).toBeDefined();
			expect(typeof mod.handler).toBe("function");
		});

		test("handler is wrapped with requireHybridAuth", () => {
			jest.resetModules();
			require("../netlify/functions/auto-eol-check-background");
			const { requireHybridAuth } = require("../netlify/functions/lib/auth-middleware");
			expect(requireHybridAuth).toHaveBeenCalledTimes(1);
			expect(requireHybridAuth).toHaveBeenCalledWith(expect.any(Function));
		});
	});
});
