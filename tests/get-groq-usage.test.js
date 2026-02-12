/**
 * Tests for netlify/functions/get-groq-usage.js
 * Verifies the handler is properly wired with hybrid auth
 */

let mockGroqUsageHandler;
let mockRequireHybridAuth;

beforeEach(() => {
	jest.resetModules();
	jest.clearAllMocks();

	mockGroqUsageHandler = jest.fn();
	mockRequireHybridAuth = jest.fn((handler) => {
		const wrapped = function wrappedHandler(event, context) {
			return handler(event, context);
		};
		wrapped._original = handler;
		return wrapped;
	});

	jest.mock("../netlify/functions/lib/usage-api-factory", () => ({
		groqUsageHandler: mockGroqUsageHandler
	}));

	jest.mock("../netlify/functions/lib/auth-middleware", () => ({
		requireHybridAuth: mockRequireHybridAuth
	}));
});

describe("get-groq-usage", () => {
	test("module exports a handler function", () => {
		const { handler } = require("../netlify/functions/get-groq-usage");
		expect(handler).toBeDefined();
		expect(typeof handler).toBe("function");
	});

	test("handler is wrapped with requireHybridAuth", () => {
		require("../netlify/functions/get-groq-usage");
		expect(mockRequireHybridAuth).toHaveBeenCalledTimes(1);
		expect(mockRequireHybridAuth).toHaveBeenCalledWith(mockGroqUsageHandler);
	});

	test("wrapped handler delegates to groqUsageHandler", async () => {
		const mockResult = { statusCode: 200, body: "{}" };
		mockGroqUsageHandler.mockResolvedValue(mockResult);

		const { handler } = require("../netlify/functions/get-groq-usage");
		const event = { httpMethod: "GET" };
		const context = {};
		const result = await handler(event, context);

		expect(mockGroqUsageHandler).toHaveBeenCalledWith(event, context);
		expect(result).toEqual(mockResult);
	});
});
