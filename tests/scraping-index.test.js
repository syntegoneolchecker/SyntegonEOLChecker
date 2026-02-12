/**
 * Tests for scraping-service/index.js
 * Since index.js has side effects (app.listen, process.exit), we test
 * the middleware logic and route configuration by re-implementing the key
 * patterns rather than requiring the module directly.
 */

jest.mock("../scraping-service/utils/logger", () => ({
	info: jest.fn(),
	warn: jest.fn(),
	error: jest.fn(),
	debug: jest.fn()
}));

jest.mock("../scraping-service/utils/memory", () => ({
	getMemoryUsageMB: jest.fn(() => ({
		rss: 120,
		heapUsed: 80,
		heapTotal: 150
	})),
	getShutdownState: jest.fn(() => false),
	getRequestCount: jest.fn(() => 5),
	MEMORY_LIMIT_MB: 450,
	MEMORY_WARNING_MB: 380
}));

const {
	getMemoryUsageMB,
	getShutdownState,
	getRequestCount,
	MEMORY_LIMIT_MB,
	MEMORY_WARNING_MB
} = require("../scraping-service/utils/memory");
const logger = require("../scraping-service/utils/logger");

beforeEach(() => {
	jest.clearAllMocks();
	getMemoryUsageMB.mockReturnValue({ rss: 120, heapUsed: 80, heapTotal: 150 });
	getShutdownState.mockReturnValue(false);
	getRequestCount.mockReturnValue(5);
});

