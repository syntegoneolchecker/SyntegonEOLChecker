// Main scraping endpoint handler
const {
  launchBrowser,
  configureStandardPage,
  setupResourceBlocking,
  extractPageContent,
} = require("../config/puppeteer");
const {
  getMemoryUsageMB,
  trackMemoryUsage,
  shouldRestartDueToMemory,
  scheduleRestartIfNeeded,
  getShutdownState,
  incrementRequestCount,
  getRequestCount,
  forceGarbageCollection,
} = require("../utils/memory");
const { isSafePublicUrl, isValidCallbackUrl } = require("../utils/validation");
const {
  tryFastFetch,
  isPDFUrl,
  isTextFileUrl,
} = require("../utils/extraction");
const { sendCallback } = require("../utils/callback");
const logger = require('./../utils/logger');

// Request queue: Only allow one Puppeteer instance at a time
// This prevents memory spikes from concurrent browser instances
let puppeteerQueue = Promise.resolve();

/**
 * Enqueue a Puppeteer task to prevent concurrent browser instances
 * @param {Function} task - Async task to execute
 * @returns {Promise} Task result
 */
function enqueuePuppeteerTask(task) {
  const result = puppeteerQueue.then(task, task); // Run task whether previous succeeded or failed
  puppeteerQueue = result.catch(() => {}); // Prevent unhandled rejections from blocking queue
  return result;
}

/**
 * Handle Puppeteer scraping for dynamic HTML pages
 * @param {string} url - URL to scrape
 * @param {string} callbackUrl - Callback URL for results
 * @param {Object} callbackData - Data to include in callback
 * @param {Object} res - Express response object
 * @returns {Promise<void>}
 */
async function handlePuppeteerScraping(url, callbackUrl, callbackData, _res) {
  return enqueuePuppeteerTask(async () => {
    let browser = null;
    const callbackSent = false;

    try {
      browser = await launchBrowser();
      const page = await browser.newPage();

      await configureStandardPage(page);

      // Conditionally enable resource blocking
      const isCloudflareProtected = url.includes("orientalmotor.co.jp");
      if (isCloudflareProtected) {
        logger.info(
          "Resource blocking DISABLED for Cloudflare-protected site (Oriental Motor)"
        );
      } else {
        await setupResourceBlocking(page, {
          blockImages: true,
          blockStylesheets: false,
          blockFonts: true,
          blockMedia: true,
          blockTracking: true,
        });
      }

      // Set up network monitoring for diagnostics
      const pendingRequests = setupNetworkMonitoring(page);

      // Determine wait strategy and timeout
      const waitStrategy = "networkidle2";
      const navTimeout = 45000;

      // SSRF Protection: Validate URL before Puppeteer navigation
      const urlValidation = isSafePublicUrl(url);
      if (!urlValidation.valid) {
        logger.error(
          `SSRF protection: Blocked unsafe URL for Puppeteer: ${url} - ${urlValidation.reason}`
        );
        throw new Error(`Invalid URL for scraping: ${urlValidation.reason}`);
      }

      // Navigate with timeout handling
      const navigationResult = await navigateWithTimeout(
        page,
        url,
        waitStrategy,
        navTimeout,
        pendingRequests
      );
      const navigationTimedOut = navigationResult.timedOut;

      // Wait for rendering
      await waitForRendering(isCloudflareProtected, navigationTimedOut);

      // Extract content
      const { content, pageTitle } = await extractContentSafely(
        page,
        navigationTimedOut,
        url
      );

      // Validate content
      const finalContent = validateAndFixContent(content);

      // Close browser before callback
      await browser.close();
      browser = null;
      logger.info("Browser closed, memory freed");

      // Send callback
      await sendCallback(callbackUrl, {
        ...callbackData,
        content: finalContent,
        title: pageTitle,
      });

      // Cleanup
      performCleanup();

      return {
        success: true,
        url: url,
        title: pageTitle,
        content: finalContent,
        contentLength: finalContent.length,
        method: "puppeteer",
        timestamp: new Date().toISOString(),
      };
    } catch (puppeteerError) {
      logger.error(
        `[${new Date().toISOString()}] Puppeteer error:`,
        puppeteerError.message
      );

      // Send error callback if not already sent
      if (!callbackSent) {
        await sendCallback(callbackUrl, {
          ...callbackData,
          content: `[Scraping failed: ${puppeteerError.message}]`,
          title: null,
        });
      }

      // Close browser
      if (browser) {
        try {
          await browser.close();
        } catch (error_) {
          logger.error("Failed to close browser:", error_.message);
        }
      }

      scheduleRestartIfNeeded();

      throw puppeteerError;
    } finally {
      // Ensure browser is always closed
      if (browser) {
        try {
          await browser.close();
        } catch (error_) {
          logger.error(
            "Failed to close browser in finally block:",
            error_.message
          );
        }
      }
    }
  });
}

