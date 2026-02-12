// Tests for scraping-service/index.js Express server
// Phase 5B: Test coverage for the main Express application entry point

const request = require("supertest");

// Set required env vars BEFORE requiring the module
process.env.SCRAPING_API_KEY = "test-api-key-12345";
process.env.PORT = "0";
process.env.ALLOWED_ORIGINS = "http://localhost:3000,http://example.com";

// Mock memory utilities
const mockGetMemoryUsageMB = jest.fn(() => ({
	rss: 100,
	heapUsed: 50,
	heapTotal: 200,
	external: 10
}));
const mockGetShutdownState = jest.fn(() => false);
const mockGetRequestCount = jest.fn(() => 5);

jest.mock("../scraping-service/utils/memory", () => ({
	getMemoryUsageMB: (...args) => mockGetMemoryUsageMB(...args),
	getShutdownState: (...args) => mockGetShutdownState(...args),
	getRequestCount: (...args) => mockGetRequestCount(...args),
	MEMORY_LIMIT_MB: 512,
	MEMORY_WARNING_MB: 400
}));

jest.mock("../scraping-service/utils/env-validator", () => ({
	validateEnvironmentVariables: jest.fn(),
	validateAllowedOrigins: jest.fn()
}));

const mockHandleScrapeRequest = jest.fn((req, res) => {
	res.json({ success: true, handler: "scrape" });
});
const mockHandleKeyenceScrapeRequest = jest.fn((req, res) => {
	res.json({ success: true, handler: "scrape-keyence" });
});

jest.mock("../scraping-service/routes/scrape", () => ({
	handleScrapeRequest: (...args) => mockHandleScrapeRequest(...args)
}));

jest.mock("../scraping-service/routes/scrape-keyence", () => ({
	handleKeyenceScrapeRequest: (...args) => mockHandleKeyenceScrapeRequest(...args)
}));

jest.mock("../scraping-service/utils/logger", () => ({
	info: jest.fn(),
	warn: jest.fn(),
	error: jest.fn(),
	debug: jest.fn()
}));

// We need to get the express app without starting the server.
// index.js calls app.listen() at module load. We export app via module.exports = app.
// supertest can work with the app object directly without a running server.
const app = require("../scraping-service/index");

// Close any server created by app.listen() during module load
afterAll((done) => {
	// app.listen() was called during module load; we need to find and close it
	// Since we can't directly access the server, set a short timeout to let Jest exit
	if (app._server) {
		app._server.close(done);
	} else {
		done();
	}
});

