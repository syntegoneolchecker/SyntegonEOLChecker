// Batch scraping endpoint handler
const {
    launchBrowser,
    configureStandardPage,
    setupResourceBlocking
} = require('../config/puppeteer');
const { isSafePublicUrl } = require('../utils/validation');
const { tryFastFetch, isPDFUrl, isTextFileUrl } = require('../utils/extraction');

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
        const isCloudflareProtected = url.includes('orientalmotor.co.jp');
        if (isCloudflareProtected) {
            console.log('Resource blocking DISABLED for Cloudflare-protected site (Oriental Motor)');
        } else {
            await setupResourceBlocking(page, {
                blockImages: true,
                blockStylesheets: true,
                blockFonts: true,
                blockMedia: true,
                blockTracking: false
            });
        }

        // SSRF Protection: Validate URL before navigation
        const urlValidation = isSafePublicUrl(url);
        if (!urlValidation.valid) {
            console.error(`SSRF protection: Blocked unsafe URL in batch scraping: ${url} - ${urlValidation.reason}`);
            throw new Error(`Invalid URL for batch scraping: ${urlValidation.reason}`);
        }

        // NOSONAR javascript:S5144 - SSRF: Comprehensive blacklist validation applied.
        await page.goto(url, {
            waitUntil: 'networkidle2',
            timeout: 120000
        });

        // Wait for rendering
        const postLoadWait = isCloudflareProtected ? 20000 : 5000;
        await new Promise(resolve => setTimeout(resolve, postLoadWait));

        if (isCloudflareProtected) {
            console.log('Extended 20-second wait for Cloudflare challenge completion');
        }

        // Extract content
        const content = await page.evaluate(() => {
            const scripts = document.querySelectorAll('script, style, noscript');
            scripts.forEach(script => script.remove());
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
            method: 'puppeteer'
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

    // Validate input
    if (!urls || !Array.isArray(urls)) {
        return res.status(400).json({ error: 'URLs array is required' });
    }

    // SSRF Protection: Validate all URLs before processing
    for (let i = 0; i < urls.length; i++) {
        const urlValidation = isSafePublicUrl(urls[i]);
        if (!urlValidation.valid) {
            console.warn(`SSRF protection blocked URL at index ${i}: ${urls[i]} - Reason: ${urlValidation.reason}`);
            return res.status(400).json({
                error: `Invalid or unsafe URL at index ${i}`,
                url: urls[i],
                reason: urlValidation.reason
            });
        }
    }

    console.log(`[${new Date().toISOString()}] Batch scraping ${urls.length} URLs`);

    let browser = null;
    const results = [];

    try {
        // Process URLs sequentially
        for (const url of urls) {
            try {
                // Try fast fetch first
                console.log(`Attempting fast fetch for ${url}...`);
                const fastResult = await tryFastFetch(url);

                if (fastResult) {
                    console.log(`Fast fetch successful for ${url} (${fastResult.length} chars)`);
                    results.push({
                        success: true,
                        url: url,
                        title: null,
                        content: fastResult,
                        contentLength: fastResult.length,
                        method: 'fast_fetch'
                    });
                    continue;
                }

                // Check if PDF/text file - skip Puppeteer
                if (isPDFUrl(url) || isTextFileUrl(url)) {
                    console.log(`PDF/text file fetch failed for ${url}, skipping Puppeteer`);
                    results.push({
                        success: false,
                        url: url,
                        error: 'PDF or text file could not be fetched',
                        method: 'fast_fetch_failed'
                    });
                    continue;
                }

                // Use Puppeteer for HTML
                console.log(`Using Puppeteer for ${url}...`);

                // Launch browser if not already running
                if (!browser) {
                    browser = await launchBrowser();
                }

                const result = await scrapeSingleUrl(browser, url);
                results.push(result);

                console.log(`[${new Date().toISOString()}] Scraped ${url} with Puppeteer (${result.content.length} chars)`);

            } catch (error) {
                console.error(`[${new Date().toISOString()}] Error scraping ${url}:`, error.message);
                results.push({
                    success: false,
                    url: url,
                    error: error.message
                });
            }
        }

        // Close browser if it was launched
        if (browser) {
            await browser.close();
        }

        res.json({
            success: true,
            results: results,
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error(`[${new Date().toISOString()}] Batch scraping error:`, error.message);

        if (browser) {
            await browser.close();
        }

        res.status(500).json({
            success: false,
            error: error.message,
            results: results
        });
    }
}

module.exports = {
    handleBatchScrapeRequest
};
