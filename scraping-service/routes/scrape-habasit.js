// HABASIT-specific scraping endpoint handler
// Two-step process: navigate to portal + search, then extract product URL and scrape product page
const {
	launchBrowser,
	configureStandardPage,
	setupResourceBlocking
} = require("../config/puppeteer");
const {
	getMemoryUsageMB,
	trackMemoryUsage,
	scheduleRestartIfNeeded,
	getShutdownState,
	incrementRequestCount,
	forceGarbageCollection,
	setShutdownState
} = require("../utils/memory");
const { isValidCallbackUrl } = require("../utils/validation");
const { sendCallback } = require("../utils/callback");
const { enqueuePuppeteerTask } = require("./scrape");
const logger = require("./../utils/logger");

const HABASIT_PORTAL_URL = "https://portal.habasit.com";

/**
 * Navigate to Habasit portal and perform product search
 * Step 1: Navigate to portal to let the page load
 * Step 2: Type model into search bar and wait for results
 * @param {Page} page - Puppeteer page
 * @param {string} model - Product model/item number to search
 * @returns {Promise<string|null>} Product href path (e.g. "/product/25022") or null if not found
 */
async function performHabasitSearch(page, model) {
	// Step 1: Navigate to portal and let the page load
	logger.info("Navigating to Habasit Product Portal...");
	// codeql[js/request-forgery] SSRF Justification: Hardcoded URL to Habasit official portal (trusted source).
	await page.goto(HABASIT_PORTAL_URL, {
		waitUntil: "networkidle2",
		timeout: 30000
	});

	logger.info("Habasit portal loaded, waiting for search elements to render...");
	await new Promise((resolve) => setTimeout(resolve, 2000));

	// Step 2: Type model into search bar and wait for results
	const searchInputSelector = "input.form-control[placeholder='Search...']";

	const hasSearchInput = await page.evaluate((selector) => {
		return !!document.querySelector(selector);
	}, searchInputSelector);

	if (!hasSearchInput) {
		throw new Error("Search input not found on Habasit Product Portal");
	}

	logger.info(`Typing model "${model}" into search bar...`);

	// Clear any existing text and type the model name
	await page.click(searchInputSelector, { clickCount: 3 });
	await page.type(searchInputSelector, model, { delay: 50 });

	// Wait for search results to load (site auto-searches on input)
	logger.info("Waiting 5 seconds for search results to load...");
	await new Promise((resolve) => setTimeout(resolve, 5000));

	// Extract the correct product href from search results
	logger.info("Extracting product URL from search results...");
	const productHref = await page.evaluate((searchModel) => {
		const detailsDivs = document.querySelectorAll(".details");

		if (detailsDivs.length === 0) {
			return null; // No search results
		}

		// Find the details div that contains an exact match for our model in a <b> tag
		for (const detailsDiv of detailsDivs) {
			const boldTags = detailsDiv.querySelectorAll("b");
			let isExactMatch = false;

			for (const boldTag of boldTags) {
				if (boldTag.textContent.trim() === searchModel) {
					isExactMatch = true;
					break;
				}
			}

			if (isExactMatch) {
				// Extract the href from this details div
				const linkElement = detailsDiv.querySelector("a[href]");
				if (linkElement) {
					return linkElement.getAttribute("href");
				}
			}
		}

		return null; // No exact match found
	}, model);

	return productHref;
}

/**
 * Extract text content from Habasit product page
 * @param {Page} page - Puppeteer page
 * @returns {Promise<Object>} Extracted text and title
 */
