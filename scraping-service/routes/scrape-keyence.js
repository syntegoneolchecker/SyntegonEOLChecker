// KEYENCE-specific scraping endpoint handler
const {
    launchBrowser,
    configureStandardPage,
    setupResourceBlocking
} = require('../config/puppeteer');
const {
    getMemoryUsageMB,
    trackMemoryUsage,
    scheduleRestartIfNeeded,
    getShutdownState,
    incrementRequestCount,
    forceGarbageCollection,
    setShutdownState
} = require('../utils/memory');
const { isValidCallbackUrl } = require('../utils/validation');
const { sendCallback } = require('../utils/callback');
const { enqueuePuppeteerTask } = require('./scrape');
const logger = require('./../utils/logger');

/**
 * Perform KEYENCE search and extract content
 * @param {Page} page - Puppeteer page
 * @param {string} model - Model number to search
 * @returns {Promise<String>} Search result
 */
async function performKeyenceSearch(page, model) {
    logger.info('Navigating to KEYENCE homepage...');
    // codeql[js/request-forgery] SSRF Justification: Hardcoded URL to KEYENCE official website (trusted source).
    await page.goto('https://www.keyence.co.jp/', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
    });

    logger.info('KEYENCE homepage loaded, waiting for search elements to render...');
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Verify search elements exist
    const hasSearchElements = await page.evaluate(() => {
        const searchInput = document.querySelector('.m-form-search__input');
        const searchButton = document.querySelector('.m-form-search__button');
        return !!(searchInput && searchButton);
    });

    if (!hasSearchElements) {
        throw new Error('Search input or button not found on KEYENCE homepage');
    }

    // Enter search query
    const inputSelector = '.m-form-search__input';
    logger.info(`Setting search input value to "${model}" and pressing Enter...`);

    await page.evaluate((selector, value) => {
        const input = document.querySelector(selector);
        if (input) {
            input.value = value;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }, inputSelector, model);

    await page.click(inputSelector);

    // Submit search and wait for navigation
    try {
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }),
            page.keyboard.press('Enter')
        ]);
        logger.info('Navigation completed successfully');
    } catch (navError) {
        logger.info(`Navigation timeout (${navError.message}), checking if page loaded...`);
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    return page.url();
}

/**
 * Extract text content from KEYENCE page
 * @param {Page} page - Puppeteer page
 * @returns {Promise<Object>} Extracted text and title
 */
async function extractKeyenceContent(page) {
    logger.info('Extracting text content (in-browser method)...');

    const extractionPromise = page.evaluate(() => {
        try {
            // Remove scripts, styles, and noscript elements
            const scripts = document.querySelectorAll('script, style, noscript');
            scripts.forEach(el => el.remove());

            // Extract text directly from DOM (no HTML string transfer)
            const bodyText = document.body.innerText || document.body.textContent || '';
            const pageTitle = document.title || '';

            return { text: bodyText, title: pageTitle };
        } catch (e) {
            return { text: '', title: '', error: e.message };
        }
    });

    const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Content extraction timeout (10s)')), 10000)
    );

    const result = await Promise.race([extractionPromise, timeoutPromise]);

    if (result.error) {
        logger.error(`Browser evaluation error: ${result.error}`);
    }

    logger.info(`✓ Extracted ${result.text.length} characters from KEYENCE page (memory-efficient method)`);

    return { text: result.text || '', title: result.title || '' };
}

/**
 * Validate and fix KEYENCE content
 * @param {string} text - Extracted text
 * @returns {string} Final content
 */
function validateKeyenceContent(text) {
    if (!text || text.length < 50) {
        logger.warn(`⚠️  Empty or invalid KEYENCE content (${text ? text.length : 0} chars), adding explanation`);
        return `[KEYENCE search extracted only ${text ? text.length : 0} characters. The search may have returned no results, the page may be unavailable, or the site may be blocking automated access.]`;
    }
    return text;
}

/**
 * KEYENCE-specific scraping endpoint handler
 */
