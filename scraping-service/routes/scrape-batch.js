// Batch scraping endpoint handler
const {
    launchBrowser,
    configureStandardPage,
    setupResourceBlocking,
} = require("../config/puppeteer");
const { isSafePublicUrl } = require("../utils/validation");
const {
    tryFastFetch,
    isPDFUrl,
    isTextFileUrl,
} = require("../utils/extraction");

/**
 * Scrape single URL with Puppeteer
 * @param {Browser} browser - Puppeteer browser instance
 * @param {string} url - URL to scrape
 * @returns {Promise<Object>} Scraping result
 */
async function scrapeSingleUrl(browser, url) {
    const page = await browser.newPage();

    try {
        await configureStandardPage(page);

        // Conditionally enable resource blocking
        const isCloudflareProtected = url.includes("orientalmotor.co.jp");
        if (isCloudflareProtected) {
            console.log(
                "Resource blocking DISABLED for Cloudflare-protected site (Oriental Motor)"
            );
        } else {
            await setupResourceBlocking(page, {
                blockImages: true,
                blockStylesheets: true,
                blockFonts: true,
                blockMedia: true,
                blockTracking: false,
            });
        }

        // SSRF Protection: Validate URL before navigation
        const urlValidation = isSafePublicUrl(url);
        if (!urlValidation.valid) {
            console.error(
                `SSRF protection: Blocked unsafe URL in batch scraping: ${url} - ${urlValidation.reason}`
            );
            throw new Error(
                `Invalid URL for batch scraping: ${urlValidation.reason}`
            );
        }

        // NOSONAR javascript:S5144 - SSRF: Comprehensive blacklist validation applied.
        await page.goto(url, {
            waitUntil: "networkidle2",
            timeout: 120000,
        });

        // Wait for rendering
        const postLoadWait = isCloudflareProtected ? 20000 : 5000;
        await new Promise((resolve) => setTimeout(resolve, postLoadWait));

        if (isCloudflareProtected) {
            console.log(
                "Extended 20-second wait for Cloudflare challenge completion"
            );
        }

        // Extract content
        const content = await page.evaluate(() => {
            const scripts = document.querySelectorAll(
                "script, style, noscript"
            );
            scripts.forEach((script) => script.remove());
            return document.body.innerText;
        });

        const title = await page.title();

        await page.close();

        return {
            success: true,
            url: url,
            title: title,
            content: content,
            contentLength: content.length,
            method: "puppeteer",
        };
    } catch (error) {
        await page.close();
        throw error;
    }
}

/**
 * Batch scraping endpoint handler
 */
async function handleBatchScrapeRequest(req, res) {
    const { urls } = req.body;

    const validationError = validateUrls(urls);
    if (validationError) {
        return res.status(400).json(validationError);
    }

    console.log(`[${new Date().toISOString()}] Batch scraping ${urls.length} URLs`);

    try {
        const results = await processUrls(urls);
        sendSuccessResponse(res, results);
    } catch (error) {
        console.error(`[${new Date().toISOString()}] Batch scraping error:`, error.message);
        sendErrorResponse(res, error);
    }
}

/**
 * Validate URLs array
 */
function validateUrls(urls) {
    if (!urls || !Array.isArray(urls)) {
        return { error: "URLs array is required" };
    }

    for (let i = 0; i < urls.length; i++) {
        const urlValidation = isSafePublicUrl(urls[i]);
        if (!urlValidation.valid) {
            console.warn(
                `SSRF protection blocked URL at index ${i}: ${urls[i]} - Reason: ${urlValidation.reason}`
            );
            return {
                error: `Invalid or unsafe URL at index ${i}`,
                url: urls[i],
                reason: urlValidation.reason,
            };
        }
    }

    return null;
}

/**
 * Process all URLs
 */
async function processUrls(urls) {
    let browser = null;
    const results = [];

    try {
        for (const url of urls) {
            const result = await processSingleUrl(url, browser);
            results.push(result);
            
            // Update browser reference if it was created
            if (result.browserCreated && !browser) {
                browser = result.browser;
            }
        }
    } finally {
        if (browser) {
            await browser.close();
        }
    }

    return results;
}

/**
 * Process a single URL with appropriate method
 */
async function processSingleUrl(url, browser) {
    try {
        const fastFetchResult = await tryFastFetchWithFallback(url);
        if (fastFetchResult.success) {
            return fastFetchResult;
        }

        // If PDF/text file failed, don't use Puppeteer
        if (shouldSkipPuppeteer(url)) {
            return createFailureResult(url, "PDF or text file could not be fetched", "fast_fetch_failed");
        }

        return await processWithPuppeteer(url, browser);
    } catch (error) {
        console.error(`Error scraping ${url}:`, error.message);
        return createFailureResult(url, error.message);
    }
}

/**
 * Try fast fetch and handle result
 */
async function tryFastFetchWithFallback(url) {
    console.log(`Attempting fast fetch for ${url}...`);
    const fastResult = await tryFastFetch(url);

    if (fastResult) {
        console.log(`Fast fetch successful for ${url} (${fastResult.length} chars)`);
        return createFastFetchSuccessResult(url, fastResult);
    }

    return { success: false };
}

/**
 * Check if URL should skip Puppeteer processing
 */
function shouldSkipPuppeteer(url) {
    return isPDFUrl(url) || isTextFileUrl(url);
}

/**
 * Process URL using Puppeteer
 */
async function processWithPuppeteer(url, existingBrowser) {
    console.log(`Using Puppeteer for ${url}...`);
    
    const browser = existingBrowser || await launchBrowser();
    const content = await scrapeSingleUrl(browser, url);
    
    console.log(`Scraped ${url} with Puppeteer (${content.length} chars)`);
    
    return {
        success: true,
        url,
        title: null,
        content,
        contentLength: content.length,
        method: "puppeteer",
        browser: existingBrowser ? undefined : browser,
        browserCreated: !existingBrowser
    };
}

/**
 * Create success result for fast fetch
 */
function createFastFetchSuccessResult(url, content) {
    return {
        success: true,
        url,
        title: null,
        content,
        contentLength: content.length,
        method: "fast_fetch"
    };
}

/**
 * Create failure result
 */
function createFailureResult(url, error, method = null) {
    const result = {
        success: false,
        url,
        error
    };
    
    if (method) {
        result.method = method;
    }
    
    return result;
}

/**
 * Send successful response
 */
function sendSuccessResponse(res, results) {
    res.json({
        success: true,
        results,
        timestamp: new Date().toISOString()
    });
}

/**
 * Send error response
 */
function sendErrorResponse(res, error) {
    res.status(500).json({
        success: false,
        error: error.message
    });
}

module.exports = {
    handleBatchScrapeRequest,
};