async function extractHabasitContent(page) {
	logger.info("Extracting text content from Habasit product page...");

	const extractionPromise = page.evaluate(() => {
		try {
			// Remove scripts, styles, and noscript elements
			const scripts = document.querySelectorAll("script, style, noscript");
			scripts.forEach((el) => el.remove());

			const bodyText = document.body.innerText || document.body.textContent || "";
			const pageTitle = document.title || "";

			return { text: bodyText, title: pageTitle };
		} catch (e) {
			return { text: "", title: "", error: e.message };
		}
	});

	const timeoutPromise = new Promise((_, reject) =>
		setTimeout(() => reject(new Error("Content extraction timeout (10s)")), 10000)
	);

	const result = await Promise.race([extractionPromise, timeoutPromise]);

	if (result.error) {
		logger.error(`Browser evaluation error: ${result.error}`);
	}

	logger.info(`Extracted ${result.text.length} characters from Habasit product page`);

	return { text: result.text || "", title: result.title || "" };
}

/**
 * HABASIT-specific scraping endpoint handler
 */
async function handleHabasitScrapeRequest(req, res) {
	const { model, callbackUrl, jobId, urlIndex } = req.body;

	// Check shutdown state
	if (getShutdownState()) {
		logger.info(
			`Rejecting /scrape-habasit request during shutdown (current memory: ${getMemoryUsageMB().rss}MB)`
		);
		return res.status(503).json({
			error: "Service restarting due to memory limit",
			retryAfter: 30
		});
	}

	// Track memory
	const requestCount = incrementRequestCount();
	const memBefore = trackMemoryUsage(`habasit_start_${requestCount}`);
	logger.info(
		`[${new Date().toISOString()}] HABASIT Search Request #${requestCount} - Memory: ${memBefore.rss}MB RSS`
	);

	// Validate required fields
	if (!model) {
		return res.status(400).json({ error: "Model is required" });
	}

	// SSRF Protection: Validate callback URL
	const callbackValidation = isValidCallbackUrl(callbackUrl);
	if (!callbackValidation.valid) {
		logger.warn(
			`SSRF protection blocked callback URL: ${callbackUrl} - Reason: ${callbackValidation.reason}`
		);
		return res.status(400).json({
			error: "Invalid or unsafe callback URL",
			reason: callbackValidation.reason
		});
	}

	logger.info(`[${new Date().toISOString()}] HABASIT: Searching for model: ${model}`);
	if (callbackUrl) {
		logger.info(`Callback URL provided: ${callbackUrl}`);
	}

	// Generate unique task ID for tracking
	const taskId = `habasit_${Date.now()}_${Math.random().toString(36).substring(7)}`;
	logger.debug(`[HABASIT] About to send 202 response, task ID: ${taskId}`);

	// Respond immediately with 202 Accepted (fire-and-forget)
	res.status(202).json({
		success: true,
		status: "processing",
		message: "HABASIT search started, results will be sent via callback"
	});

	logger.debug(`[HABASIT] 202 response sent, about to enqueue task ${taskId}`);

	// Enqueue task in background (don't await - true fire-and-forget)
	enqueuePuppeteerTask(async () => {
		logger.debug(`[HABASIT] Task ${taskId} - Starting execution in queue`);
		let browser = null;
		let callbackSent = false;

		try {
			logger.debug(`[HABASIT] Task ${taskId} - In try block, about to launch browser`);
			browser = await launchBrowser();
			const page = await browser.newPage();

			await configureStandardPage(page);

			// Enable resource blocking (allow CSS/JS for portal functionality)
			await setupResourceBlocking(page, {
				blockImages: true,
				blockStylesheets: false,
				blockFonts: true,
				blockMedia: true,
				blockTracking: true
			});

			// Perform search and extract product href
			logger.debug(`[HABASIT] Task ${taskId} - Starting search for model: ${model}`);
			const productHref = await performHabasitSearch(page, model);

			if (!productHref) {
				logger.info(`HABASIT: No matching product found for model ${model}`);

				// Close browser before callback
				await browser.close();
				browser = null;

				// Send callback with no-results message (triggers SerpAPI fallback in pipeline)
				if (callbackUrl) {
					await sendCallback(callbackUrl, {
						jobId,
						urlIndex,
						content: `[HABASIT Search: No results found for model "${model}" on the Habasit Product Portal. No product with matching item number was found in the search results.]`,
						title: "HABASIT Search - No Results",
						snippet: `HABASIT search result for ${model}`,
						url: HABASIT_PORTAL_URL
					});
					callbackSent = true;
				}

				forceGarbageCollection();
				trackMemoryUsage(`habasit_noresults_${requestCount}`);
				scheduleRestartIfNeeded();
				return;
			}

			// Build full product URL and navigate to product page
			const productUrl = `${HABASIT_PORTAL_URL}${productHref}`;
			logger.info(`HABASIT: Found product URL: ${productUrl}, navigating to product page...`);

			await page.goto(productUrl, {
				waitUntil: "networkidle2",
				timeout: 30000
			});

			// Extract content from product page
			const { text, title } = await extractHabasitContent(page);

			let finalContent = text;
			if (!text || text.length < 50) {
				logger.warn(
					`Empty or invalid HABASIT content (${text ? text.length : 0} chars), adding explanation`
				);
				finalContent = `[HABASIT product page at ${productUrl} extracted only ${text ? text.length : 0} characters. The page may be unavailable or blocking automated access.]`;
			}

			// Close browser before callback
			await browser.close();
			browser = null;
			logger.debug(`[HABASIT] Task ${taskId} - Browser closed, memory freed`);

			// Send callback with product page content
			if (callbackUrl) {
				logger.debug(
					`[HABASIT] Task ${taskId} - Sending success callback to ${callbackUrl}`
				);
				await sendCallback(callbackUrl, {
					jobId,
					urlIndex,
					content: finalContent,
					title: title,
					snippet: `HABASIT product page for ${model}`,
					url: productUrl
				});
				callbackSent = true;
				logger.debug(`[HABASIT] Task ${taskId} - Success callback sent`);
			}

			// Cleanup
			forceGarbageCollection();
			trackMemoryUsage(`habasit_complete_${requestCount}`);
			scheduleRestartIfNeeded();
			logger.debug(`[HABASIT] Task ${taskId} - Task completed successfully`);
		} catch (error) {
			logger.error(`[HABASIT] Task ${taskId} - HABASIT scraping error:`, error);
			logger.error(`[HABASIT] Task ${taskId} - Error details:`, error.message);

			// Close browser
			if (browser) {
				try {
					await browser.close();
					logger.debug(
						`[HABASIT] Task ${taskId} - Browser closed after error, memory freed`
					);
				} catch (closeError) {
					logger.error(
						`[HABASIT] Task ${taskId} - Error closing browser after HABASIT scraping error:`,
						closeError
					);
				}
			}

			// Send error callback
			if (callbackUrl && !callbackSent) {
				logger.debug(`[HABASIT] Task ${taskId} - Sending error callback to ${callbackUrl}`);
				await sendCallback(callbackUrl, {
					jobId,
					urlIndex,
					content: `[HABASIT search failed: ${error.message}]`,
					title: null,
					snippet: "",
					url: HABASIT_PORTAL_URL
				});
				logger.debug(`[HABASIT] Task ${taskId} - Error callback sent`);
			}

			// Force restart after failed check
			logger.debug(
				`[HABASIT] Task ${taskId} - HABASIT check failed - forcing restart to free memory`
			);
			setShutdownState(true);
			scheduleRestartIfNeeded();
		} finally {
			// Ensure browser is always closed
			if (browser) {
				try {
					await browser.close();
				} catch (error_) {
					logger.error("Failed to close browser in finally block:", error_.message);
				}
			}
		}
	}).catch((error) => {
		logger.error(
			`[HABASIT] Task ${taskId} - Background HABASIT scraping failed:`,
			error.message
		);
	});

	logger.debug(`[HABASIT] Task ${taskId} enqueued successfully, continuing...`);
}

module.exports = {
	handleHabasitScrapeRequest
};
