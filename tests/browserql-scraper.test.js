/**
 * Tests for browserql-scraper.js
 * All fetch calls mocked — no real BrowserQL API requests
 */

jest.mock("../netlify/functions/lib/logger", () => ({
	info: jest.fn(),
	warn: jest.fn(),
	error: jest.fn(),
	debug: jest.fn()
}));

const originalEnv = { ...process.env };
const originalFetch = global.fetch;

beforeEach(() => {
	jest.clearAllMocks();
	global.fetch = jest.fn();
	process.env.BROWSERQL_API_KEY = "test-browserql-key";
});

afterEach(() => {
	global.fetch = originalFetch;
	process.env = { ...originalEnv };
});

const { scrapeWithBrowserQL } = require("../netlify/functions/lib/browserql-scraper");

describe("BrowserQL Scraper", () => {
	test("should throw if BROWSERQL_API_KEY is not set", async () => {
		delete process.env.BROWSERQL_API_KEY;

		await expect(scrapeWithBrowserQL("https://example.com")).rejects.toThrow(
			"BROWSERQL_API_KEY environment variable not set"
		);
	});

	test("should call BrowserQL API with correct URL and token", async () => {
		global.fetch.mockResolvedValue({
			ok: true,
			json: () =>
				Promise.resolve({
					data: {
						pageContent: {
							value: JSON.stringify({ text: "Scraped content here", error: null })
						}
					}
				})
		});

		await scrapeWithBrowserQL("https://example.com/product");

		expect(global.fetch).toHaveBeenCalledWith(
			"https://production-sfo.browserless.io/stealth/bql?token=test-browserql-key",
			expect.objectContaining({
				method: "POST",
				headers: { "Content-Type": "application/json" }
			})
		);

		// Verify GraphQL query contains the URL
		const callBody = JSON.parse(global.fetch.mock.calls[0][1].body);
		expect(callBody.query).toContain("https://example.com/product");
	});

	test("should return scraped content on success", async () => {
		global.fetch.mockResolvedValue({
			ok: true,
			json: () =>
				Promise.resolve({
					data: {
						pageContent: {
							value: JSON.stringify({
								text: "Product XYZ is discontinued",
								error: null
							})
						}
					}
				})
		});

		const result = await scrapeWithBrowserQL("https://example.com");

		expect(result.content).toBe("Product XYZ is discontinued");
		expect(result.success).toBe(true);
		expect(result.title).toBeNull();
	});

	test("should throw on HTTP error from BrowserQL API", async () => {
		global.fetch.mockResolvedValue({
			ok: false,
			status: 429,
			text: () => Promise.resolve("Token limit exceeded")
		});

		await expect(scrapeWithBrowserQL("https://example.com")).rejects.toThrow(
			"BrowserQL API error: 429 - Token limit exceeded"
		);
	});

	test("should throw on GraphQL errors in response", async () => {
		global.fetch.mockResolvedValue({
			ok: true,
			json: () =>
				Promise.resolve({
					errors: [{ message: "Navigation timeout" }]
				})
		});

		await expect(scrapeWithBrowserQL("https://example.com")).rejects.toThrow(
			"BrowserQL GraphQL errors"
		);
	});

	test("should throw when no pageContent in response", async () => {
		global.fetch.mockResolvedValue({
			ok: true,
			json: () =>
				Promise.resolve({
					data: {}
				})
		});

		await expect(scrapeWithBrowserQL("https://example.com")).rejects.toThrow(
			"BrowserQL returned no data"
		);
	});

	test("should throw on evaluation error from page script", async () => {
		global.fetch.mockResolvedValue({
			ok: true,
			json: () =>
				Promise.resolve({
					data: {
						pageContent: {
							value: JSON.stringify({ text: null, error: "document.body is null" })
						}
					}
				})
		});

		await expect(scrapeWithBrowserQL("https://example.com")).rejects.toThrow(
			"BrowserQL evaluation error: document.body is null"
		);
	});

	test("should throw when evaluated content is empty", async () => {
		global.fetch.mockResolvedValue({
			ok: true,
			json: () =>
				Promise.resolve({
					data: {
						pageContent: {
							value: JSON.stringify({ text: "", error: null })
						}
					}
				})
		});

		await expect(scrapeWithBrowserQL("https://example.com")).rejects.toThrow(
			"BrowserQL returned empty content"
		);
	});

	test("should escape special characters in URL for GraphQL", async () => {
		global.fetch.mockResolvedValue({
			ok: true,
			json: () =>
				Promise.resolve({
					data: {
						pageContent: {
							value: JSON.stringify({ text: "Content", error: null })
						}
					}
				})
		});

		await scrapeWithBrowserQL('https://example.com/search?q="test"&page=1');

		const callBody = JSON.parse(global.fetch.mock.calls[0][1].body);
		// Double quotes should be escaped for GraphQL
		expect(callBody.query).toContain('\\"test\\"');
		expect(callBody.query).not.toContain('q="test"');
	});

	test("should escape backslashes in URL", async () => {
		global.fetch.mockResolvedValue({
			ok: true,
			json: () =>
				Promise.resolve({
					data: {
						pageContent: {
							value: JSON.stringify({ text: "Content", error: null })
						}
					}
				})
		});

		await scrapeWithBrowserQL("https://example.com/path\\with\\backslash");

		const callBody = JSON.parse(global.fetch.mock.calls[0][1].body);
		expect(callBody.query).toContain("\\\\");
	});
});
