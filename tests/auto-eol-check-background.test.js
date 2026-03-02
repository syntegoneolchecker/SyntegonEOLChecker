/**
 * Tests for netlify/functions/auto-eol-check-background.js
 */

const mockGetStore = jest.fn();
jest.mock("@netlify/blobs", () => ({
	getStore: mockGetStore
}));

jest.mock("../netlify/functions/lib/csv-parser", () => ({
	parseCSV: jest.fn(),
	toCSV: jest.fn()
}));

jest.mock("../netlify/functions/lib/logger", () => ({
	info: jest.fn(),
	warn: jest.fn(),
	error: jest.fn(),
	debug: jest.fn()
}));

jest.mock("../netlify/functions/lib/config", () => ({
	MAX_AUTO_CHECKS_PER_DAY: 20,
	MIN_SERPAPI_CREDITS_FOR_AUTO: 30,
	DEFAULT_SCRAPING_SERVICE_URL: "https://eolscrapingservice.onrender.com",
	DEFAULT_NETLIFY_SITE_URL: "https://syntegoneolchecker.netlify.app",
	DEVELOP_NETLIFY_SITE_URL: "https://develop--syntegoneolchecker.netlify.app"
}));

jest.mock("../netlify/functions/lib/auth-middleware", () => ({
	requireHybridAuth: jest.fn((handler) => handler)
}));

jest.mock("../netlify/functions/lib/job-storage", () => ({
	updateJobStatus: jest.fn()
}));

describe("auto-eol-check-background", () => {
	describe("handler module exports", () => {
		test("exports a handler function", () => {
			jest.resetModules();
			const mod = require("../netlify/functions/auto-eol-check-background");
			expect(mod.handler).toBeDefined();
			expect(typeof mod.handler).toBe("function");
		});

		test("handler is wrapped with requireHybridAuth", () => {
			jest.resetModules();
			require("../netlify/functions/auto-eol-check-background");
			const { requireHybridAuth } = require("../netlify/functions/lib/auth-middleware");
			expect(requireHybridAuth).toHaveBeenCalledTimes(1);
			expect(requireHybridAuth).toHaveBeenCalledWith(expect.any(Function));
		});
	});
});
