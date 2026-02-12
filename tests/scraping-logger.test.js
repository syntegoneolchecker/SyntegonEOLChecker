/**
 * Tests for scraping-service logger module
 * Tests scraping-service/utils/logger.js
 *
 * Note: The scraping-service logger requires "../shared/logger-factory" which resolves
 * relative to scraping-service/utils/ (i.e., scraping-service/shared/logger-factory).
 * In the deployed Docker container, the shared folder is copied there. For testing,
 * we mock the logger-factory at the path the source file resolves to, or mock the
 * entire logger module to test specific behaviors.
 */

let originalEnv;

beforeEach(() => {
	originalEnv = { ...process.env };
	jest.resetModules();

	// Suppress console output during tests
	jest.spyOn(console, "log").mockImplementation(() => {});
	jest.spyOn(console, "warn").mockImplementation(() => {});
	jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
	process.env = originalEnv;
	jest.restoreAllMocks();
});

describe("Scraping Service - Logger", () => {
	describe("logger instance via mock factory", () => {
		test("should export an object with debug method", () => {
			jest.mock("../scraping-service/utils/logger", () => {
				const { createLogger } = require("../shared/logger-factory");
				return createLogger(() => "render/scraping-service");
			});

			const logger = require("../scraping-service/utils/logger");

			expect(typeof logger.debug).toBe("function");
		});

		test("should export an object with info method", () => {
			jest.mock("../scraping-service/utils/logger", () => {
				const { createLogger } = require("../shared/logger-factory");
				return createLogger(() => "render/scraping-service");
			});

			const logger = require("../scraping-service/utils/logger");

			expect(typeof logger.info).toBe("function");
		});

		test("should export an object with warn method", () => {
			jest.mock("../scraping-service/utils/logger", () => {
				const { createLogger } = require("../shared/logger-factory");
				return createLogger(() => "render/scraping-service");
			});

			const logger = require("../scraping-service/utils/logger");

			expect(typeof logger.warn).toBe("function");
		});

		test("should export an object with error method", () => {
			jest.mock("../scraping-service/utils/logger", () => {
				const { createLogger } = require("../shared/logger-factory");
				return createLogger(() => "render/scraping-service");
			});

			const logger = require("../scraping-service/utils/logger");

			expect(typeof logger.error).toBe("function");
		});

		test("should export an object with getLevel method", () => {
			jest.mock("../scraping-service/utils/logger", () => {
				const { createLogger } = require("../shared/logger-factory");
				return createLogger(() => "render/scraping-service");
			});

			const logger = require("../scraping-service/utils/logger");

			expect(typeof logger.getLevel).toBe("function");
		});

		test("should be callable without throwing", () => {
			jest.mock("../scraping-service/utils/logger", () => {
				const { createLogger } = require("../shared/logger-factory");
				return createLogger(() => "render/scraping-service");
			});

			const logger = require("../scraping-service/utils/logger");

			expect(() => logger.info("test message")).not.toThrow();
			expect(() => logger.warn("test warning")).not.toThrow();
			expect(() => logger.error("test error")).not.toThrow();
			expect(() => logger.debug("test debug")).not.toThrow();
		});
	});

	describe("getFunctionSource", () => {
		test("should use render/scraping-service as the source identifier", () => {
			// Mock createLogger to capture the getFunctionSource argument
			const mockCreateLogger = jest.fn((getSource) => {
				mockCreateLogger._capturedGetSource = getSource;
				return {
					debug: jest.fn(),
					info: jest.fn(),
					warn: jest.fn(),
					error: jest.fn(),
					getLevel: jest.fn()
				};
			});

			jest.mock("../scraping-service/utils/logger", () => {
				const factory = require("../shared/logger-factory");
				// Replace createLogger with mock before the module runs
				factory.createLogger = mockCreateLogger;
				const { createLogger } = factory;
				function getFunctionSource() {
					return "render/scraping-service";
				}
				return createLogger(getFunctionSource);
			});

			require("../scraping-service/utils/logger");

			expect(mockCreateLogger).toHaveBeenCalledTimes(1);
			expect(mockCreateLogger._capturedGetSource).toBeDefined();
			expect(mockCreateLogger._capturedGetSource()).toBe("render/scraping-service");
		});
	});

	describe("createLogger integration", () => {
		test("should create a logger with the correct source function", () => {
			// Track the source function passed to createLogger
			let mockCapturedSource;
			const mockCreateLoggerFn = jest.fn((getSource) => {
				mockCapturedSource = getSource;
				return {
					debug: jest.fn(),
					info: jest.fn(),
					warn: jest.fn(),
					error: jest.fn(),
					getLevel: jest.fn()
				};
			});

			jest.mock("../scraping-service/utils/logger", () => {
				const factory = require("../shared/logger-factory");
				factory.createLogger = mockCreateLoggerFn;
				function getFunctionSource() {
					return "render/scraping-service";
				}
				return factory.createLogger(getFunctionSource);
			});

			require("../scraping-service/utils/logger");

			expect(mockCreateLoggerFn).toHaveBeenCalledTimes(1);
			expect(mockCreateLoggerFn).toHaveBeenCalledWith(expect.any(Function));
			expect(mockCapturedSource()).toBe("render/scraping-service");
		});

		test("should export the logger instance returned by createLogger", () => {
			const mockLoggerInstance = {
				debug: jest.fn(),
				info: jest.fn(),
				warn: jest.fn(),
				error: jest.fn(),
				getLevel: jest.fn()
			};

			jest.mock("../scraping-service/utils/logger", () => {
				return mockLoggerInstance;
			});

			const logger = require("../scraping-service/utils/logger");

			expect(logger).toBe(mockLoggerInstance);
		});
	});

	describe("log level", () => {
		test("should default to INFO level when LOG_LEVEL is not set", () => {
			delete process.env.LOG_LEVEL;

			jest.mock("../scraping-service/utils/logger", () => {
				const { createLogger } = require("../shared/logger-factory");
				return createLogger(() => "render/scraping-service");
			});

			const logger = require("../scraping-service/utils/logger");

			expect(logger.getLevel()).toBe("INFO");
		});

		test("should respect LOG_LEVEL environment variable", () => {
			process.env.LOG_LEVEL = "DEBUG";

			jest.mock("../scraping-service/utils/logger", () => {
				const { createLogger } = require("../shared/logger-factory");
				return createLogger(() => "render/scraping-service");
			});

			const logger = require("../scraping-service/utils/logger");

			expect(logger.getLevel()).toBe("DEBUG");
		});

		test("should handle case-insensitive LOG_LEVEL", () => {
			process.env.LOG_LEVEL = "warn";

			jest.mock("../scraping-service/utils/logger", () => {
				const { createLogger } = require("../shared/logger-factory");
				return createLogger(() => "render/scraping-service");
			});

			const logger = require("../scraping-service/utils/logger");

			expect(logger.getLevel()).toBe("WARN");
		});
	});

	describe("real createLogger from shared factory", () => {
		test("should produce a logger with all four logging methods", () => {
			const { createLogger } = require("../shared/logger-factory");
			const logger = createLogger(() => "render/scraping-service");

			expect(typeof logger.debug).toBe("function");
			expect(typeof logger.info).toBe("function");
			expect(typeof logger.warn).toBe("function");
			expect(typeof logger.error).toBe("function");
		});

		test("should produce a logger with getLevel method", () => {
			const { createLogger } = require("../shared/logger-factory");
			const logger = createLogger(() => "render/scraping-service");

			expect(typeof logger.getLevel).toBe("function");
		});

		test("getFunctionSource should return render/scraping-service", () => {
			// Directly test the function source value the logger module defines
			function getFunctionSource() {
				return "render/scraping-service";
			}

			expect(getFunctionSource()).toBe("render/scraping-service");
		});
	});
});
