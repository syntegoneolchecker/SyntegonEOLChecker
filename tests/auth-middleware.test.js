// Mock auth-manager to avoid actual JWT verification
jest.mock("../netlify/functions/lib/auth-manager", () => ({
	validateAuthToken: jest.fn()
}));

// Mock response-builder to control CORS origin
jest.mock("../netlify/functions/lib/response-builder", () => ({
	getCorsOrigin: jest.fn(() => "*")
}));

const {
	extractToken,
	requireAuth,
	requireHybridAuth,
	requireInternalAuth,
	validateInternalApiKey,
	generateAuthCookie,
	generateLogoutCookie,
	getAuthenticatedUser
} = require("../netlify/functions/lib/auth-middleware");

const { validateAuthToken } = require("../netlify/functions/lib/auth-manager");

describe("Auth Middleware", () => {
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = { ...originalEnv };
		delete process.env.INTERNAL_API_KEY;
		delete process.env.CONTEXT;
		delete process.env.NODE_ENV;
		jest.clearAllMocks();
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	describe("extractToken", () => {
		it("should extract Bearer token from Authorization header", () => {
			const event = { headers: { authorization: "Bearer my-jwt-token" } };
			expect(extractToken(event)).toBe("my-jwt-token");
		});

		it("should handle Authorization header with capital A", () => {
			const event = { headers: { Authorization: "Bearer my-jwt-token" } };
			expect(extractToken(event)).toBe("my-jwt-token");
		});

		it("should extract token from auth_token cookie", () => {
			const event = {
				headers: { cookie: "other=val; auth_token=cookie-token; session=abc" }
			};
			expect(extractToken(event)).toBe("cookie-token");
		});

		it("should prefer Authorization header over cookie", () => {
			const event = {
				headers: {
					authorization: "Bearer header-token",
					cookie: "auth_token=cookie-token"
				}
			};
			expect(extractToken(event)).toBe("header-token");
		});

		it("should return null when no token is present", () => {
			const event = { headers: {} };
			expect(extractToken(event)).toBeNull();
		});

		it("should return null for non-Bearer authorization", () => {
			const event = { headers: { authorization: "Basic dXNlcjpwYXNz" } };
			expect(extractToken(event)).toBeNull();
		});

		it("should return null when cookie header is not a string", () => {
			const event = { headers: { cookie: null } };
			expect(extractToken(event)).toBeNull();
		});

		it("should return null when no auth_token cookie exists", () => {
			const event = { headers: { cookie: "session=abc; other=val" } };
			expect(extractToken(event)).toBeNull();
		});
	});

	describe("requireAuth", () => {
		it("should return 401 when no token present", async () => {
			const handler = jest.fn();
			const protectedHandler = requireAuth(handler);

			const event = { headers: {} };
			const result = await protectedHandler(event, {});

			expect(result.statusCode).toBe(401);
			expect(handler).not.toHaveBeenCalled();
			const body = JSON.parse(result.body);
			expect(body.error).toBe("Authentication required");
		});

		it("should return 401 when token is invalid", async () => {
			validateAuthToken.mockResolvedValue({ valid: false, message: "Token expired" });

			const handler = jest.fn();
			const protectedHandler = requireAuth(handler);

			const event = { headers: { authorization: "Bearer bad-token" } };
			const result = await protectedHandler(event, {});

			expect(result.statusCode).toBe(401);
			expect(handler).not.toHaveBeenCalled();
			const body = JSON.parse(result.body);
			expect(body.message).toBe("Token expired");
		});

		it("should call handler with user when token is valid", async () => {
			const user = { email: "test@syntegon.com", verified: true };
			validateAuthToken.mockResolvedValue({ valid: true, user });

			const handler = jest.fn().mockResolvedValue({ statusCode: 200 });
			const protectedHandler = requireAuth(handler);

			const event = { headers: { authorization: "Bearer good-token" } };
			await protectedHandler(event, {});

			expect(handler).toHaveBeenCalled();
			expect(event.user).toEqual(user);
		});
	});

	describe("validateInternalApiKey", () => {
		it("should return false when INTERNAL_API_KEY not set", () => {
			const event = { headers: { "x-internal-key": "some-key" } };
			expect(validateInternalApiKey(event)).toBe(false);
		});

		it("should return false when header key does not match", () => {
			process.env.INTERNAL_API_KEY = "correct-key";
			const event = { headers: { "x-internal-key": "wrong-key" } };
			expect(validateInternalApiKey(event)).toBe(false);
		});

		it("should return true when header key matches", () => {
			process.env.INTERNAL_API_KEY = "my-secret-key";
			const event = { headers: { "x-internal-key": "my-secret-key" } };
			expect(validateInternalApiKey(event)).toBe(true);
		});

		it("should return false when header is missing", () => {
			process.env.INTERNAL_API_KEY = "my-secret-key";
			const event = { headers: {} };
			expect(validateInternalApiKey(event)).toBe(false);
		});
	});

	describe("requireHybridAuth", () => {
		it("should allow access with valid internal API key", async () => {
			process.env.INTERNAL_API_KEY = "internal-key";
			const handler = jest.fn().mockResolvedValue({ statusCode: 200 });
			const protectedHandler = requireHybridAuth(handler);

			const event = { headers: { "x-internal-key": "internal-key" } };
			await protectedHandler(event, {});

			expect(handler).toHaveBeenCalled();
			expect(event.isInternalCall).toBe(true);
		});

		it("should fall back to JWT when internal key is wrong", async () => {
			process.env.INTERNAL_API_KEY = "internal-key";
			const handler = jest.fn();
			const protectedHandler = requireHybridAuth(handler);

			const event = { headers: { "x-internal-key": "wrong-key" } };
			const result = await protectedHandler(event, {});

			expect(result.statusCode).toBe(401);
			expect(handler).not.toHaveBeenCalled();
		});

		it("should allow access with valid JWT token", async () => {
			const user = { email: "test@syntegon.com" };
			validateAuthToken.mockResolvedValue({ valid: true, user });

			const handler = jest.fn().mockResolvedValue({ statusCode: 200 });
			const protectedHandler = requireHybridAuth(handler);

			const event = { headers: { authorization: "Bearer valid-jwt" } };
			await protectedHandler(event, {});

			expect(handler).toHaveBeenCalled();
			expect(event.user).toEqual(user);
		});
	});

	describe("requireInternalAuth", () => {
		it("should return 401 when no internal key", async () => {
			const handler = jest.fn();
			const protectedHandler = requireInternalAuth(handler);

			const event = { headers: {} };
			const result = await protectedHandler(event, {});

			expect(result.statusCode).toBe(401);
			expect(handler).not.toHaveBeenCalled();
			const body = JSON.parse(result.body);
			expect(body.error).toBe("Internal authentication required");
		});

		it("should allow access with correct internal key", async () => {
			process.env.INTERNAL_API_KEY = "secret";
			const handler = jest.fn().mockResolvedValue({ statusCode: 200 });
			const protectedHandler = requireInternalAuth(handler);

			const event = { headers: { "x-internal-key": "secret" } };
			await protectedHandler(event, {});

			expect(handler).toHaveBeenCalled();
			expect(event.isInternalCall).toBe(true);
		});
	});

	describe("generateAuthCookie", () => {
		it("should generate cookie with correct parts", () => {
			const cookie = generateAuthCookie("my-token");
			expect(cookie).toContain("auth_token=my-token");
			expect(cookie).toContain("HttpOnly");
			expect(cookie).toContain("SameSite=Strict");
			expect(cookie).toContain("Path=/");
		});

		it("should set default Max-Age to 7 days", () => {
			const cookie = generateAuthCookie("token");
			const sevenDaysInSeconds = 7 * 24 * 60 * 60;
			expect(cookie).toContain(`Max-Age=${sevenDaysInSeconds}`);
		});

		it("should use custom maxAge", () => {
			const cookie = generateAuthCookie("token", 3600);
			expect(cookie).toContain("Max-Age=3600");
		});

		it("should include Secure flag in production", () => {
			process.env.NODE_ENV = "production";
			const cookie = generateAuthCookie("token");
			expect(cookie).toContain("Secure");
		});

		it("should not include Secure flag in development", () => {
			process.env.NODE_ENV = "development";
			const cookie = generateAuthCookie("token");
			expect(cookie).not.toContain("Secure");
		});

		it("should include Secure flag when CONTEXT is production", () => {
			process.env.CONTEXT = "production";
			const cookie = generateAuthCookie("token");
			expect(cookie).toContain("Secure");
		});
	});

	describe("generateLogoutCookie", () => {
		it("should return cookie that clears auth_token", () => {
			const cookie = generateLogoutCookie();
			expect(cookie).toContain("auth_token=");
			expect(cookie).toContain("Max-Age=0");
			expect(cookie).toContain("HttpOnly");
			expect(cookie).toContain("SameSite=Strict");
		});
	});

	describe("getAuthenticatedUser", () => {
		it("should return null when no token present", async () => {
			const event = { headers: {} };
			const result = await getAuthenticatedUser(event);
			expect(result).toBeNull();
		});

		it("should return null when token is invalid", async () => {
			validateAuthToken.mockResolvedValue({ valid: false });
			const event = { headers: { authorization: "Bearer bad-token" } };
			const result = await getAuthenticatedUser(event);
			expect(result).toBeNull();
		});

		it("should return user when token is valid", async () => {
			const user = { email: "test@syntegon.com" };
			validateAuthToken.mockResolvedValue({ valid: true, user });
			const event = { headers: { authorization: "Bearer good-token" } };
			const result = await getAuthenticatedUser(event);
			expect(result).toEqual(user);
		});
	});
});
