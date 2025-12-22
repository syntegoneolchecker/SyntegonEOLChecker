// IDEC dual-site scraping endpoint handler
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

/**
 * Extract IDEC product URL from search results
 * @param {Page} page - Puppeteer page
 * @param {string} model - Model number
 * @returns {Promise<Object>} Extraction result
 */
async function extractIdecProductUrl(page, model) {
    try {
        await page.waitForSelector('.listing__elements', { timeout: 5000, visible: true });
        console.log('IDEC search results loaded, extracting product URLs...');

        const result = await page.evaluate((searchModel) => {
            try {
                const expectedSuffix = '/p/' + searchModel;
                const listingDiv = document.querySelector('.listing__elements');

                if (!listingDiv) {
                    return { url: null, error: 'listing__elements not found' };
                }

                const itemBoxes = listingDiv.querySelectorAll('.item-box.row.no-gutters.bumper');

                for (const itemBox of itemBoxes) {
                    const imageDiv = itemBox.querySelector('.item-box__image');
                    if (!imageDiv) continue;

                    const link = imageDiv.querySelector('a');
                    if (!link) continue;

                    const href = link.getAttribute('href');
                    if (!href) continue;

                    if (href.endsWith(expectedSuffix)) {
                        return { url: href, error: null };
                    }
                }

                return { url: null, error: 'No exact match found for model: ' + searchModel };
            } catch (e) {
                return { url: null, error: e?.message ?? String(e) };
            }
        }, model);

        return result;
    } catch (error) {
        console.error(`Failed to extract IDEC product URL: ${error.message}`);
        return { url: null, error: error.message };
    }
}

/**
 * Scrape IDEC product page
 * @param {Page} page - Puppeteer page
 * @param {string} productUrl - Product page URL
 * @returns {Promise<Object>} Scraped content
 */
async function scrapeIdecProductPage(page, productUrl) {
    // SSRF Protection: Validate product URL
    const productUrlValidation = isSafePublicUrl(productUrl);
    if (!productUrlValidation.valid) {
        console.error(`SSRF protection: Blocked unsafe product URL from IDEC: ${productUrl} - ${productUrlValidation.reason}`);
        throw new Error(`Invalid product URL from IDEC: ${productUrlValidation.reason}`);
    }

    // Navigate to product page
    // codeql[js/request-forgery] SSRF Justification: URLs validated with comprehensive blacklist via isSafePublicUrl().
    // Even though productUrl comes from IDEC's website, we validate for defense-in-depth.
    await page.goto(productUrl, {
        waitUntil: 'networkidle2',
        timeout: 45000
    });

    // Wait for content to render
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Extract content
    const content = await page.evaluate(() => {
        const scripts = document.querySelectorAll('script, style, noscript');
        scripts.forEach(script => script.remove());
        return document.body.innerText;
    });

    const pageTitle = await page.title();

    console.log(`✓ Product page scraped: ${content.length} characters`);

    return { content, title: pageTitle };
}

/**
 * Scrape a single IDEC site (JP or US)
 * @param {string} siteUrl - Search page URL
 * @param {string} proxyUrl - Proxy URL
 * @param {string} siteName - Site name (JP/US)
 * @param {string} model - Model number
 * @returns {Promise<Object>} Scraping result
 */