async function handleKeyenceScrapeRequest(req, res) {
    const { model, callbackUrl, jobId, urlIndex } = req.body;

    // Check shutdown state
    if (getShutdownState()) {
        logger.info(`Rejecting /scrape-keyence request during shutdown (current memory: ${getMemoryUsageMB().rss}MB)`);
        return res.status(503).json({
            error: 'Service restarting due to memory limit',
            retryAfter: 30
        });
    }

    // Track memory
    const requestCount = incrementRequestCount();
    const memBefore = trackMemoryUsage(`keyence_start_${requestCount}`);
    logger.info(`[${new Date().toISOString()}] KEYENCE Search Request #${requestCount} - Memory: ${memBefore.rss}MB RSS`);

    // Validate required fields
    if (!model) {
        return res.status(400).json({ error: 'Model is required' });
    }

    // SSRF Protection: Validate callback URL
    const callbackValidation = isValidCallbackUrl(callbackUrl);
    if (!callbackValidation.valid) {
        logger.warn(`SSRF protection blocked callback URL: ${callbackUrl} - Reason: ${callbackValidation.reason}`);
        return res.status(400).json({
            error: 'Invalid or unsafe callback URL',
            reason: callbackValidation.reason
        });
    }

    logger.info(`[${new Date().toISOString()}] KEYENCE: Searching for model: ${model}`);
    if (callbackUrl) {
        logger.info(`Callback URL provided: ${callbackUrl}`);
    }

    // Respond immediately with 202 Accepted (fire-and-forget)
    res.status(202).json({
        success: true,
        status: 'processing',
        message: 'KEYENCE search started, results will be sent via callback'
    });

    // Enqueue task in background (don't await - true fire-and-forget)
    enqueuePuppeteerTask(async () => {
        let browser = null;
        const callbackSent = false;

        try {
            browser = await launchBrowser();
            const page = await browser.newPage();

            await configureStandardPage(page);

            // Enable resource blocking (allow CSS/JS for KEYENCE functionality)
            await setupResourceBlocking(page, {
                blockImages: true,
                blockStylesheets: false, // Allow CSS for KEYENCE
                blockFonts: true,
                blockMedia: true,
                blockTracking: true
            });

            // Perform search
            const finalUrl = await performKeyenceSearch(page, model);
            logger.info(`Final page URL: ${String(finalUrl)}`);

            // Extract content
            const { text, title } = await extractKeyenceContent(page);

            // Validate content
            const finalContent = validateKeyenceContent(text);

            // Close browser before callback
            await browser.close();
            browser = null;
            logger.info('Browser closed, memory freed');

            // Send callback
            if (callbackUrl) {
                await sendCallback(callbackUrl, {
                    jobId,
                    urlIndex,
                    content: finalContent,
                    title: title,
                    snippet: `KEYENCE search result for ${model}`,
                    url: finalUrl
                });
            }

            // Cleanup
            forceGarbageCollection();
            trackMemoryUsage(`keyence_complete_${requestCount}`);
            scheduleRestartIfNeeded();

            // Response already sent (202), no need to return result

        } catch (error) {
            logger.error(`KEYENCE scraping error:`, error);

            // Close browser
            if (browser) {
                try {
                    await browser.close();
                    logger.info('Browser closed after error, memory freed');
                } catch (closeError) {
                    logger.error('Error closing browser after KEYENCE scraping error:', closeError);
                }
            }

            // Send error callback
            if (callbackUrl && !callbackSent) {
                await sendCallback(callbackUrl, {
                    jobId,
                    urlIndex,
                    content: `[KEYENCE search failed: ${error.message}]`,
                    title: null,
                    snippet: '',
                    url: 'https://www.keyence.co.jp/'
                });
            }

            // Force restart after KEYENCE check
            logger.info('KEYENCE check failed - forcing restart to free memory');
            setShutdownState(true);
            scheduleRestartIfNeeded();

            // Response already sent (202), error callback already sent
        } finally {
            // Ensure browser is always closed
            if (browser) {
                try {
                    await browser.close();
                } catch (error_) {
                    logger.error('Failed to close browser in finally block:', error_.message);
                }
            }
        }
    }).catch(error => {
        // Error already logged and callback already sent
        logger.error('Background KEYENCE scraping failed:', error.message);
    });

    // Response already sent above (202 Accepted)
}

module.exports = {
    handleKeyenceScrapeRequest
};
