// SICK-specific scraping endpoint handler
// Two-step category search: Products (g568268) first, then Archive (g575879)
// Matches product by checking .compact divs for exact model name, extracts product URL, scrapes product page
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

const SICK_BASE_URL = "https://www.sick.com";
const SICK_CATEGORIES = [
	{ id: "g568268", name: "Products" },
	{ id: "g575879", name: "Archive" }
];

/**
 * Build SICK search URL for a given model and category
 * @param {string} model - Product model to search
 * @param {string} categoryId - SICK category ID
 * @returns {string} Full search URL
 */
function buildSickSearchUrl(model, categoryId) {
	const encodedModel = encodeURIComponent(model);
	return `${SICK_BASE_URL}/ag/en/search?text=${encodedModel}&category=${categoryId}`;
}

/**
 * Search a single SICK category for exact model match
 * Navigates to search URL and checks .compact divs for >{modelName}< pattern
 * @param {Page} page - Puppeteer page
 * @param {string} model - Product model to search
 * @param {string} categoryId - SICK category ID
 * @param {string} categoryName - Category display name for logging
 * @returns {Promise<string|null>} Full product URL or null if not found
 */
async function searchSickCategory(page, model, categoryId, categoryName) {
	const searchUrl = buildSickSearchUrl(model, categoryId);
	logger.info(`SICK: Searching ${categoryName} category at ${searchUrl}`);

	// codeql[js/request-forgery] SSRF Justification: URL constructed from hardcoded SICK base URL with user-provided model name (search parameter only).
	await page.goto(searchUrl, {
		waitUntil: "networkidle2",
		timeout: 30000
	});

	// Wait for Angular SPA to render search results
	logger.info(`SICK: Waiting for ${categoryName} search results to render...`);
	await new Promise((resolve) => setTimeout(resolve, 5000));

	// Extract product URL from .compact divs by checking for exact model match
	const productUrl = await page.evaluate((searchModel) => {
		const compactDivs = document.querySelectorAll(".compact");
		const pattern = ">" + searchModel + "<";

		for (const div of compactDivs) {
			if (div.innerHTML.includes(pattern)) {
				const nameLink = div.querySelector("a.name");
				if (nameLink) {
					const href = nameLink.getAttribute("href") || "";
					return href.startsWith("http")
						? href
						: "https://www.sick.com" + href;
				}
			}
		}

		return null;
	}, model);

	if (productUrl) {
		logger.info(`SICK: Found match in ${categoryName} category: ${productUrl}`);
	} else {
		logger.info(`SICK: No match found in ${categoryName} category`);
	}

	return productUrl;
}

/**
 * Extract text content from SICK product page
 * @param {Page} page - Puppeteer page
 * @returns {Promise<Object>} Extracted text and title
 */
async function extractSickContent(page) {
	logger.info("SICK: Extracting text content from product page...");

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
		logger.error(`SICK: Browser evaluation error: ${result.error}`);
	}

	logger.info(`SICK: Extracted ${result.text.length} characters from product page`);

	return { text: result.text || "", title: result.title || "" };
}

/**
 * Safely close a Puppeteer browser, logging any errors
 * @param {Browser|null} browser - Browser instance to close
 * @param {string} context - Logging context string
 */
async function closeBrowserSafely(browser, context) {
	if (!browser) return;
	try {
		await browser.close();
	} catch (error) {
		logger.error(`${context} - Error closing browser:`, error.message);
	}
}

/**
 * Search all SICK categories for a product match
 * @param {Page} page - Puppeteer page
 * @param {string} model - Product model to search
 * @returns {Promise<string|null>} Product URL or null
 */
async function findProductInCategories(page, model) {
	for (const category of SICK_CATEGORIES) {
		const productUrl = await searchSickCategory(page, model, category.id, category.name);
		if (productUrl) return productUrl;
	}
	return null;
}

/**
 * Validate and build final content string from extracted text
 * @param {string} text - Extracted text content
 * @param {string} productUrl - URL of the product page
 * @returns {string} Final content string
 */
function buildSickFinalContent(text, productUrl) {
	if (text && text.length >= 50) {
		return text;
	}
	const charCount = text ? text.length : 0;
	logger.warn(
		`Empty or invalid SICK content (${charCount} chars), adding explanation`
	);
	return `[SICK product page at ${productUrl} extracted only ${charCount} characters. The page may be unavailable or blocking automated access.]`;
}

/**
 * Send callback if callbackUrl is provided
 * @param {string|null} callbackUrl - Callback URL
 * @param {Object} data - Callback payload
 * @returns {Promise<boolean>} Whether callback was sent
 */
async function sendSickCallback(callbackUrl, data) {
	if (!callbackUrl) return false;
	await sendCallback(callbackUrl, data);
	return true;
}

/**
 * SICK-specific scraping endpoint handler
 */