async function scrapeIdecSite(siteUrl, proxyUrl, siteName, model) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Trying ${siteName} site: ${siteUrl}`);
    console.log(`${'='.repeat(60)}\n`);

    const proxyConfig = parseProxyUrl(proxyUrl);
    if (!proxyConfig) {
        console.error(`Failed to parse ${siteName} proxy URL`);
        return { success: false, error: `Failed to parse ${siteName} proxy URL` };
    }

    console.log(`${siteName} proxy config: server=${proxyConfig.server}, hasAuth=${!!(proxyConfig.username && proxyConfig.password)}`);

    let browser = null;
    try {
        // Launch browser with proxy
        console.log(`Launching browser with ${siteName} proxy...`);
        browser = await launchBrowserWithProxy(proxyConfig.server);
        console.log(`Browser launched successfully with ${siteName} proxy`);

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
        const siteUrlValidation = isSafePublicUrl(siteUrl);
        if (!siteUrlValidation.valid) {
            console.error(`SSRF protection: Blocked unsafe site URL for IDEC: ${siteUrl} - ${siteUrlValidation.reason}`);
            throw new Error(`Invalid site URL for IDEC scraping: ${siteUrlValidation.reason}`);
        }

        // Navigate to IDEC search page
        console.log(`Navigating to ${siteName} search page: ${siteUrl}`);
        // codeql[js/request-forgery] SSRF Justification: URLs validated with comprehensive blacklist via isSafePublicUrl().
        await page.goto(siteUrl, {
            waitUntil: 'networkidle2',
            timeout: 60000
        });
        console.log(`Navigation completed for ${siteName} site`);

        // Extract product URL
        const extractionResult = await extractIdecProductUrl(page, model);

        if (!extractionResult.url) {
            console.log(`No exact match found on ${siteName} site: ${extractionResult.error}`);
            await browser.close();
            return { success: false, error: `No match on ${siteName} site` };
        }

        // Build full product URL
        const baseUrl = siteName === 'JP' ? 'jp' : 'us';
        const productUrl = extractionResult.url.startsWith('http')
            ? extractionResult.url
            : `https://${baseUrl}.idec.com${extractionResult.url}`;

        console.log(`✓ Found exact match on ${siteName} site: ${productUrl}`);

        // Close search browser
        await browser.close();
        browser = null;

        // Scrape product page with new browser instance
        console.log(`Scraping product page: ${productUrl}`);
        browser = await launchBrowserWithProxy(proxyConfig.server);

        const productPage = await browser.newPage();

        await configureStandardPage(productPage, {
            proxyUsername: proxyConfig.username,
            proxyPassword: proxyConfig.password
        });

        await setupResourceBlocking(productPage, {
            blockImages: true,
            blockStylesheets: true,
            blockFonts: true,
            blockMedia: true,
            blockTracking: false
        });

        // Scrape product page
        const { content, title } = await scrapeIdecProductPage(productPage, productUrl);

        // Close browser
        await browser.close();
        browser = null;

        return {
            success: true,
            content: content,
            title: title,
            url: productUrl,
            site: siteName
        };

    } catch (error) {
        console.error(`Error scraping ${siteName} site: ${error.message}`);
        if (browser) {
            try {
                await browser.close();
            } catch (error_) {
                console.error(`Failed to close browser for ${siteName} site: ${error_.message}`);
            }
        }
        return { success: false, error: error.message };
    }
}

/**
 * IDEC dual-site scraping endpoint handler
 */
