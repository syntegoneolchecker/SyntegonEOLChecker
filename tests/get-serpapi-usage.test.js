/**
 * Tests for netlify/functions/get-serpapi-usage.js
 * Verifies the handler is properly wired with hybrid auth
 */

let mockSerpApiUsageHandler;
let mockRequireHybridAuth;

beforeEach(() => {
	jest.resetModules();
	jest.clearAllMocks();

	mockSerpApiUsageHandler = jest.fn();
	mockRequireHybridAuth = jest.fn((handler) => {
		const wrapped = function wrappedHandler(event, context) {
			return handler(event, context);
		};
		wrapped._original = handler;
		return wrapped;
	});

	jest.mock("../netlify/functions/lib/usage-api-factory", () => ({
		serpApiUsageHandler: mockSerpApiUsageHandler
	}));

	jest.mock("../netlify/functions/lib/auth-middleware", () => ({
		requireHybridAuth: mockRequireHybridAuth
	}));
});

describe("get-serpapi-usage", () => {
	test("module exports a handler function", () => {
		const { handler } = require("../netlify/functions/get-serpapi-usage");
		expect(handler).toBeDefined();
		expect(typeof handler).toBe("function");
	});

	test("handler is wrapped with requireHybridAuth", () => {
		require("../netlify/functions/get-serpapi-usage");
		expect(mockRequireHybridAuth).toHaveBeenCalledTimes(1);
		expect(mockRequireHybridAuth).toHaveBeenCalledWith(mockSerpApiUsageHandler);
	});

	test("wrapped handler delegates to serpApiUsageHandler", async () => {
		const mockResult = { statusCode: 200, body: "{}" };
		mockSerpApiUsageHandler.mockResolvedValue(mockResult);

		const { handler } = require("../netlify/functions/get-serpapi-usage");
		const event = { httpMethod: "GET" };
		const context = {};
		const result = await handler(event, context);

		expect(mockSerpApiUsageHandler).toHaveBeenCalledWith(event, context);
		expect(result).toEqual(mockResult);
	});
});
