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

/**
 * Perform KEYENCE search and extract content
 * @param {Page} page - Puppeteer page
 * @param {string} model - Model number to search
 * @returns {Promise<String>} Search result
 */
async function performKeyenceSearch(page, model) {
    console.log('Navigating to KEYENCE homepage...');
    await page.goto('https://www.keyence.co.jp/', {
        waitUntil: 'domcontentloaded',
        timeout: 30000
    });

    console.log('KEYENCE homepage loaded, waiting for search elements to render...');
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
    console.log(`Setting search input value to "${model}" and pressing Enter...`);

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
        console.log('Navigation completed successfully');
    } catch (navError) {
        console.log(`Navigation timeout (${navError.message}), checking if page loaded...`);
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
    console.log('Extracting text content (in-browser method)...');

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
        console.error(`Browser evaluation error: ${result.error}`);
    }

    console.log(`✓ Extracted ${result.text.length} characters from KEYENCE page (memory-efficient method)`);

    return { text: result.text || '', title: result.title || '' };
}

/**
 * Validate and fix KEYENCE content
 * @param {string} text - Extracted text
 * @returns {string} Final content
 */
function validateKeyenceContent(text) {
    if (!text || text.length < 50) {
        console.warn(`⚠️  Empty or invalid KEYENCE content (${text ? text.length : 0} chars), adding explanation`);
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
        console.log(`Rejecting /scrape-keyence request during shutdown (current memory: ${getMemoryUsageMB().rss}MB)`);
        return res.status(503).json({
            error: 'Service restarting due to memory limit',
            retryAfter: 30
        });
    }

    // Track memory
    const requestCount = incrementRequestCount();
    const memBefore = trackMemoryUsage(`keyence_start_${requestCount}`);
    console.log(`[${new Date().toISOString()}] KEYENCE Search Request #${requestCount} - Memory: ${memBefore.rss}MB RSS`);

    // Validate required fields
    if (!model) {
        return res.status(400).json({ error: 'Model is required' });
    }

    // SSRF Protection: Validate callback URL
    const callbackValidation = isValidCallbackUrl(callbackUrl);
    if (!callbackValidation.valid) {
        console.warn(`SSRF protection blocked callback URL: ${callbackUrl} - Reason: ${callbackValidation.reason}`);
        return res.status(400).json({
            error: 'Invalid or unsafe callback URL',
            reason: callbackValidation.reason
        });
    }

    console.log(`[${new Date().toISOString()}] KEYENCE: Searching for model: ${model}`);
    if (callbackUrl) {
        console.log(`Callback URL provided: ${callbackUrl}`);
    }

    // Enqueue task
    return enqueuePuppeteerTask(async () => {
        let browser = null;
        let callbackSent = false;

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
            console.log(`Final page URL: ${String(finalUrl)}`);

            // Extract content
            const { text, title } = await extractKeyenceContent(page);

            // Validate content
            const finalContent = validateKeyenceContent(text);

            const keyenceResult = {
                success: true,
                url: finalUrl,
                originalSearch: model,
                title: title,
                content: finalContent,
                contentLength: finalContent.length,
                method: 'keyence_interactive_search',
                timestamp: new Date().toISOString()
            };

            // Close browser before callback
            await browser.close();
            browser = null;
            console.log('Browser closed, memory freed');

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

            return res.json(keyenceResult);

        } catch (error) {
            console.error(`KEYENCE scraping error:`, error);

            // Close browser
            if (browser) {
                try {
                    await browser.close();
                    console.log('Browser closed after error, memory freed');
                } catch (closeError) {
                    console.error('Error closing browser after KEYENCE scraping error:', closeError);
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
            console.log('KEYENCE check failed - forcing restart to free memory');
            setShutdownState(true);
            scheduleRestartIfNeeded();

            return res.status(500).json({
                success: false,
                error: error.message,
                model: model
            });
        } finally {
            // Ensure browser is always closed
            if (browser) {
                try {
                    await browser.close();
                } catch (error_) {
                    console.error('Failed to close browser in finally block:', error_.message);
                }
            }
        }
    });
}

module.exports = {
    handleKeyenceScrapeRequest
};
