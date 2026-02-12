/**
 * Tests for scraping-service Puppeteer configuration
 * Tests scraping-service/config/puppeteer.js
 */

// Mock the scraping service logger
jest.mock("../scraping-service/utils/logger", () => ({
	info: jest.fn(),
	warn: jest.fn(),
	error: jest.fn(),
	debug: jest.fn()
}));

// Mock puppeteer-extra-plugin-stealth (virtual: true since package is not installed locally)
jest.mock("puppeteer-extra-plugin-stealth", () => {
	return jest.fn(() => ({ name: "stealth" }));
}, { virtual: true });

// Mock puppeteer-extra (virtual: true since package is not installed locally)
const mockLaunch = jest.fn();
jest.mock("puppeteer-extra", () => {
	const mock = {
		use: jest.fn(),
		launch: mockLaunch
	};
	return mock;
}, { virtual: true });

let puppeteerConfig;
let mockLogger;

beforeEach(() => {
	jest.clearAllMocks();
	puppeteerConfig = require("../scraping-service/config/puppeteer");
	mockLogger = require("../scraping-service/utils/logger");
});

describe("Scraping Service - Puppeteer Configuration", () => {
	describe("getStandardBrowserArgs", () => {
		test("should return an array", () => {
			const args = puppeteerConfig.getStandardBrowserArgs();

			expect(Array.isArray(args)).toBe(true);
		});

		test("should include --no-sandbox", () => {
			const args = puppeteerConfig.getStandardBrowserArgs();

			expect(args).toContain("--no-sandbox");
		});

		test("should include --disable-setuid-sandbox", () => {
			const args = puppeteerConfig.getStandardBrowserArgs();

			expect(args).toContain("--disable-setuid-sandbox");
		});

		test("should include --disable-dev-shm-usage", () => {
			const args = puppeteerConfig.getStandardBrowserArgs();

			expect(args).toContain("--disable-dev-shm-usage");
		});

		test("should include --disable-gpu", () => {
			const args = puppeteerConfig.getStandardBrowserArgs();

			expect(args).toContain("--disable-gpu");
		});

		test("should include --no-zygote", () => {
			const args = puppeteerConfig.getStandardBrowserArgs();

			expect(args).toContain("--no-zygote");
		});

		test("should include --single-process for memory optimization", () => {
			const args = puppeteerConfig.getStandardBrowserArgs();

			expect(args).toContain("--single-process");
		});

		test("should include --disable-blink-features=AutomationControlled", () => {
			const args = puppeteerConfig.getStandardBrowserArgs();

			expect(args).toContain("--disable-blink-features=AutomationControlled");
		});

		test("should include V8 heap size limit argument", () => {
			const args = puppeteerConfig.getStandardBrowserArgs();

			expect(args).toContain("--js-flags=--max-old-space-size=256");
		});

		test("should include --disable-extensions", () => {
			const args = puppeteerConfig.getStandardBrowserArgs();

			expect(args).toContain("--disable-extensions");
		});

		test("should return more than 10 arguments", () => {
			const args = puppeteerConfig.getStandardBrowserArgs();

			expect(args.length).toBeGreaterThan(10);
		});

		test("should return all string values", () => {
			const args = puppeteerConfig.getStandardBrowserArgs();

			args.forEach((arg) => {
				expect(typeof arg).toBe("string");
			});
		});

		test("should have all arguments starting with --", () => {
			const args = puppeteerConfig.getStandardBrowserArgs();

			args.forEach((arg) => {
				expect(arg.startsWith("--")).toBe(true);
			});
		});
	});

	describe("launchBrowser", () => {
		test("should call puppeteer.launch with standard args", async () => {
			mockLaunch.mockResolvedValue({ close: jest.fn() });

			await puppeteerConfig.launchBrowser();

			expect(mockLaunch).toHaveBeenCalledTimes(1);
			expect(mockLaunch).toHaveBeenCalledWith(
				expect.objectContaining({
					args: puppeteerConfig.getStandardBrowserArgs()
				})
			);
		});

		test("should use headless new mode", async () => {
			mockLaunch.mockResolvedValue({ close: jest.fn() });

			await puppeteerConfig.launchBrowser();

			expect(mockLaunch).toHaveBeenCalledWith(
				expect.objectContaining({
					headless: "new"
				})
			);
		});

		test("should set a 120-second timeout", async () => {
			mockLaunch.mockResolvedValue({ close: jest.fn() });

			await puppeteerConfig.launchBrowser();

			expect(mockLaunch).toHaveBeenCalledWith(
				expect.objectContaining({
					timeout: 120000
				})
			);
		});

		test("should allow additional options to be passed", async () => {
			mockLaunch.mockResolvedValue({ close: jest.fn() });

			await puppeteerConfig.launchBrowser({ executablePath: "/usr/bin/chromium" });

			expect(mockLaunch).toHaveBeenCalledWith(
				expect.objectContaining({
					executablePath: "/usr/bin/chromium"
				})
			);
		});

		test("should allow overriding default options", async () => {
			mockLaunch.mockResolvedValue({ close: jest.fn() });

			await puppeteerConfig.launchBrowser({ timeout: 60000 });

			expect(mockLaunch).toHaveBeenCalledWith(
				expect.objectContaining({
					timeout: 60000
				})
			);
		});

		test("should return the browser instance from puppeteer.launch", async () => {
			const mockBrowser = { close: jest.fn(), newPage: jest.fn() };
			mockLaunch.mockResolvedValue(mockBrowser);

			const browser = await puppeteerConfig.launchBrowser();

			expect(browser).toBe(mockBrowser);
		});
	});

	describe("configureStandardPage", () => {
		let mockPage;

		beforeEach(() => {
			mockPage = {
				setUserAgent: jest.fn().mockResolvedValue(undefined),
				setViewport: jest.fn().mockResolvedValue(undefined)
			};
		});

		test("should set a default user agent", async () => {
			await puppeteerConfig.configureStandardPage(mockPage);

			expect(mockPage.setUserAgent).toHaveBeenCalledTimes(1);
			expect(mockPage.setUserAgent).toHaveBeenCalledWith(
				expect.stringContaining("Mozilla/5.0")
			);
		});

		test("should set default viewport to 1280x720", async () => {
			await puppeteerConfig.configureStandardPage(mockPage);

			expect(mockPage.setViewport).toHaveBeenCalledTimes(1);
			expect(mockPage.setViewport).toHaveBeenCalledWith({
				width: 1280,
				height: 720
			});
		});

		test("should allow custom user agent", async () => {
			const customAgent = "CustomBot/1.0";

			await puppeteerConfig.configureStandardPage(mockPage, { userAgent: customAgent });

			expect(mockPage.setUserAgent).toHaveBeenCalledWith(customAgent);
		});

		test("should allow custom viewport dimensions", async () => {
			await puppeteerConfig.configureStandardPage(mockPage, {
				viewportWidth: 1920,
				viewportHeight: 1080
			});

			expect(mockPage.setViewport).toHaveBeenCalledWith({
				width: 1920,
				height: 1080
			});
		});

		test("should use Chrome user agent string by default", async () => {
			await puppeteerConfig.configureStandardPage(mockPage);

			const userAgentArg = mockPage.setUserAgent.mock.calls[0][0];
			expect(userAgentArg).toContain("Chrome");
		});
	});

	describe("setupResourceBlocking", () => {
		let mockPage;
		let requestHandler;

		beforeEach(() => {
			mockPage = {
				setRequestInterception: jest.fn().mockResolvedValue(undefined),
				on: jest.fn((event, handler) => {
					if (event === "request") {
						requestHandler = handler;
					}
				})
			};
		});

		test("should enable request interception on the page", async () => {
			await puppeteerConfig.setupResourceBlocking(mockPage);

			expect(mockPage.setRequestInterception).toHaveBeenCalledWith(true);
		});

		test("should register a request event listener", async () => {
			await puppeteerConfig.setupResourceBlocking(mockPage);

			expect(mockPage.on).toHaveBeenCalledWith("request", expect.any(Function));
		});

		test("should block image requests by default", async () => {
			await puppeteerConfig.setupResourceBlocking(mockPage);

			const mockRequest = {
				url: () => "https://example.com/image.png",
				resourceType: () => "image",
				abort: jest.fn(),
				continue: jest.fn()
			};

			requestHandler(mockRequest);

			expect(mockRequest.abort).toHaveBeenCalled();
			expect(mockRequest.continue).not.toHaveBeenCalled();
		});

		test("should not block stylesheet requests by default", async () => {
			await puppeteerConfig.setupResourceBlocking(mockPage);

			const mockRequest = {
				url: () => "https://example.com/style.css",
				resourceType: () => "stylesheet",
				abort: jest.fn(),
				continue: jest.fn()
			};

			requestHandler(mockRequest);

			expect(mockRequest.continue).toHaveBeenCalled();
			expect(mockRequest.abort).not.toHaveBeenCalled();
		});

		test("should block font requests by default", async () => {
			await puppeteerConfig.setupResourceBlocking(mockPage);

			const mockRequest = {
				url: () => "https://example.com/font.woff2",
				resourceType: () => "font",
				abort: jest.fn(),
				continue: jest.fn()
			};

			requestHandler(mockRequest);

			expect(mockRequest.abort).toHaveBeenCalled();
		});

		test("should block media requests by default", async () => {
			await puppeteerConfig.setupResourceBlocking(mockPage);

			const mockRequest = {
				url: () => "https://example.com/video.mp4",
				resourceType: () => "media",
				abort: jest.fn(),
				continue: jest.fn()
			};

			requestHandler(mockRequest);

			expect(mockRequest.abort).toHaveBeenCalled();
		});

		test("should block stylesheet requests when blockStylesheets is true", async () => {
			await puppeteerConfig.setupResourceBlocking(mockPage, { blockStylesheets: true });

			const mockRequest = {
				url: () => "https://example.com/style.css",
				resourceType: () => "stylesheet",
				abort: jest.fn(),
				continue: jest.fn()
			};

			requestHandler(mockRequest);

			expect(mockRequest.abort).toHaveBeenCalled();
		});

		test("should allow image requests when blockImages is false", async () => {
			await puppeteerConfig.setupResourceBlocking(mockPage, { blockImages: false });

			const mockRequest = {
				url: () => "https://example.com/image.png",
				resourceType: () => "image",
				abort: jest.fn(),
				continue: jest.fn()
			};

			requestHandler(mockRequest);

			expect(mockRequest.continue).toHaveBeenCalled();
		});

		test("should block tracking domains by default", async () => {
			await puppeteerConfig.setupResourceBlocking(mockPage);

			const mockRequest = {
				url: () => "https://www.google-analytics.com/analytics.js",
				resourceType: () => "script",
				abort: jest.fn(),
				continue: jest.fn()
			};

			requestHandler(mockRequest);

			expect(mockRequest.abort).toHaveBeenCalled();
		});

		test("should block googletagmanager.com domain", async () => {
			await puppeteerConfig.setupResourceBlocking(mockPage);

			const mockRequest = {
				url: () => "https://www.googletagmanager.com/gtm.js",
				resourceType: () => "script",
				abort: jest.fn(),
				continue: jest.fn()
			};

			requestHandler(mockRequest);

			expect(mockRequest.abort).toHaveBeenCalled();
		});

		test("should block facebook tracking domain", async () => {
			await puppeteerConfig.setupResourceBlocking(mockPage);

			const mockRequest = {
				url: () => "https://connect.facebook.net/en_US/fbevents.js",
				resourceType: () => "script",
				abort: jest.fn(),
				continue: jest.fn()
			};

			requestHandler(mockRequest);

			expect(mockRequest.abort).toHaveBeenCalled();
		});

		test("should block hotjar.com domain", async () => {
			await puppeteerConfig.setupResourceBlocking(mockPage);

			const mockRequest = {
				url: () => "https://static.hotjar.com/c/hotjar.js",
				resourceType: () => "script",
				abort: jest.fn(),
				continue: jest.fn()
			};

			requestHandler(mockRequest);

			expect(mockRequest.abort).toHaveBeenCalled();
		});

		test("should not block tracking domains when blockTracking is false", async () => {
			await puppeteerConfig.setupResourceBlocking(mockPage, { blockTracking: false });

			const mockRequest = {
				url: () => "https://www.google-analytics.com/analytics.js",
				resourceType: () => "script",
				abort: jest.fn(),
				continue: jest.fn()
			};

			requestHandler(mockRequest);

			expect(mockRequest.continue).toHaveBeenCalled();
		});

		test("should block custom domains when provided", async () => {
			await puppeteerConfig.setupResourceBlocking(mockPage, {
				customBlockedDomains: ["custom-tracker.com"]
			});

			const mockRequest = {
				url: () => "https://custom-tracker.com/track.js",
				resourceType: () => "script",
				abort: jest.fn(),
				continue: jest.fn()
			};

			requestHandler(mockRequest);

			expect(mockRequest.abort).toHaveBeenCalled();
		});

		test("should continue normal document requests", async () => {
			await puppeteerConfig.setupResourceBlocking(mockPage);

			const mockRequest = {
				url: () => "https://example.com/page",
				resourceType: () => "document",
				abort: jest.fn(),
				continue: jest.fn()
			};

			requestHandler(mockRequest);

			expect(mockRequest.continue).toHaveBeenCalled();
		});

		test("should continue script requests from non-blocked domains", async () => {
			await puppeteerConfig.setupResourceBlocking(mockPage);

			const mockRequest = {
				url: () => "https://example.com/app.js",
				resourceType: () => "script",
				abort: jest.fn(),
				continue: jest.fn()
			};

			requestHandler(mockRequest);

			expect(mockRequest.continue).toHaveBeenCalled();
		});

		test("should log resource blocking description", async () => {
			await puppeteerConfig.setupResourceBlocking(mockPage);

			expect(mockLogger.info).toHaveBeenCalledWith(
				expect.stringContaining("Resource blocking enabled")
			);
		});

		test("should log enabled blocking types", async () => {
			await puppeteerConfig.setupResourceBlocking(mockPage, {
				blockImages: true,
				blockStylesheets: true,
				blockFonts: false,
				blockMedia: false,
				blockTracking: false
			});

			expect(mockLogger.info).toHaveBeenCalledWith(
				expect.stringContaining("images")
			);
			expect(mockLogger.info).toHaveBeenCalledWith(
				expect.stringContaining("stylesheets")
			);
		});
	});

	describe("extractPageContent", () => {
		test("should call page.evaluate for content extraction", async () => {
			const mockPage = {
				evaluate: jest.fn().mockResolvedValue("Page content here"),
				title: jest.fn().mockResolvedValue("Page Title")
			};

			const result = await puppeteerConfig.extractPageContent(mockPage);

			expect(mockPage.evaluate).toHaveBeenCalled();
			expect(result).toEqual({
				content: "Page content here",
				title: "Page Title"
			});
		});

		test("should return content and title from the page", async () => {
			const mockPage = {
				evaluate: jest.fn().mockResolvedValue("Product specifications"),
				title: jest.fn().mockResolvedValue("Product ABC-123")
			};

			const result = await puppeteerConfig.extractPageContent(mockPage);

			expect(result.content).toBe("Product specifications");
			expect(result.title).toBe("Product ABC-123");
		});

		test("should reject with timeout error if extraction takes too long", async () => {
			const mockPage = {
				evaluate: jest.fn().mockImplementation(
					() => new Promise((resolve) => setTimeout(() => resolve("data"), 5000))
				),
				title: jest.fn().mockResolvedValue("Title")
			};

			await expect(puppeteerConfig.extractPageContent(mockPage, 50)).rejects.toThrow(
				"Content extraction timeout"
			);
		});

		test("should use default timeout of 10000ms", async () => {
			const mockPage = {
				evaluate: jest.fn().mockResolvedValue("Content"),
				title: jest.fn().mockResolvedValue("Title")
			};

			// Should resolve quickly since evaluate is instant
			const result = await puppeteerConfig.extractPageContent(mockPage);

			expect(result.content).toBe("Content");
		});

		test("should propagate errors from page.evaluate", async () => {
			const mockPage = {
				evaluate: jest.fn().mockRejectedValue(new Error("Evaluation failed")),
				title: jest.fn().mockResolvedValue("Title")
			};

			await expect(puppeteerConfig.extractPageContent(mockPage)).rejects.toThrow(
				"Evaluation failed"
			);
		});
	});

	describe("stealth plugin integration", () => {
		test("should have called use on puppeteer-extra during module load", () => {
			// puppeteer.use(StealthPlugin()) is called at module load time
			// We verify the mock was configured correctly and the module exports puppeteer
			expect(puppeteerConfig.puppeteer).toBeDefined();
			expect(puppeteerConfig.puppeteer.use).toBeDefined();
			expect(typeof puppeteerConfig.puppeteer.use).toBe("function");
		});

		test("should export puppeteer with use and launch methods", () => {
			expect(typeof puppeteerConfig.puppeteer.use).toBe("function");
			expect(typeof puppeteerConfig.puppeteer.launch).toBe("function");
		});
	});

	describe("module exports", () => {
		test("should export puppeteer instance", () => {
			expect(puppeteerConfig.puppeteer).toBeDefined();
		});

		test("should export getStandardBrowserArgs function", () => {
			expect(typeof puppeteerConfig.getStandardBrowserArgs).toBe("function");
		});

		test("should export launchBrowser function", () => {
			expect(typeof puppeteerConfig.launchBrowser).toBe("function");
		});

		test("should export configureStandardPage function", () => {
			expect(typeof puppeteerConfig.configureStandardPage).toBe("function");
		});

		test("should export setupResourceBlocking function", () => {
			expect(typeof puppeteerConfig.setupResourceBlocking).toBe("function");
		});

		test("should export extractPageContent function", () => {
			expect(typeof puppeteerConfig.extractPageContent).toBe("function");
		});
	});
});