/**
 * Set up network request monitoring for diagnostics
 * @param {Page} page - Puppeteer page
 * @returns {Map} Pending requests map
 */
function setupNetworkMonitoring(page) {
  const pendingRequests = new Map();

  page.on("request", (request) => {
    pendingRequests.set(request.url(), {
      startTime: Date.now(),
      resourceType: request.resourceType(),
    });
  });

  page.on("requestfinished", (request) => {
    pendingRequests.delete(request.url());
  });

  page.on("requestfailed", (request) => {
    pendingRequests.delete(request.url());
  });

  return pendingRequests;
}

/**
 * Navigate to URL with timeout handling
 * @param {Page} page - Puppeteer page
 * @param {string} url - URL to navigate to
 * @param {string} waitStrategy - Wait strategy
 * @param {number} navTimeout - Navigation timeout
 * @param {Map} pendingRequests - Pending requests map
 * @returns {Promise<Object>} Navigation result
 */
async function navigateWithTimeout(
  page,
  url,
  waitStrategy,
  navTimeout,
  pendingRequests
) {
  let navigationTimedOut = false;

  try {
    // codeql[js/request-forgery] SSRF Justification: This is a web scraping service - navigating to arbitrary URLs is the core feature.
    // Comprehensive blacklist validation is applied via isSafePublicUrl(): blocks localhost, private IPs
    // (RFC 1918), link-local addresses, reserved ranges, dangerous protocols.
    // Defense-in-depth: validation at endpoint level + immediate pre-navigation validation.
    await page.goto(url, {
      waitUntil: waitStrategy,
      timeout: navTimeout,
    });
    logger.info(`Navigation completed with ${waitStrategy}`);
  } catch (navError) {
    if (
      navError.message.includes("timeout") ||
      navError.message.includes("Navigation timeout")
    ) {
      logger.info(
        `Navigation timed out after ${
          navTimeout / 1000
        }s, continuing with extraction`
      );
      navigationTimedOut = true;
      logNetworkDiagnostics(pendingRequests);
    } else {
      throw navError;
    }
  }

  return { timedOut: navigationTimedOut };
}

/**
 * Log network diagnostics for timeout debugging
 * @param {Map} pendingRequests - Pending requests map
 */
function logNetworkDiagnostics(pendingRequests) {
  logger.info(`\n=== NETWORK TIMEOUT DIAGNOSTICS ===`);
  logger.info(`Total pending requests: ${pendingRequests.size}`);

  if (pendingRequests.size > 0) {
    // Group by resource type
    const byType = new Map();
    for (const [url, info] of pendingRequests) {
      if (!byType.has(info.resourceType)) {
        byType.set(info.resourceType, []);
      }
      byType.get(info.resourceType).push({
        url,
        duration: Date.now() - info.startTime,
      });
    }

    // Log summary
    logger.info(`\nPending requests by type:`);
    for (const [type, requests] of byType) {
      logger.info(`  ${type}: ${requests.length}`);
    }

    // Log top 10 longest pending requests
    const sortedRequests = Array.from(pendingRequests.entries())
      .map(([url, info]) => ({
        url,
        duration: Date.now() - info.startTime,
        type: info.resourceType,
      }))
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 10);

    logger.info(`\nTop 10 longest pending requests:`);
    sortedRequests.forEach((req, i) => {
      const seconds = (req.duration / 1000).toFixed(1);
      logger.info(
        `  ${i + 1}. [${req.type}] ${seconds}s - ${req.url.substring(0, 100)}${
          req.url.length > 100 ? "..." : ""
        }`
      );
    });
  }
  logger.info(`===================================\n`);
}

/**
 * Wait for page rendering based on site type
 */
async function waitForRendering(isCloudflareProtected, navigationTimedOut) {
  if (isCloudflareProtected) {
    await waitForCloudflareProtected();
  } else if (navigationTimedOut) {
    await waitForNavigationTimeout();
  } else {
    await waitForNormalRendering();
  }
}