async function handleIdecDualScrapeRequest(req, res) {
    const { model, callbackUrl, jobId, urlIndex, jpProxyUrl, usProxyUrl, jpUrl, usUrl } = req.body;

    // Check shutdown state
    if (getShutdownState()) {
        console.log(`Rejecting /scrape-idec-dual request during shutdown (current memory: ${getMemoryUsageMB().rss}MB)`);
        return res.status(503).json({
            error: 'Service restarting due to memory limit',
            retryAfter: 30
        });
    }

    // Track memory
    const requestCount = incrementRequestCount();
    const memBefore = trackMemoryUsage(`idec_dual_start_${requestCount}`);
    console.log(`[${new Date().toISOString()}] IDEC Dual-Site Request #${requestCount} - Memory: ${memBefore.rss}MB RSS`);

    // Validate required fields
    if (!model || !jpProxyUrl || !usProxyUrl || !jpUrl || !usUrl) {
        return res.status(400).json({ error: 'model, jpProxyUrl, usProxyUrl, jpUrl, and usUrl are required' });
    }

    // SSRF Protection: Validate all URLs
    const validations = {
        jpUrl: isSafePublicUrl(jpUrl),
        usUrl: isSafePublicUrl(usUrl),
        jpProxy: isValidProxyUrl(jpProxyUrl),
        usProxy: isValidProxyUrl(usProxyUrl),
        callback: isValidCallbackUrl(callbackUrl)
    };

    for (const [name, validation] of Object.entries(validations)) {
        if (!validation.valid) {
            console.warn(`SSRF protection blocked ${name}: ${validation.reason}`);
            return res.status(400).json({
                error: `Invalid or unsafe ${name}`,
                reason: validation.reason
            });
        }
    }

    console.log(`[${new Date().toISOString()}] IDEC Dual-Site: Searching for model: ${model}`);
    if (callbackUrl) {
        console.log(`Callback URL provided: ${callbackUrl}`);
    }

    // Enqueue task
    return enqueuePuppeteerTask(async () => {
        let callbackSent = false;

        try {
            // Try JP site first
            const jpResult = await scrapeIdecSite(jpUrl, jpProxyUrl, 'JP', model);

            if (jpResult.success) {
                console.log(`✓ IDEC JP site succeeded, sending callback`);
                await sendCallback(callbackUrl, {
                    jobId,
                    urlIndex,
                    content: jpResult.content,
                    title: jpResult.title,
                    snippet: `IDEC product page (JP site)`,
                    url: jpResult.url
                });

                forceGarbageCollection();
                trackMemoryUsage(`idec_dual_complete_${requestCount}_jp_success`);
                scheduleRestartIfNeeded();

                return res.json({
                    success: true,
                    site: 'JP',
                    url: jpResult.url,
                    title: jpResult.title,
                    contentLength: jpResult.content.length,
                    method: 'idec_dual_site_jp',
                    timestamp: new Date().toISOString()
                });
            }

            // JP site failed - try US site
            console.log(`JP site failed, trying US site...`);
            const usResult = await scrapeIdecSite(usUrl, usProxyUrl, 'US', model);

            if (usResult.success) {
                console.log(`✓ IDEC US site succeeded, sending callback`);
                await sendCallback(callbackUrl, {
                    jobId,
                    urlIndex,
                    content: usResult.content,
                    title: usResult.title,
                    snippet: `IDEC product page (US site)`,
                    url: usResult.url
                });

                forceGarbageCollection();
                trackMemoryUsage(`idec_dual_complete_${requestCount}_us_success`);
                scheduleRestartIfNeeded();

                return res.json({
                    success: true,
                    site: 'US',
                    url: usResult.url,
                    title: usResult.title,
                    contentLength: usResult.content.length,
                    method: 'idec_dual_site_us',
                    timestamp: new Date().toISOString()
                });
            }

            // Both sites failed
            console.log(`Both JP and US sites failed, sending placeholder`);
            const placeholderMessage = '[No results found for this product on the manufacturer website (searched both JP and US sites)]';

            await sendCallback(callbackUrl, {
                jobId,
                urlIndex,
                content: placeholderMessage,
                title: null,
                snippet: 'IDEC search - no results',
                url: jpUrl
            });

            forceGarbageCollection();
            trackMemoryUsage(`idec_dual_complete_${requestCount}_both_failed`);
            scheduleRestartIfNeeded();

            return res.json({
                success: false,
                error: 'No results on both JP and US sites',
                jpError: jpResult.error,
                usError: usResult.error,
                method: 'idec_dual_site_no_results',
                timestamp: new Date().toISOString()
            });

        } catch (error) {
            console.error(`IDEC dual-site scraping error:`, error);

            if (!callbackSent && callbackUrl) {
                await sendCallback(callbackUrl, {
                    jobId,
                    urlIndex,
                    content: `[IDEC dual-site search failed: ${error.message}]`,
                    title: null,
                    snippet: '',
                    url: jpUrl
                });
            }

            forceGarbageCollection();
            trackMemoryUsage(`idec_dual_complete_${requestCount}_error`);
            scheduleRestartIfNeeded();

            return res.status(500).json({
                success: false,
                error: error.message,
                model: model
            });
        }
    });
}

module.exports = {
    handleIdecDualScrapeRequest
};
