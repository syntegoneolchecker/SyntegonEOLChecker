// Omron dual-page scraping endpoint handler
const {
    launchBrowserWithProxy,
    configureStandardPage,
    setupResourceBlocking
} = require('../config/puppeteer');
const {
    trackMemoryUsage,
    scheduleRestartIfNeeded,
    getShutdownState,
    incrementRequestCount,
    forceGarbageCollection,
    getMemoryUsageMB
} = require('../utils/memory');
const {
    isSafePublicUrl,
    isValidCallbackUrl,
    isValidProxyUrl,
    parseProxyUrl
} = require('../utils/validation');
const { sendCallback } = require('../utils/callback');
const { enqueuePuppeteerTask } = require('./scrape');
const logger = require('./../utils/logger');

/**
 * Check if content contains Omron "page not found" message
 * @param {string} content - Page content to check
 * @returns {boolean} True if error message detected
 */
function isOmronPageNotFound(content) {
    if (!content) return false;
    const errorMessage = '大変申し訳ございませんお探しのページが見つかりませんでした';
    return content.includes(errorMessage);
}

/**
 * Scrape Omron page with proxy
 * @param {string} url - Page URL to scrape
 * @param {string} proxyUrl - Proxy URL
 * @param {string} pageName - Page name for logging (Primary/Fallback)
 * @returns {Promise<Object>} Scraping result
 */
async function scrapeOmronPage(url, proxyUrl, pageName) {
    logger.info(`\n${'='.repeat(60)}`);
    logger.info(`Scraping ${pageName} page: ${url}`);
    logger.info(`${'='.repeat(60)}\n`);

    const proxyConfig = parseProxyUrl(proxyUrl);
    if (!proxyConfig) {
        logger.error(`Failed to parse proxy URL for ${pageName}`);
        return { success: false, error: `Failed to parse proxy URL for ${pageName}` };
    }

    logger.info(`Proxy config: server=${proxyConfig.server}, hasAuth=${!!(proxyConfig.username && proxyConfig.password)}`);

    let browser = null;
    try {
        // Launch browser with proxy
        logger.info(`Launching browser with Japanese proxy...`);
        browser = await launchBrowserWithProxy(proxyConfig.server);
        logger.info(`Browser launched successfully with proxy`);

        const page = await browser.newPage();

        await configureStandardPage(page, {
            proxyUsername: proxyConfig.username,
            proxyPassword: proxyConfig.password
        });

        // Enable resource blocking to save memory
        await setupResourceBlocking(page, {
            blockImages: true,
            blockStylesheets: true,
            blockFonts: true,
            blockMedia: true,
            blockTracking: false
        });

        // SSRF Protection: Validate URL before navigation
        const urlValidation = isSafePublicUrl(url);
        if (!urlValidation.valid) {
            logger.error(`SSRF protection: Blocked unsafe URL for Omron ${pageName}: ${url} - ${urlValidation.reason}`);
            throw new Error(`Invalid URL for Omron scraping: ${urlValidation.reason}`);
        }

        // Navigate to Omron page
        logger.info(`Navigating to ${pageName} page: ${url}`);
        // codeql[js/request-forgery] SSRF Justification: URLs validated with comprehensive blacklist via isSafePublicUrl().
        await page.goto(url, {
            waitUntil: 'networkidle2',
            timeout: 60000
        });
        logger.info(`Navigation completed for ${pageName} page`);

        // Wait for content to render
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Extract full HTML content
        const htmlContent = await page.content();

        // Also extract text content for analysis
        const textContent = await page.evaluate(() => {
            const scripts = document.querySelectorAll('script, style, noscript');
            scripts.forEach(script => script.remove());
            return document.body.innerText;
        });

        const pageTitle = await page.title();

        logger.info(`✓ ${pageName} page scraped: ${htmlContent.length} characters (HTML), ${textContent.length} characters (text)`);

        // Close browser
        await browser.close();
        browser = null;

        return {
            success: true,
            htmlContent: htmlContent,
            textContent: textContent,
            title: pageTitle,
            url: url
        };

    } catch (error) {
        logger.error(`Error scraping ${pageName} page: ${error.message}`);
        if (browser) {
            try {
                await browser.close();
            } catch (error_) {
                logger.error(`Failed to close browser for ${pageName} page: ${error_.message}`);
            }
        }
        return { success: false, error: error.message };
    }
}

/**
 * Omron dual-page scraping endpoint handler
 */
