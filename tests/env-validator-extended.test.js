/**
 * Extended tests for env-validator.js
 * Covers validateAllEnvVars (the comprehensive validator)
 */

describe("Environment Validator - validateAllEnvVars", () => {
	let envValidator;
	let originalEnv;

	beforeEach(() => {
		originalEnv = { ...process.env };

		// Clear all relevant env vars
		delete process.env.SITE_ID;
		delete process.env.SERPAPI_API_KEY;
		delete process.env.GROQ_API_KEY;
		delete process.env.SCRAPING_API_KEY;
		delete process.env.NETLIFY_BLOBS_TOKEN;
		delete process.env.NETLIFY_TOKEN;
		delete process.env.BROWSERQL_API_KEY;
		delete process.env.SCRAPING_SERVICE_URL;

		jest.resetModules();

		// Mock console to reduce test noise
		jest.spyOn(console, "log").mockImplementation(() => {});
		jest.spyOn(console, "warn").mockImplementation(() => {});
		jest.spyOn(console, "error").mockImplementation(() => {});

		envValidator = require("../netlify/functions/lib/env-validator");
	});

	afterEach(() => {
		process.env = originalEnv;
		jest.restoreAllMocks();
	});

	test("should pass when all required vars are present", () => {
		process.env.SITE_ID = "test-site";
		process.env.SERPAPI_API_KEY = "test-serpapi";
		process.env.GROQ_API_KEY = "test-groq";
		process.env.SCRAPING_API_KEY = "test-scraping";
		process.env.NETLIFY_BLOBS_TOKEN = "test-blobs";
		process.env.SCRAPING_SERVICE_URL = "https://example.com";
		process.env.BROWSERQL_API_KEY = "test-browserql";

		expect(() => envValidator.validateAllEnvVars()).not.toThrow();
	});

	test("should throw when common env vars are missing", () => {
		// Only set blobs token, skip common vars
		process.env.NETLIFY_BLOBS_TOKEN = "test-blobs";

		expect(() => envValidator.validateAllEnvVars()).toThrow(
			"Missing required environment variables"
		);
	});

	test("should throw when blobs token is missing", () => {
		process.env.SITE_ID = "test-site";
		process.env.SERPAPI_API_KEY = "test-serpapi";
		process.env.GROQ_API_KEY = "test-groq";
		process.env.SCRAPING_API_KEY = "test-scraping";
		// No blobs token

		expect(() => envValidator.validateAllEnvVars()).toThrow(
			"Missing required environment variables"
		);
	});

	test("should warn but not throw when scraping service URL is missing", () => {
		process.env.SITE_ID = "test-site";
		process.env.SERPAPI_API_KEY = "test-serpapi";
		process.env.GROQ_API_KEY = "test-groq";
		process.env.SCRAPING_API_KEY = "test-scraping";
		process.env.NETLIFY_BLOBS_TOKEN = "test-blobs";
		// No SCRAPING_SERVICE_URL - should warn but not fail

		expect(() => envValidator.validateAllEnvVars()).not.toThrow();
		expect(console.warn).toHaveBeenCalledWith(
			"[WARN]",
			expect.stringContaining("Environment warnings")
		);
	});

	test("should warn but not throw when BrowserQL key is missing", () => {
		process.env.SITE_ID = "test-site";
		process.env.SERPAPI_API_KEY = "test-serpapi";
		process.env.GROQ_API_KEY = "test-groq";
		process.env.SCRAPING_API_KEY = "test-scraping";
		process.env.NETLIFY_BLOBS_TOKEN = "test-blobs";
		process.env.SCRAPING_SERVICE_URL = "https://example.com";
		// No BROWSERQL_API_KEY - should warn

		expect(() => envValidator.validateAllEnvVars()).not.toThrow();
		// BrowserQL warning should be logged
		expect(console.warn).toHaveBeenCalled();
	});

	test("should warn when scraping service URL has invalid format", () => {
		process.env.SITE_ID = "test-site";
		process.env.SERPAPI_API_KEY = "test-serpapi";
		process.env.GROQ_API_KEY = "test-groq";
		process.env.SCRAPING_API_KEY = "test-scraping";
		process.env.NETLIFY_BLOBS_TOKEN = "test-blobs";
		process.env.SCRAPING_SERVICE_URL = "not-a-url";
		process.env.BROWSERQL_API_KEY = "test-browserql";

		// Invalid URL format is a warning, not an error
		expect(() => envValidator.validateAllEnvVars()).not.toThrow();
		expect(console.warn).toHaveBeenCalled();
	});

	test("should log success message when all validation passes", () => {
		process.env.SITE_ID = "test-site";
		process.env.SERPAPI_API_KEY = "test-serpapi";
		process.env.GROQ_API_KEY = "test-groq";
		process.env.SCRAPING_API_KEY = "test-scraping";
		process.env.NETLIFY_BLOBS_TOKEN = "test-blobs";
		process.env.SCRAPING_SERVICE_URL = "https://example.com";
		process.env.BROWSERQL_API_KEY = "test-browserql";

		envValidator.validateAllEnvVars();

		expect(console.log).toHaveBeenCalledWith(
			"[INFO]",
			expect.stringContaining("Environment variables validated")
		);
	});

	test("should accumulate multiple errors", () => {
		// Neither common vars nor blobs token set
		try {
			envValidator.validateAllEnvVars();
		} catch (e) {
			expect(e.message).toBe("Missing required environment variables");
		}
		// Should have logged multiple errors
		expect(console.error).toHaveBeenCalled();
	});

	describe("validateBlobsToken edge cases", () => {
		test("should accept NETLIFY_TOKEN as fallback", () => {
			process.env.NETLIFY_TOKEN = "test-token";
			expect(() => envValidator.validateBlobsToken()).not.toThrow();
			expect(envValidator.validateBlobsToken()).toBe(true);
		});

		test("should return true when valid", () => {
			process.env.NETLIFY_BLOBS_TOKEN = "test-token";
			expect(envValidator.validateBlobsToken()).toBe(true);
		});
	});

	describe("validateScrapingServiceUrl edge cases", () => {
		test("should return true for valid URL", () => {
			process.env.SCRAPING_SERVICE_URL = "https://service.onrender.com";
			expect(envValidator.validateScrapingServiceUrl()).toBe(true);
		});
	});
});