describe("scraping-service index.js", () => {
	beforeEach(() => {
		jest.clearAllMocks();
		mockGetShutdownState.mockReturnValue(false);
		mockGetMemoryUsageMB.mockReturnValue({
			rss: 100,
			heapUsed: 50,
			heapTotal: 200,
			external: 10
		});
		mockGetRequestCount.mockReturnValue(5);
	});

	describe("Health endpoint (GET /health)", () => {
		test("returns 200 with status ok", async () => {
			const res = await request(app).get("/health");
			expect(res.status).toBe(200);
			expect(res.body.status).toBe("ok");
		});

		test("returns memory info fields", async () => {
			const res = await request(app).get("/health");
			expect(res.body.memory).toBeDefined();
			expect(res.body.memory.rss).toBe(100);
			expect(res.body.memory.heapUsed).toBe(50);
			expect(res.body.memory.heapTotal).toBe(200);
			expect(res.body.memory.percentUsed).toBeDefined();
			expect(res.body.memory.limit).toBe(512);
			expect(res.body.memory.warning).toBe(400);
		});

		test("returns requestCount and isShuttingDown", async () => {
			const res = await request(app).get("/health");
			expect(res.body.requestCount).toBe(5);
			expect(res.body.isShuttingDown).toBe(false);
		});

		test("reflects shutdown state", async () => {
			mockGetShutdownState.mockReturnValue(true);
			const res = await request(app).get("/health");
			expect(res.body.isShuttingDown).toBe(true);
		});

		test("does not require API key", async () => {
			const res = await request(app).get("/health");
			expect(res.status).toBe(200);
		});
	});

	describe("Status endpoint (GET /status)", () => {
		test("returns ok status when not shutting down", async () => {
			const res = await request(app).get("/status");
			expect(res.status).toBe(200);
			expect(res.body.status).toBe("ok");
		});

		test("returns shutting_down status when shutting down", async () => {
			mockGetShutdownState.mockReturnValue(true);
			const res = await request(app).get("/status");
			expect(res.body.status).toBe("shutting_down");
		});

		test("returns requestCount and memoryMB", async () => {
			const res = await request(app).get("/status");
			expect(res.body.requestCount).toBe(5);
			expect(res.body.memoryMB).toBe(100);
			expect(res.body.memoryLimitMB).toBe(512);
		});

		test("does not require API key", async () => {
			const res = await request(app).get("/status");
			expect(res.status).toBe(200);
		});
	});

	describe("API Key Authentication", () => {
		test("rejects /scrape without API key (401)", async () => {
			const res = await request(app)
				.post("/scrape")
				.send({ url: "https://example.com" });
			expect(res.status).toBe(401);
			expect(res.body.error).toMatch(/unauthorized/i);
		});

		test("rejects /scrape with wrong API key (401)", async () => {
			const res = await request(app)
				.post("/scrape")
				.set("x-api-key", "wrong-key")
				.send({ url: "https://example.com" });
			expect(res.status).toBe(401);
		});

		test("allows /scrape with correct API key", async () => {
			const res = await request(app)
				.post("/scrape")
				.set("x-api-key", "test-api-key-12345")
				.send({ url: "https://example.com" });
			// Should reach the handler (200 from mock)
			expect(res.status).toBe(200);
			expect(mockHandleScrapeRequest).toHaveBeenCalled();
		});

		test("rejects /scrape-keyence without API key (401)", async () => {
			const res = await request(app)
				.post("/scrape-keyence")
				.send({ model: "ABC-100" });
			expect(res.status).toBe(401);
		});

		test("allows /scrape-keyence with correct API key", async () => {
			const res = await request(app)
				.post("/scrape-keyence")
				.set("x-api-key", "test-api-key-12345")
				.send({ model: "ABC-100" });
			expect(res.status).toBe(200);
			expect(mockHandleKeyenceScrapeRequest).toHaveBeenCalled();
		});

		test("allows /health without auth", async () => {
			const res = await request(app).get("/health");
			expect(res.status).toBe(200);
		});

		test("allows /status without auth", async () => {
			const res = await request(app).get("/status");
			expect(res.status).toBe(200);
		});
	});

	describe("Shutdown middleware", () => {
		test("rejects /scrape with 503 during shutdown", async () => {
			mockGetShutdownState.mockReturnValue(true);
			const res = await request(app)
				.post("/scrape")
				.set("x-api-key", "test-api-key-12345")
				.send({ url: "https://example.com" });
			expect(res.status).toBe(503);
			expect(res.body.error).toMatch(/restarting/i);
		});

		test("rejects /scrape-keyence with 503 during shutdown", async () => {
			mockGetShutdownState.mockReturnValue(true);
			const res = await request(app)
				.post("/scrape-keyence")
				.set("x-api-key", "test-api-key-12345")
				.send({ model: "ABC-100" });
			expect(res.status).toBe(503);
		});

		test("allows /health during shutdown", async () => {
			mockGetShutdownState.mockReturnValue(true);
			const res = await request(app).get("/health");
			expect(res.status).toBe(200);
		});

		test("allows /status during shutdown", async () => {
			mockGetShutdownState.mockReturnValue(true);
			const res = await request(app).get("/status");
			expect(res.status).toBe(200);
		});
	});

	describe("Environment validation at startup", () => {
		test("module exports a valid express app", () => {
			// The app should be a function (express app) with listen method
			expect(typeof app).toBe("function");
			expect(typeof app.listen).toBe("function");
		});
	});

	describe("SCRAPING_API_KEY not configured", () => {
		test("returns 500 when SCRAPING_API_KEY is not set", async () => {
			const originalKey = process.env.SCRAPING_API_KEY;
			delete process.env.SCRAPING_API_KEY;

			const res = await request(app)
				.post("/scrape")
				.set("x-api-key", "any-key")
				.send({ url: "https://example.com" });
			expect(res.status).toBe(500);
			expect(res.body.error).toMatch(/misconfigured/i);

			process.env.SCRAPING_API_KEY = originalKey;
		});
	});
});