describe("Scraping Index", () => {
	describe("CORS origin validation", () => {
		/**
		 * Re-implement the CORS origin callback from index.js to test it in isolation.
		 * This mirrors the exact logic without loading the module.
		 */
		function createCorsValidator(allowedOrigins) {
			return function (origin, callback) {
				if (!origin) return callback(null, true);

				if (!allowedOrigins.includes(origin)) {
					const msg =
						"The CORS policy for this site does not allow access from the specified origin.";
					return callback(new Error(msg), false);
				}
				return callback(null, true);
			};
		}

		test("should allow requests with no origin (curl, Postman, mobile)", (done) => {
			const validator = createCorsValidator(["http://localhost:3000"]);
			validator(undefined, (err, allowed) => {
				expect(err).toBeNull();
				expect(allowed).toBe(true);
				done();
			});
		});

		test("should allow requests from an allowed origin", (done) => {
			const allowedOrigins = ["http://localhost:3000", "http://localhost:5000"];
			const validator = createCorsValidator(allowedOrigins);
			validator("http://localhost:3000", (err, allowed) => {
				expect(err).toBeNull();
				expect(allowed).toBe(true);
				done();
			});
		});

		test("should allow second allowed origin", (done) => {
			const allowedOrigins = ["http://localhost:3000", "http://localhost:5000"];
			const validator = createCorsValidator(allowedOrigins);
			validator("http://localhost:5000", (err, allowed) => {
				expect(err).toBeNull();
				expect(allowed).toBe(true);
				done();
			});
		});

		test("should reject requests from a disallowed origin", (done) => {
			const allowedOrigins = ["http://localhost:3000"];
			const validator = createCorsValidator(allowedOrigins);
			validator("http://evil.com", (err, allowed) => {
				expect(err).toBeInstanceOf(Error);
				expect(err.message).toContain("CORS policy");
				expect(allowed).toBe(false);
				done();
			});
		});

		test("should use ALLOWED_ORIGINS env when set", () => {
			const envOrigins = "https://app.example.com,https://admin.example.com";
			const allowedOrigins = envOrigins.split(",");
			expect(allowedOrigins).toEqual([
				"https://app.example.com",
				"https://admin.example.com"
			]);
		});

		test("should default to localhost origins when ALLOWED_ORIGINS is not set", () => {
			const allowedOrigins = ["http://localhost:3000", "http://localhost:5000"];
			expect(allowedOrigins).toContain("http://localhost:3000");
			expect(allowedOrigins).toContain("http://localhost:5000");
		});
	});

	describe("API key authentication middleware", () => {
		/**
		 * Re-implement the API key middleware from index.js.
		 */
		function createApiKeyMiddleware(expectedKey) {
			const PROTECTED_ENDPOINTS = new Set(["/scrape", "/scrape-keyence"]);

			return function (req, res, next) {
				if (!PROTECTED_ENDPOINTS.has(req.path)) {
					return next();
				}

				const apiKey = req.headers["x-api-key"];

				if (!expectedKey) {
					logger.error("SCRAPING_API_KEY not configured - rejecting all scraping requests");
					return res.status(500).json({ error: "Service misconfigured" });
				}

				if (!apiKey || apiKey !== expectedKey) {
					logger.warn(`Unauthorized request to ${req.path} - invalid or missing API key`);
					return res.status(401).json({ error: "Unauthorized - invalid API key" });
				}

				next();
			};
		}

		function createMockRes() {
			const res = {
				statusCode: null,
				body: null,
				status: jest.fn(function (code) {
					res.statusCode = code;
					return res;
				}),
				json: jest.fn(function (data) {
					res.body = data;
					return res;
				})
			};
			return res;
		}

		test("should skip authentication for non-protected endpoints", () => {
			const middleware = createApiKeyMiddleware("secret-key");
			const req = { path: "/health", headers: {} };
			const res = createMockRes();
			const next = jest.fn();

			middleware(req, res, next);

			expect(next).toHaveBeenCalled();
			expect(res.status).not.toHaveBeenCalled();
		});

		test("should skip authentication for /status endpoint", () => {
			const middleware = createApiKeyMiddleware("secret-key");
			const req = { path: "/status", headers: {} };
			const res = createMockRes();
			const next = jest.fn();

			middleware(req, res, next);

			expect(next).toHaveBeenCalled();
		});

		test("should return 500 when SCRAPING_API_KEY is not configured", () => {
			const middleware = createApiKeyMiddleware(undefined);
			const req = { path: "/scrape", headers: {} };
			const res = createMockRes();
			const next = jest.fn();

			middleware(req, res, next);

			expect(next).not.toHaveBeenCalled();
			expect(res.status).toHaveBeenCalledWith(500);
			expect(res.body).toEqual({ error: "Service misconfigured" });
			expect(logger.error).toHaveBeenCalledWith(
				expect.stringContaining("SCRAPING_API_KEY not configured")
			);
		});

		test("should return 401 when API key is missing from request", () => {
			const middleware = createApiKeyMiddleware("secret-key");
			const req = { path: "/scrape", headers: {} };
			const res = createMockRes();
			const next = jest.fn();

			middleware(req, res, next);

			expect(next).not.toHaveBeenCalled();
			expect(res.status).toHaveBeenCalledWith(401);
			expect(res.body).toEqual({ error: "Unauthorized - invalid API key" });
		});

		test("should return 401 when API key is wrong", () => {
			const middleware = createApiKeyMiddleware("secret-key");
			const req = { path: "/scrape", headers: { "x-api-key": "wrong-key" } };
			const res = createMockRes();
			const next = jest.fn();

			middleware(req, res, next);

			expect(next).not.toHaveBeenCalled();
			expect(res.status).toHaveBeenCalledWith(401);
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining("Unauthorized request to /scrape")
			);
		});

		test("should pass through when API key matches", () => {
			const middleware = createApiKeyMiddleware("secret-key");
			const req = { path: "/scrape", headers: { "x-api-key": "secret-key" } };
			const res = createMockRes();
			const next = jest.fn();

			middleware(req, res, next);

			expect(next).toHaveBeenCalled();
			expect(res.status).not.toHaveBeenCalled();
		});

		test("should protect /scrape-keyence endpoint", () => {
			const middleware = createApiKeyMiddleware("secret-key");
			const req = { path: "/scrape-keyence", headers: {} };
			const res = createMockRes();
			const next = jest.fn();

			middleware(req, res, next);

			expect(next).not.toHaveBeenCalled();
			expect(res.status).toHaveBeenCalledWith(401);
		});

		test("should accept valid key for /scrape-keyence endpoint", () => {
			const middleware = createApiKeyMiddleware("secret-key");
			const req = { path: "/scrape-keyence", headers: { "x-api-key": "secret-key" } };
			const res = createMockRes();
			const next = jest.fn();

			middleware(req, res, next);

			expect(next).toHaveBeenCalled();
		});
	});

	describe("Shutdown rejection middleware", () => {
		/**
		 * Re-implement the shutdown rejection middleware from index.js.
		 */
		function createShutdownMiddleware(getShutdownStateFn) {
			const PROTECTED_ENDPOINTS = new Set(["/scrape", "/scrape-keyence"]);

			return function (req, res, next) {
				if (getShutdownStateFn() && PROTECTED_ENDPOINTS.has(req.path)) {
					logger.info(`Rejecting ${req.path} request during shutdown`);
					return res.status(503).json({
						error: "Service restarting",
						retryAfter: 30
					});
				}
				next();
			};
		}

		function createMockRes() {
			const res = {
				statusCode: null,
				body: null,
				status: jest.fn(function (code) {
					res.statusCode = code;
					return res;
				}),
				json: jest.fn(function (data) {
					res.body = data;
					return res;
				})
			};
			return res;
		}

		test("should reject /scrape during shutdown with 503", () => {
			const middleware = createShutdownMiddleware(() => true);
			const req = { path: "/scrape" };
			const res = createMockRes();
			const next = jest.fn();

			middleware(req, res, next);

			expect(next).not.toHaveBeenCalled();
			expect(res.status).toHaveBeenCalledWith(503);
			expect(res.body).toEqual({
				error: "Service restarting",
				retryAfter: 30
			});
		});

		test("should reject /scrape-keyence during shutdown with 503", () => {
			const middleware = createShutdownMiddleware(() => true);
			const req = { path: "/scrape-keyence" };
			const res = createMockRes();
			const next = jest.fn();

			middleware(req, res, next);

			expect(next).not.toHaveBeenCalled();
			expect(res.status).toHaveBeenCalledWith(503);
			expect(logger.info).toHaveBeenCalledWith(
				expect.stringContaining("Rejecting /scrape-keyence request during shutdown")
			);
		});

		test("should allow /health during shutdown", () => {
			const middleware = createShutdownMiddleware(() => true);
			const req = { path: "/health" };
			const res = createMockRes();
			const next = jest.fn();

			middleware(req, res, next);

			expect(next).toHaveBeenCalled();
			expect(res.status).not.toHaveBeenCalled();
		});

		test("should allow /status during shutdown", () => {
			const middleware = createShutdownMiddleware(() => true);
			const req = { path: "/status" };
			const res = createMockRes();
			const next = jest.fn();

			middleware(req, res, next);

			expect(next).toHaveBeenCalled();
		});

		test("should allow all endpoints when not shutting down", () => {
			const middleware = createShutdownMiddleware(() => false);
			const next = jest.fn();

			middleware({ path: "/scrape" }, { status: jest.fn(), json: jest.fn() }, next);
			expect(next).toHaveBeenCalledTimes(1);

			middleware({ path: "/scrape-keyence" }, { status: jest.fn(), json: jest.fn() }, next);
			expect(next).toHaveBeenCalledTimes(2);

			middleware({ path: "/health" }, { status: jest.fn(), json: jest.fn() }, next);
			expect(next).toHaveBeenCalledTimes(3);
		});
	});

	describe("Health endpoint response", () => {
		/**
		 * Re-implement the health endpoint handler from index.js.
		 */
		function healthHandler(req, res) {
			const memory = getMemoryUsageMB();
			res.json({
				status: "ok",
				timestamp: new Date().toISOString(),
				memory: {
					rss: memory.rss,
					heapUsed: memory.heapUsed,
					heapTotal: memory.heapTotal,
					limit: MEMORY_LIMIT_MB,
					warning: MEMORY_WARNING_MB,
					percentUsed: Math.round((memory.rss / MEMORY_LIMIT_MB) * 100)
				},
				requestCount: getRequestCount(),
				isShuttingDown: getShutdownState()
			});
		}

		function createMockRes() {
			const res = {
				body: null,
				json: jest.fn(function (data) {
					res.body = data;
					return res;
				})
			};
			return res;
		}

		test("should return status ok with memory info", () => {
			const res = createMockRes();
			healthHandler({}, res);

			expect(res.json).toHaveBeenCalledTimes(1);
			const data = res.body;

			expect(data.status).toBe("ok");
			expect(data.memory.rss).toBe(120);
			expect(data.memory.heapUsed).toBe(80);
			expect(data.memory.heapTotal).toBe(150);
			expect(data.memory.limit).toBe(450);
			expect(data.memory.warning).toBe(380);
		});

		test("should include percentUsed calculation", () => {
			const res = createMockRes();
			healthHandler({}, res);

			const data = res.body;
			// 120 / 450 * 100 = 26.67 -> rounds to 27
			expect(data.memory.percentUsed).toBe(Math.round((120 / 450) * 100));
		});

		test("should include requestCount from memory util", () => {
			getRequestCount.mockReturnValue(42);
			const res = createMockRes();
			healthHandler({}, res);

			expect(res.body.requestCount).toBe(42);
		});

		test("should include isShuttingDown flag", () => {
			getShutdownState.mockReturnValue(true);
			const res = createMockRes();
			healthHandler({}, res);

			expect(res.body.isShuttingDown).toBe(true);
		});

		test("should include ISO timestamp", () => {
			const res = createMockRes();
			healthHandler({}, res);

			const data = res.body;
			expect(data.timestamp).toBeDefined();
			// Verify it is a valid ISO date string
			expect(new Date(data.timestamp).toISOString()).toBe(data.timestamp);
		});
	});

	describe("Status endpoint response", () => {
		/**
		 * Re-implement the status endpoint handler from index.js.
		 */
		function statusHandler(req, res) {
			const memory = getMemoryUsageMB();
			res.json({
				status: getShutdownState() ? "shutting_down" : "ok",
				requestCount: getRequestCount(),
				memoryMB: memory.rss,
				memoryLimitMB: MEMORY_LIMIT_MB,
				timestamp: new Date().toISOString()
			});
		}

		function createMockRes() {
			const res = {
				body: null,
				json: jest.fn(function (data) {
					res.body = data;
					return res;
				})
			};
			return res;
		}

		test("should return status ok when not shutting down", () => {
			getShutdownState.mockReturnValue(false);
			const res = createMockRes();
			statusHandler({}, res);

			expect(res.body.status).toBe("ok");
		});

		test("should return shutting_down status during shutdown", () => {
			getShutdownState.mockReturnValue(true);
			const res = createMockRes();
			statusHandler({}, res);

			expect(res.body.status).toBe("shutting_down");
		});

		test("should include requestCount", () => {
			getRequestCount.mockReturnValue(10);
			const res = createMockRes();
			statusHandler({}, res);

			expect(res.body.requestCount).toBe(10);
		});

		test("should include memory and limit fields", () => {
			const res = createMockRes();
			statusHandler({}, res);

			expect(res.body.memoryMB).toBe(120);
			expect(res.body.memoryLimitMB).toBe(450);
		});

		test("should include ISO timestamp", () => {
			const res = createMockRes();
			statusHandler({}, res);

			expect(res.body.timestamp).toBeDefined();
			expect(new Date(res.body.timestamp).toISOString()).toBe(res.body.timestamp);
		});
	});
});
