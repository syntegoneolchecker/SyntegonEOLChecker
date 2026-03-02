/**
 * Tests for scraping-service environment variable validation
 * Tests scraping-service/utils/env-validator.js
 */

// Mock the scraping service logger
jest.mock("../scraping-service/utils/logger", () => ({
	info: jest.fn(),
	warn: jest.fn(),
	error: jest.fn(),
	debug: jest.fn()
}));

let envValidator;
let mockLogger;
let originalEnv;

beforeEach(() => {
	// Save original env
	originalEnv = { ...process.env };

	// Clear relevant env vars
	delete process.env.SCRAPING_API_KEY;
	delete process.env.PORT;
	delete process.env.ALLOWED_ORIGINS;
	delete process.env.NODE_ENV;

	// Reset modules to get fresh imports
	jest.resetModules();
	jest.mock("../scraping-service/utils/logger", () => ({
		info: jest.fn(),
		warn: jest.fn(),
		error: jest.fn(),
		debug: jest.fn()
	}));

	envValidator = require("../scraping-service/utils/env-validator");
	mockLogger = require("../scraping-service/utils/logger");
});

afterEach(() => {
	// Restore original env
	process.env = originalEnv;
	jest.restoreAllMocks();
});

describe("Scraping Service - Environment Validator", () => {
	describe("validateEnvironmentVariables", () => {
		test("should throw if SCRAPING_API_KEY is missing", () => {
			expect(() => envValidator.validateEnvironmentVariables()).toThrow(
				"Missing required environment variables"
			);
		});

		test("should log error messages when required vars are missing", () => {
			try {
				envValidator.validateEnvironmentVariables();
			} catch {
				// expected
			}

			expect(mockLogger.error).toHaveBeenCalledWith(
				expect.stringContaining("Environment variable validation failed")
			);
			expect(mockLogger.error).toHaveBeenCalledWith(
				expect.stringContaining("Missing required environment variable: SCRAPING_API_KEY")
			);
		});

		test("should not throw when SCRAPING_API_KEY is set", () => {
			process.env.SCRAPING_API_KEY = "test-key";

			expect(() => envValidator.validateEnvironmentVariables()).not.toThrow();
		});

		test("should log success message when all required vars are present", () => {
			process.env.SCRAPING_API_KEY = "test-key";

			envValidator.validateEnvironmentVariables();

			expect(mockLogger.info).toHaveBeenCalledWith(
				expect.stringContaining("Environment variables validated successfully")
			);
		});

		test("should warn about missing optional PORT variable", () => {
			process.env.SCRAPING_API_KEY = "test-key";
			process.env.ALLOWED_ORIGINS = "http://localhost:3000";
			process.env.NODE_ENV = "test";

			envValidator.validateEnvironmentVariables();

			expect(mockLogger.warn).toHaveBeenCalledWith(
				expect.stringContaining("Optional environment variable not set: PORT")
			);
		});

		test("should warn about missing optional ALLOWED_ORIGINS variable", () => {
			process.env.SCRAPING_API_KEY = "test-key";
			process.env.PORT = "3000";
			process.env.NODE_ENV = "test";

			envValidator.validateEnvironmentVariables();

			expect(mockLogger.warn).toHaveBeenCalledWith(
				expect.stringContaining("Optional environment variable not set: ALLOWED_ORIGINS")
			);
		});

		test("should warn about missing optional NODE_ENV variable", () => {
			process.env.SCRAPING_API_KEY = "test-key";
			process.env.PORT = "3000";
			process.env.ALLOWED_ORIGINS = "http://localhost:3000";

			envValidator.validateEnvironmentVariables();

			expect(mockLogger.warn).toHaveBeenCalledWith(
				expect.stringContaining("Optional environment variable not set: NODE_ENV")
			);
		});

		test("should warn about all missing optional vars when none are set", () => {
			process.env.SCRAPING_API_KEY = "test-key";

			envValidator.validateEnvironmentVariables();

			expect(mockLogger.warn).toHaveBeenCalledWith(
				expect.stringContaining("Environment variable warnings")
			);
			expect(mockLogger.warn).toHaveBeenCalledWith(
				expect.stringContaining("Optional environment variable not set: PORT")
			);
			expect(mockLogger.warn).toHaveBeenCalledWith(
				expect.stringContaining("Optional environment variable not set: ALLOWED_ORIGINS")
			);
			expect(mockLogger.warn).toHaveBeenCalledWith(
				expect.stringContaining("Optional environment variable not set: NODE_ENV")
			);
		});

		test("should not warn when all optional vars are set", () => {
			process.env.SCRAPING_API_KEY = "test-key";
			process.env.PORT = "3000";
			process.env.ALLOWED_ORIGINS = "http://localhost:3000";
			process.env.NODE_ENV = "production";

			envValidator.validateEnvironmentVariables();

			expect(mockLogger.warn).not.toHaveBeenCalled();
		});

		test("should both warn and throw when optional vars missing and required var missing", () => {
			expect(() => envValidator.validateEnvironmentVariables()).toThrow(
				"Missing required environment variables"
			);

			// Should have warned about optional vars
			expect(mockLogger.warn).toHaveBeenCalledWith(
				expect.stringContaining("Environment variable warnings")
			);

			// Should have logged error about required vars
			expect(mockLogger.error).toHaveBeenCalledWith(
				expect.stringContaining("Environment variable validation failed")
			);
		});

		test("should not log success message when validation fails", () => {
			try {
				envValidator.validateEnvironmentVariables();
			} catch {
				// expected
			}

			expect(mockLogger.info).not.toHaveBeenCalledWith(
				expect.stringContaining("Environment variables validated successfully")
			);
		});
	});

	describe("validateAllowedOrigins", () => {
		test("should return true when ALLOWED_ORIGINS is not set", () => {
			const result = envValidator.validateAllowedOrigins();

			expect(result).toBe(true);
		});

		test("should warn when ALLOWED_ORIGINS is not set", () => {
			envValidator.validateAllowedOrigins();

			expect(mockLogger.warn).toHaveBeenCalledWith(
				expect.stringContaining("ALLOWED_ORIGINS not set")
			);
		});

		test("should return true for a valid http origin", () => {
			process.env.ALLOWED_ORIGINS = "http://localhost:3000";

			const result = envValidator.validateAllowedOrigins();

			expect(result).toBe(true);
		});

		test("should return true for a valid https origin", () => {
			process.env.ALLOWED_ORIGINS = "https://example.com";

			const result = envValidator.validateAllowedOrigins();

			expect(result).toBe(true);
		});

		test("should return true for multiple valid origins", () => {
			process.env.ALLOWED_ORIGINS = "http://localhost:3000,https://example.com,https://app.example.com";

			const result = envValidator.validateAllowedOrigins();

			expect(result).toBe(true);
		});

		test("should log the number of configured origins", () => {
			process.env.ALLOWED_ORIGINS = "http://localhost:3000,https://example.com";

			envValidator.validateAllowedOrigins();

			expect(mockLogger.info).toHaveBeenCalledWith(
				expect.stringContaining("2 origin(s) configured")
			);
		});

		test("should return false for an origin without protocol", () => {
			process.env.ALLOWED_ORIGINS = "example.com";

			const result = envValidator.validateAllowedOrigins();

			expect(result).toBe(false);
		});

		test("should log error for invalid origin format", () => {
			process.env.ALLOWED_ORIGINS = "example.com";

			envValidator.validateAllowedOrigins();

			expect(mockLogger.error).toHaveBeenCalledWith(
				expect.stringContaining('Invalid origin format: "example.com"')
			);
			expect(mockLogger.error).toHaveBeenCalledWith(
				expect.stringContaining("Origins must start with http:// or https://")
			);
		});

		test("should return false if any origin in the list is invalid", () => {
			process.env.ALLOWED_ORIGINS = "https://example.com,invalid-origin,http://localhost";

			const result = envValidator.validateAllowedOrigins();

			expect(result).toBe(false);
		});

		test("should return false for ftp:// protocol", () => {
			process.env.ALLOWED_ORIGINS = "ftp://example.com";

			const result = envValidator.validateAllowedOrigins();

			expect(result).toBe(false);
		});

		test("should handle origins with trailing spaces", () => {
			process.env.ALLOWED_ORIGINS = "http://localhost:3000 , https://example.com ";

			const result = envValidator.validateAllowedOrigins();

			expect(result).toBe(true);
		});

		test("should return false for empty string origin in list", () => {
			process.env.ALLOWED_ORIGINS = "https://example.com,";

			const result = envValidator.validateAllowedOrigins();

			expect(result).toBe(false);
		});
	});
});
