/**
 * Tests for netlify/functions/job-status.js
 */

jest.mock("../netlify/functions/lib/job-storage", () => ({
	getJob: jest.fn()
}));

jest.mock("../netlify/functions/lib/response-builder", () => ({
	getCorsOrigin: jest.fn(() => "*"),
	handleCORSPreflight: jest.fn((event) => {
		if (event.httpMethod === "OPTIONS") {
			return { statusCode: 204, headers: { "Access-Control-Allow-Origin": "*" }, body: "" };
		}
		return null;
	}),
	notFoundResponse: jest.fn((entity) => ({
		statusCode: 404,
		headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
		body: JSON.stringify({ error: `${entity} not found` })
	})),
	errorResponse: jest.fn((msg) => ({
		statusCode: 500,
		headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
		body: JSON.stringify({ error: msg })
	}))
}));

jest.mock("../netlify/functions/lib/logger", () => ({
	info: jest.fn(),
	warn: jest.fn(),
	error: jest.fn(),
	debug: jest.fn()
}));

jest.mock("../netlify/functions/lib/auth-middleware", () => ({
	requireAuth: jest.fn((handler) => handler)
}));

const { handler } = require("../netlify/functions/job-status");
const { getJob } = require("../netlify/functions/lib/job-storage");

describe("job-status handler", () => {
	const mockContext = {};

	beforeEach(() => {
		jest.clearAllMocks();
	});

	test("returns 204 for OPTIONS preflight", async () => {
		const event = {
			httpMethod: "OPTIONS",
			path: "/.netlify/functions/job-status/job-123"
		};
		const result = await handler(event, mockContext);

		expect(result.statusCode).toBe(204);
	});

	test("returns 404 when job not found", async () => {
		getJob.mockResolvedValue(null);

		const event = {
			httpMethod: "GET",
			path: "/.netlify/functions/job-status/nonexistent"
		};
		const result = await handler(event, mockContext);

		expect(result.statusCode).toBe(404);
	});

	test("returns job status for pending job", async () => {
		getJob.mockResolvedValue({
			jobId: "job-123",
			status: "urls_ready",
			maker: "SMC",
			model: "SY3120",
			urls: [
				{ index: 0, status: "pending" },
				{ index: 1, status: "pending" }
			],
			createdAt: "2025-01-15T12:00:00Z"
		});

		const event = {
			httpMethod: "GET",
			path: "/.netlify/functions/job-status/job-123"
		};
		const result = await handler(event, mockContext);

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.jobId).toBe("job-123");
		expect(body.status).toBe("urls_ready");
		expect(body.urlCount).toBe(2);
		expect(body.completedUrls).toBe(0);
		expect(body.maker).toBe("SMC");
		expect(body.model).toBe("SY3120");
	});

	test("returns job with partially completed URLs", async () => {
		getJob.mockResolvedValue({
			jobId: "job-456",
			status: "fetching",
			maker: "Test",
			model: "Model",
			urls: [
				{ index: 0, status: "complete" },
				{ index: 1, status: "fetching" }
			],
			createdAt: "2025-01-15T12:00:00Z"
		});

		const event = {
			httpMethod: "GET",
			path: "/.netlify/functions/job-status/job-456"
		};
		const result = await handler(event, mockContext);

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.completedUrls).toBe(1);
		expect(body.urlCount).toBe(2);
	});

	test("includes finalResult when job is complete", async () => {
		const finalResult = {
			status: "ACTIVE",
			explanation: "Product is still active",
			successor: { status: "UNKNOWN", model: null, explanation: "" }
		};

		getJob.mockResolvedValue({
			jobId: "job-done",
			status: "complete",
			maker: "Test",
			model: "Model",
			urls: [{ index: 0, status: "complete" }],
			finalResult,
			completedAt: "2025-01-15T12:05:00Z",
			createdAt: "2025-01-15T12:00:00Z"
		});

		const event = {
			httpMethod: "GET",
			path: "/.netlify/functions/job-status/job-done"
		};
		const result = await handler(event, mockContext);

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.status).toBe("complete");
		expect(body.result.status).toBe("ACTIVE");
	});

	test("includes isDailyLimit and retrySeconds", async () => {
		getJob.mockResolvedValue({
			jobId: "job-limited",
			status: "error",
			maker: "Test",
			model: "Model",
			urls: [],
			isDailyLimit: true,
			retrySeconds: 3600,
			error: "Rate limit reached",
			createdAt: "2025-01-15T12:00:00Z"
		});

		const event = {
			httpMethod: "GET",
			path: "/.netlify/functions/job-status/job-limited"
		};
		const result = await handler(event, mockContext);

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.isDailyLimit).toBe(true);
		expect(body.retrySeconds).toBe(3600);
	});

	test("handles missing urls array gracefully", async () => {
		getJob.mockResolvedValue({
			jobId: "job-no-urls",
			status: "created",
			maker: "Test",
			model: "Model",
			createdAt: "2025-01-15T12:00:00Z"
		});

		const event = {
			httpMethod: "GET",
			path: "/.netlify/functions/job-status/job-no-urls"
		};
		const result = await handler(event, mockContext);

		expect(result.statusCode).toBe(200);
		const body = JSON.parse(result.body);
		expect(body.urlCount).toBe(0);
		expect(body.completedUrls).toBe(0);
		expect(body.urls).toEqual([]);
	});

	test("returns 500 on storage error", async () => {
		getJob.mockRejectedValue(new Error("Blob storage error"));

		const event = {
			httpMethod: "GET",
			path: "/.netlify/functions/job-status/job-err"
		};
		const result = await handler(event, mockContext);

		expect(result.statusCode).toBe(500);
	});
});
