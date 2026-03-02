const {
	getCorsOrigin,
	handleCORSPreflight,
	successResponse,
	errorResponse,
	validationErrorResponse,
	notFoundResponse,
	methodNotAllowedResponse,
	unauthorizedResponse,
	rateLimitResponse
} = require("../netlify/functions/lib/response-builder");

describe("Response Builder", () => {
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = { ...originalEnv };
		delete process.env.ALLOWED_ORIGINS;
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	describe("getCorsOrigin", () => {
		it("should return * when ALLOWED_ORIGINS is not set", () => {
			expect(getCorsOrigin()).toBe("*");
		});

		it("should return first origin when ALLOWED_ORIGINS is set and no event", () => {
			process.env.ALLOWED_ORIGINS = "https://example.com,https://other.com";
			expect(getCorsOrigin()).toBe("https://example.com");
		});

		it("should return matching request origin when in allowed list", () => {
			process.env.ALLOWED_ORIGINS = "https://example.com,https://other.com";
			const event = { headers: { origin: "https://other.com" } };
			expect(getCorsOrigin(event)).toBe("https://other.com");
		});

		it("should return first allowed origin when request origin not in list", () => {
			process.env.ALLOWED_ORIGINS = "https://example.com,https://other.com";
			const event = { headers: { origin: "https://evil.com" } };
			expect(getCorsOrigin(event)).toBe("https://example.com");
		});

		it("should return first origin when event has no origin header", () => {
			process.env.ALLOWED_ORIGINS = "https://example.com";
			const event = { headers: {} };
			expect(getCorsOrigin(event)).toBe("https://example.com");
		});

		it("should handle whitespace in ALLOWED_ORIGINS", () => {
			process.env.ALLOWED_ORIGINS = " https://example.com , https://other.com ";
			const event = { headers: { origin: "https://other.com" } };
			expect(getCorsOrigin(event)).toBe("https://other.com");
		});
	});

	describe("handleCORSPreflight", () => {
		it("should return 204 response for OPTIONS requests", () => {
			const event = { httpMethod: "OPTIONS" };
			const result = handleCORSPreflight(event);

			expect(result).not.toBeNull();
			expect(result.statusCode).toBe(204);
			expect(result.headers["Access-Control-Allow-Methods"]).toBe("GET, POST, OPTIONS");
			expect(result.headers["Access-Control-Allow-Headers"]).toBe(
				"Content-Type, Authorization"
			);
			expect(result.body).toBe("");
		});

		it("should return null for non-OPTIONS requests", () => {
			const event = { httpMethod: "POST" };
			expect(handleCORSPreflight(event)).toBeNull();
		});

		it("should use custom allowed methods", () => {
			const event = { httpMethod: "OPTIONS" };
			const result = handleCORSPreflight(event, "POST, OPTIONS");
			expect(result.headers["Access-Control-Allow-Methods"]).toBe("POST, OPTIONS");
		});
	});

	describe("successResponse", () => {
		it("should return 200 with correct structure", () => {
			const result = successResponse({ items: [1, 2, 3] });

			expect(result.statusCode).toBe(200);
			expect(result.headers["Content-Type"]).toBe("application/json");

			const body = JSON.parse(result.body);
			expect(body.success).toBe(true);
			expect(body.data).toEqual({ items: [1, 2, 3] });
		});

		it("should use custom status code", () => {
			const result = successResponse("created", 201);
			expect(result.statusCode).toBe(201);
		});

		it("should handle null data", () => {
			const result = successResponse(null);
			const body = JSON.parse(result.body);
			expect(body.success).toBe(true);
			expect(body.data).toBeNull();
		});
	});

	describe("errorResponse", () => {
		it("should return 500 with error structure", () => {
			const result = errorResponse("Something went wrong");

			expect(result.statusCode).toBe(500);
			const body = JSON.parse(result.body);
			expect(body.success).toBe(false);
			expect(body.error.message).toBe("Something went wrong");
			expect(body.error.timestamp).toBeDefined();
		});

		it("should include details when provided", () => {
			const result = errorResponse("Failed", { code: "DB_ERROR" }, 503);

			expect(result.statusCode).toBe(503);
			const body = JSON.parse(result.body);
			expect(body.error.details).toEqual({ code: "DB_ERROR" });
		});

		it("should not include details when null", () => {
			const result = errorResponse("Failed");
			const body = JSON.parse(result.body);
			expect(body.error.details).toBeUndefined();
		});
	});

	describe("validationErrorResponse", () => {
		it("should return 400 with validation errors", () => {
			const errors = ["Name is required", "Email is invalid"];
			const result = validationErrorResponse(errors);

			expect(result.statusCode).toBe(400);
			const body = JSON.parse(result.body);
			expect(body.success).toBe(false);
			expect(body.error.message).toBe("Validation failed");
			expect(body.error.details.errors).toEqual(errors);
		});
	});

	describe("notFoundResponse", () => {
		it("should return 404 with default resource name", () => {
			const result = notFoundResponse();

			expect(result.statusCode).toBe(404);
			const body = JSON.parse(result.body);
			expect(body.error.message).toBe("Resource not found");
		});

		it("should return 404 with custom resource name", () => {
			const result = notFoundResponse("Job");
			const body = JSON.parse(result.body);
			expect(body.error.message).toBe("Job not found");
		});
	});

	describe("methodNotAllowedResponse", () => {
		it("should return 405 with default allowed methods", () => {
			const result = methodNotAllowedResponse();

			expect(result.statusCode).toBe(405);
			expect(result.headers["Allow"]).toBe("POST");
			const body = JSON.parse(result.body);
			expect(body.error.message).toBe("Method not allowed");
			expect(body.error.allowedMethods).toBe("POST");
		});

		it("should use custom allowed methods", () => {
			const result = methodNotAllowedResponse("GET, POST");
			expect(result.headers["Allow"]).toBe("GET, POST");
		});
	});

	describe("unauthorizedResponse", () => {
		it("should return 401 with default message", () => {
			const result = unauthorizedResponse();

			expect(result.statusCode).toBe(401);
			const body = JSON.parse(result.body);
			expect(body.error.message).toBe("Unauthorized - invalid or missing API key");
		});

		it("should return 401 with custom message", () => {
			const result = unauthorizedResponse("Token expired");
			const body = JSON.parse(result.body);
			expect(body.error.message).toBe("Token expired");
		});
	});

	describe("rateLimitResponse", () => {
		it("should return 429 with rate limit message", () => {
			const result = rateLimitResponse("Too many requests");

			expect(result.statusCode).toBe(429);
			const body = JSON.parse(result.body);
			expect(body.success).toBe(false);
			expect(body.error.message).toBe("Too many requests");
		});

		it("should include Retry-After header when provided", () => {
			const result = rateLimitResponse("Slow down", 60);

			expect(result.headers["Retry-After"]).toBe("60");
			const body = JSON.parse(result.body);
			expect(body.error.retryAfter).toBe(60);
		});

		it("should not include Retry-After header when not provided", () => {
			const result = rateLimitResponse("Slow down");
			expect(result.headers["Retry-After"]).toBeUndefined();
		});
	});
});