async function handleOmronDualScrapeRequest(req, res) {
    const { primaryUrl, fallbackUrl, callbackUrl, jobId, urlIndex, jpProxyUrl, title, snippet } = req.body;

    // Check shutdown state
    if (getShutdownState()) {
        logger.info(`Rejecting /scrape-omron-dual request during shutdown (current memory: ${getMemoryUsageMB().rss}MB)`);
        return res.status(503).json({
            error: 'Service restarting due to memory limit',
            retryAfter: 30
        });
    }

    // Track memory
    const requestCount = incrementRequestCount();
    const memBefore = trackMemoryUsage(`omron_dual_start_${requestCount}`);
    logger.info(`[${new Date().toISOString()}] Omron Dual-Page Request #${requestCount} - Memory: ${memBefore.rss}MB RSS`);

    // Validate required fields
    if (!primaryUrl || !fallbackUrl || !jpProxyUrl) {
        return res.status(400).json({ error: 'primaryUrl, fallbackUrl, and jpProxyUrl are required' });
    }

    // SSRF Protection: Validate all URLs
    const validations = {
        primaryUrl: isSafePublicUrl(primaryUrl),
        fallbackUrl: isSafePublicUrl(fallbackUrl),
        jpProxy: isValidProxyUrl(jpProxyUrl),
        callback: isValidCallbackUrl(callbackUrl)
    };

    for (const [name, validation] of Object.entries(validations)) {
        if (!validation.valid) {
            logger.warn(`SSRF protection blocked ${name}: ${validation.reason}`);
            return res.status(400).json({
                error: `Invalid or unsafe ${name}`,
                reason: validation.reason
            });
        }
    }

    logger.info(`[${new Date().toISOString()}] Omron Dual-Page: Primary URL: ${primaryUrl}`);
    logger.info(`[${new Date().toISOString()}] Omron Dual-Page: Fallback URL: ${fallbackUrl}`);
    if (callbackUrl) {
        logger.info(`Callback URL provided: ${callbackUrl}`);
    }

    // Respond immediately with 202 Accepted (fire-and-forget)
    res.status(202).json({
        success: true,
        status: 'processing',
        message: 'Omron dual-page scraping started, results will be sent via callback'
    });

    // Enqueue task in background (don't await - true fire-and-forget)
    enqueuePuppeteerTask(async () => {
        let callbackSent = false;

        try {
            // Try primary URL first
            logger.info(`Step 1: Scraping primary URL...`);
            const primaryResult = await scrapeOmronPage(primaryUrl, jpProxyUrl, 'Primary');

            if (!primaryResult.success) {
                logger.error(`Primary URL scraping failed: ${primaryResult.error}`);

                // Send error callback
                await sendCallback(callbackUrl, {
                    jobId,
                    urlIndex,
                    content: `[Omron primary URL scraping failed: ${primaryResult.error}]`,
                    title: title || null,
                    snippet: snippet || '',
                    url: primaryUrl
                });

                forceGarbageCollection();
                trackMemoryUsage(`omron_dual_complete_${requestCount}_primary_error`);
                scheduleRestartIfNeeded();
                return;
            }

            // Check if primary page contains error message
            const hasError = isOmronPageNotFound(primaryResult.htmlContent);

            if (!hasError) {
                // Primary page is successful
                logger.info(`✓ Primary URL successful (no error message detected), sending callback`);
                await sendCallback(callbackUrl, {
                    jobId,
                    urlIndex,
                    content: primaryResult.textContent,
                    title: primaryResult.title,
                    snippet: snippet || 'Omron product page',
                    url: primaryResult.url
                });

                forceGarbageCollection();
                trackMemoryUsage(`omron_dual_complete_${requestCount}_primary_success`);
                scheduleRestartIfNeeded();
                return;
            }

            // Primary page contains error message - try fallback URL
            logger.info(`Primary URL contains error message, trying fallback URL...`);
            const fallbackResult = await scrapeOmronPage(fallbackUrl, jpProxyUrl, 'Fallback');

            if (!fallbackResult.success) {
                logger.error(`Fallback URL scraping failed: ${fallbackResult.error}`);

                // Send error callback
                await sendCallback(callbackUrl, {
                    jobId,
                    urlIndex,
                    content: `[Omron: Both primary and fallback URLs failed. Primary had error message, fallback failed to scrape: ${fallbackResult.error}]`,
                    title: title || null,
                    snippet: snippet || '',
                    url: fallbackUrl
                });

                forceGarbageCollection();
                trackMemoryUsage(`omron_dual_complete_${requestCount}_both_failed`);
                scheduleRestartIfNeeded();
                return;
            }

            // Check if fallback page has meaningful content
            const hasNoContent = fallbackResult.textContent.length < 500;

            if (hasNoContent) {
                logger.info(`Fallback URL has no meaningful content, sending placeholder`);
                await sendCallback(callbackUrl, {
                    jobId,
                    urlIndex,
                    content: '[Omron: No results found on both primary and fallback URLs]',
                    title: 'Omron - No Results',
                    snippet: snippet || '',
                    url: fallbackUrl
                });
            } else {
                logger.info(`✓ Fallback URL successful, sending callback`);
                await sendCallback(callbackUrl, {
                    jobId,
                    urlIndex,
                    content: fallbackResult.textContent,
                    title: fallbackResult.title,
                    snippet: snippet || 'Omron closed products search',
                    url: fallbackResult.url
                });
            }
            callbackSent = true;

            forceGarbageCollection();
            trackMemoryUsage(`omron_dual_complete_${requestCount}_fallback_success`);
            scheduleRestartIfNeeded();

        } catch (error) {
            logger.error(`Omron dual-page scraping error:`, error);

            if (!callbackSent && callbackUrl) {
                await sendCallback(callbackUrl, {
                    jobId,
                    urlIndex,
                    content: `[Omron dual-page scraping failed: ${error.message}]`,
                    title: title || null,
                    snippet: snippet || '',
                    url: primaryUrl
                });
            }

            forceGarbageCollection();
            trackMemoryUsage(`omron_dual_complete_${requestCount}_error`);
            scheduleRestartIfNeeded();
        }
    }).catch(error => {
        logger.error('Background Omron dual-page scraping failed:', error.message);
    });

    // Response already sent above (202 Accepted)
}

module.exports = {
    handleOmronDualScrapeRequest
};