async function waitForCloudflareProtected() {
  await new Promise((resolve) => setTimeout(resolve, 20000));
  logger.info("Extended 20-second wait for Cloudflare challenge completion");
}

async function waitForNavigationTimeout() {
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

async function waitForNormalRendering() {
  await new Promise((resolve) => setTimeout(resolve, 3000));
}

/**
 * Extract content safely with timeout protection
 * @param {Page} page - Puppeteer page
 * @param {boolean} navigationTimedOut - Whether navigation timed out
 * @param {string} url - URL being scraped
 * @returns {Promise<Object>} Extracted content and title
 */
async function extractContentSafely(page, navigationTimedOut, url) {
  try {
    const result = await extractPageContent(page, 10000);

    if (navigationTimedOut) {
      logger.info(
        `[${new Date().toISOString()}] Scraped with Puppeteer (partial - timeout): ${url}`
      );
      logger.info(
        `Content length: ${result.content.length} characters (extracted after timeout)`
      );
    } else {
      logger.info(
        `[${new Date().toISOString()}] Successfully scraped with Puppeteer: ${url}`
      );
      logger.info(`Content length: ${result.content.length} characters`);
    }

    logger.debug(`Extracted content: ${result.content}`);
    
    return { content: result.content, pageTitle: result.title };
  } catch (extractError) {
    logger.error(`Content extraction failed: ${extractError.message}`);
    throw extractError;
  }
}

/**
 * Validate and fix content if empty or invalid
 * @param {string} content - Extracted content
 * @returns {string} Final content
 */
function validateAndFixContent(content) {
  if (!content || content.length < 50) {
    logger.warn(
      `⚠️  Empty or invalid content (${
        content ? content.length : 0
      } chars), adding explanation`
    );
    return `[The website could not be scraped - extracted only ${
      content ? content.length : 0
    } characters. The site may require authentication, use anti-bot protection, or be temporarily unavailable.]`;
  }
  return content;
}

/**
 * Perform cleanup after scraping
 */
function performCleanup() {
  forceGarbageCollection();
  const requestCount = getRequestCount();
  trackMemoryUsage(`request_complete_${requestCount}_puppeteer`);
  scheduleRestartIfNeeded();
}

/**
 * Main scraping endpoint handler
 */
async function handleScrapeRequest(req, res) {
  const { url, callbackUrl, jobId, urlIndex, snippet } = req.body;

  // Check shutdown state
  if (getShutdownState()) {
    logger.info(
      `Rejecting /scrape request during shutdown (current memory: ${
        getMemoryUsageMB().rss
      }MB)`
    );
    return res.status(503).json({
      error: "Service restarting due to memory limit",
      retryAfter: 30,
    });
  }

  // Track memory
  const requestCount = incrementRequestCount();
  const memBefore = trackMemoryUsage(`request_start_${requestCount}`);
  logger.info(
    `[${new Date().toISOString()}] Request #${requestCount} - Memory: ${
      memBefore.rss
    }MB RSS`
  );

  // Validate required fields
  if (!url) {
    return res.status(400).json({ error: "URL is required" });
  }
  if (!callbackUrl) {
    return res.status(400).json({ error: "callbackUrl is required" });
  }
  if (!jobId) {
    return res.status(400).json({ error: "jobId is required" });
  }
  if (urlIndex === undefined || urlIndex === null) {
    return res.status(400).json({ error: "urlIndex is required" });
  }

  // SSRF Protection: Validate URLs
  const urlValidation = isSafePublicUrl(url);
  if (!urlValidation.valid) {
    const safeUrlForLog = String(url).replaceAll(/[\r\n]/g, "");
    logger.warn(
      `SSRF protection blocked URL: ${safeUrlForLog} - Reason: ${urlValidation.reason}`
    );
    return res.status(400).json({
      error: "Invalid or unsafe URL",
      reason: urlValidation.reason,
    });
  }

  const callbackValidation = isValidCallbackUrl(callbackUrl);
  if (!callbackValidation.valid) {
    const safeCallbackUrlForLog = String(callbackUrl).replaceAll(/[\r\n]/g, "");
    logger.warn(
      `SSRF protection blocked callback URL: ${safeCallbackUrlForLog} - Reason: ${callbackValidation.reason}`
    );
    return res.status(400).json({
      error: "Invalid or unsafe callback URL",
      reason: callbackValidation.reason,
    });
  }

  // Check memory before starting
  if (shouldRestartDueToMemory()) {
    logger.error(`⚠️  Memory too high (${memBefore.rss}MB), forcing restart`);

    await sendCallback(callbackUrl, {
      jobId,
      urlIndex,
      content: `[Scraping skipped - service restarting due to high memory usage (${memBefore.rss}MB)]`,
      title: null,
      snippet,
      url,
    });

    scheduleRestartIfNeeded();

    return res.status(503).json({
      success: false,
      error: "Service restarting due to high memory",
      memoryMB: memBefore.rss,
    });
  }

  logger.info(`[${new Date().toISOString()}] Scraping URL: ${url}`);
  logger.info(`Callback URL provided: ${callbackUrl}`);

  try {
    // Only use fast-fetch for PDFs and text files (not HTML)
    // HTML pages always use Puppeteer for reliable rendered content extraction
    if (isPDFUrl(url) || isTextFileUrl(url)) {
      logger.info(`Attempting fast fetch for PDF/text file: ${url}...`);
      const fastResult = await tryFastFetch(url);

      if (fastResult) {
        return await handleFastFetchSuccess(
          fastResult,
          url,
          callbackUrl,
          { jobId, urlIndex, snippet },
          res
        );
      }

      // Fast fetch failed for PDF/text file
      return await handlePDFOrTextFileFailed(
        url,
        callbackUrl,
        { jobId, urlIndex, snippet },
        res
      );
    }

    // Use Puppeteer for all HTML pages (more reliable than fast-fetch for SPAs)
    logger.info(`Using Puppeteer for HTML page: ${url}...`);

    // Respond immediately with 202 Accepted - scraping will happen in background
    res.status(202).json({
      success: true,
      status: 'processing',
      message: 'Scraping started, results will be sent via callback'
    });

    // Start scraping in background (don't await - true fire-and-forget)
    // Callback will be sent when scraping completes
    handlePuppeteerScraping(
      url,
      callbackUrl,
      { jobId, urlIndex, snippet, url },
      res
    ).catch(error => {
      // Error already logged and callback already sent in handlePuppeteerScraping
      logger.error('Background Puppeteer scraping failed:', error.message);
    });

    return; // Response already sent
  } catch (error) {
    logger.error(
      `[${new Date().toISOString()}] Scraping error:`,
      error.message
    );

    await sendCallback(callbackUrl, {
      jobId,
      urlIndex,
      content: `[Scraping error: ${error.message}]`,
      title: null,
      snippet,
      url,
    });

    scheduleRestartIfNeeded();

    return res.status(500).json({
      success: false,
      error: error.message,
      url: url,
    });
  }
}

/**
 * Handle successful fast fetch result
 */
async function handleFastFetchSuccess(
  fastResult,
  url,
  callbackUrl,
  callbackData,
  res
) {
  logger.info(`[${new Date().toISOString()}] Fast fetch successful: ${url}`);
  logger.info(`Content length: ${fastResult.length} characters`);

  let finalContent = fastResult;
  if (fastResult.length < 50) {
    logger.warn(
      `⚠️  Empty or invalid content (${fastResult.length} chars), adding explanation`
    );
    finalContent = `[The website could not be scraped - received only ${fastResult.length} characters. The site may be blocking automated access or the page may be empty.]`;
  }

  const result = {
    success: true,
    url: url,
    title: null,
    content: finalContent,
    contentLength: finalContent.length,
    method: "fast_fetch",
    timestamp: new Date().toISOString(),
  };

  await sendCallback(callbackUrl, {
    ...callbackData,
    content: finalContent,
    title: null,
    url,
  });

  forceGarbageCollection();
  const requestCount = getRequestCount();
  trackMemoryUsage(`request_complete_${requestCount}_fast_fetch`);
  scheduleRestartIfNeeded();

  return res.json(result);
}

/**
 * Handle PDF or text file fetch failure
 */
async function handlePDFOrTextFileFailed(url, callbackUrl, callbackData, res) {
  logger.info(
    `[${new Date().toISOString()}] PDF/text file fetch failed, not attempting Puppeteer`
  );

  const errorResult = {
    success: false,
    error: "PDF or text file could not be fetched",
    url: url,
  };

  await sendCallback(callbackUrl, {
    ...callbackData,
    content: "[PDF or text file could not be fetched]",
    title: null,
    url,
  });

  scheduleRestartIfNeeded();

  return res.status(500).json(errorResult);
}

module.exports = {
  handleScrapeRequest,
  enqueuePuppeteerTask,
};