async function handleSickScrapeRequest(req, res) {
	const { model, callbackUrl, jobId, urlIndex } = req.body;

	// Check shutdown state
	if (getShutdownState()) {
		logger.info(
			`Rejecting /scrape-sick request during shutdown (current memory: ${getMemoryUsageMB().rss}MB)`
		);
		return res.status(503).json({
			error: "Service restarting due to memory limit",
			retryAfter: 30
		});
	}

	// Track memory
	const requestCount = incrementRequestCount();
	const memBefore = trackMemoryUsage(`sick_start_${requestCount}`);
	logger.info(
		`[${new Date().toISOString()}] SICK Search Request #${requestCount} - Memory: ${memBefore.rss}MB RSS`
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

	logger.info(`[${new Date().toISOString()}] SICK: Searching for model: ${model}`);
	if (callbackUrl) {
		logger.info(`Callback URL provided: ${callbackUrl}`);
	}

	// Generate unique task ID for tracking
	const taskId = `sick_${Date.now()}_${Math.random().toString(36).substring(7)}`;
	logger.debug(`[SICK] About to send 202 response, task ID: ${taskId}`);

	// Respond immediately with 202 Accepted (fire-and-forget)
	res.status(202).json({
		success: true,
		status: "processing",
		message: "SICK search started, results will be sent via callback"
	});

	logger.debug(`[SICK] 202 response sent, about to enqueue task ${taskId}`);

	// Enqueue task in background (don't await - true fire-and-forget)
	enqueuePuppeteerTask(async () => {
		logger.debug(`[SICK] Task ${taskId} - Starting execution in queue`);
		let browser = null;
		let callbackSent = false;

		try {
			logger.debug(`[SICK] Task ${taskId} - In try block, about to launch browser`);
			browser = await launchBrowser();
			const page = await browser.newPage();

			await configureStandardPage(page);

			// Enable resource blocking (allow CSS/JS for Angular SPA)
			await setupResourceBlocking(page, {
				blockImages: true,
				blockStylesheets: false,
				blockFonts: true,
				blockMedia: true,
				blockTracking: true
			});

			// Search categories sequentially: Products first, then Archive
			const productUrl = await findProductInCategories(page, model);

			if (!productUrl) {
				logger.info(`SICK: No matching product found for model ${model} in any category`);
				await browser.close();
				browser = null;

				callbackSent = await sendSickCallback(callbackUrl, {
					jobId,
					urlIndex,
					content: `[SICK Search: No results found for model "${model}" in Products or Archive categories on sick.com. No product with matching name was found in the search results.]`,
					title: "SICK Search - No Results",
					snippet: `SICK search result for ${model}`,
					url: SICK_BASE_URL
				});

				forceGarbageCollection();
				trackMemoryUsage(`sick_noresults_${requestCount}`);
				scheduleRestartIfNeeded();
				return;
			}

			// Navigate to product page and extract content
			logger.info(`SICK: Navigating to product page: ${productUrl}`);
			await page.goto(productUrl, {
				waitUntil: "networkidle2",
				timeout: 30000
			});

			// Wait for Angular SPA to render product page
			await new Promise((resolve) => setTimeout(resolve, 3000));

			const { text, title } = await extractSickContent(page);
			const finalContent = buildSickFinalContent(text, productUrl);

			// Close browser before callback
			await browser.close();
			browser = null;
			logger.debug(`[SICK] Task ${taskId} - Browser closed, memory freed`);

			// Send callback with product page content
			logger.debug(
				`[SICK] Task ${taskId} - Sending success callback to ${callbackUrl}`
			);
			callbackSent = await sendSickCallback(callbackUrl, {
				jobId,
				urlIndex,
				content: finalContent,
				title: title,
				snippet: `SICK product page for ${model}`,
				url: productUrl
			});
			logger.debug(`[SICK] Task ${taskId} - Success callback sent`);

			// Cleanup
			forceGarbageCollection();
			trackMemoryUsage(`sick_complete_${requestCount}`);
			scheduleRestartIfNeeded();
			logger.debug(`[SICK] Task ${taskId} - Task completed successfully`);
		} catch (error) {
			logger.error(`[SICK] Task ${taskId} - SICK scraping error:`, error);
			logger.error(`[SICK] Task ${taskId} - Error details:`, error.message);

			await closeBrowserSafely(browser, `[SICK] Task ${taskId}`);
			browser = null;

			if (!callbackSent) {
				logger.debug(`[SICK] Task ${taskId} - Sending error callback to ${callbackUrl}`);
				await sendSickCallback(callbackUrl, {
					jobId,
					urlIndex,
					content: `[SICK search failed: ${error.message}]`,
					title: null,
					snippet: "",
					url: SICK_BASE_URL
				});
				logger.debug(`[SICK] Task ${taskId} - Error callback sent`);
			}

			// Force restart after failed check
			logger.debug(
				`[SICK] Task ${taskId} - SICK check failed - forcing restart to free memory`
			);
			setShutdownState(true);
			scheduleRestartIfNeeded();
		} finally {
			await closeBrowserSafely(browser, "[SICK] finally block");
		}
	}).catch((error) => {
		logger.error(
			`[SICK] Task ${taskId} - Background SICK scraping failed:`,
			error.message
		);
	});

	logger.debug(`[SICK] Task ${taskId} enqueued successfully, continuing...`);
}

module.exports = {
	handleSickScrapeRequest
};
