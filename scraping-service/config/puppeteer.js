// Puppeteer configuration and common browser setup
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const logger = require('./../utils/logger');

// Use stealth plugin to bypass bot detection (Cloudflare, etc.)
puppeteer.use(StealthPlugin());

/**
 * Standard browser launch arguments optimized for memory usage
 * @returns {Array<string>} Browser launch arguments
 */
function getStandardBrowserArgs() {
    return [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-extensions',
        '--disable-blink-features=AutomationControlled',
        // MEMORY OPTIMIZATIONS (prevent OOM on 512MB limit)
        //'--single-process', // Run in single process to reduce overhead
        '--disable-features=site-per-process', // Reduce process isolation overhead
        '--js-flags=--max-old-space-size=256', // Limit V8 heap to 256MB
        '--disable-web-security', // Disable CORS (reduces memory for cross-origin checks)
        '--disable-features=IsolateOrigins', // Reduce memory isolation
        '--disable-site-isolation-trials' // Further reduce isolation overhead
    ];
}


/**
 * Launch browser with standard configuration
 * @param {Object} options - Additional launch options
 * @returns {Promise<Browser>} Puppeteer browser instance
 */
async function launchBrowser(options = {}) {
    return await puppeteer.launch({
        headless: 'new',
        args: getStandardBrowserArgs(),
        timeout: 120000, // 2 minutes
        ...options
    });
}


/**
 * Configure page with standard settings
 * @param {Page} page - Puppeteer page instance
 * @param {Object} options - Configuration options
 * @returns {Promise<void>}
 */
async function configureStandardPage(page, options = {}) {
    const {
        userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewportWidth = 1280,
        viewportHeight = 720
    } = options;

    await page.setUserAgent(userAgent);
    await page.setViewport({ width: viewportWidth, height: viewportHeight });
}

/**
 * Set up resource blocking on a page to save memory
 * @param {Page} page - Puppeteer page instance
 * @param {Object} options - Blocking options
 * @returns {Promise<void>}
 */
async function setupResourceBlocking(page, options = {}) {
    const {
        blockImages = true,
        blockStylesheets = false,
        blockFonts = true,
        blockMedia = true,
        blockTracking = true,
        customBlockedDomains = []
    } = options;

    // Default tracking/analytics domain blocking list
    const defaultBlockedDomains = [
        'google-analytics.com', 'googletagmanager.com', 'doubleclick.net',
        'googleadservices.com', 'googlesyndication.com',
        'facebook.net', 'facebook.com/tr', 'connect.facebook.net',
        'adsrvr.org', 'adnxs.com', 'taboola.com', 'outbrain.com',
        'clarity.ms', 'hotjar.com', 'mouseflow.com',
        'im-apps.net', 'nakanohito.jp', 'yahoo.co.jp/rt',
        'creativecdn.com', 'slim02.jp', 'cameleer',
        'recommend-jp.misumi-ec.com', 'insight.adsrvr.org'
    ];

    const blockedDomains = blockTracking
        ? [...defaultBlockedDomains, ...customBlockedDomains]
        : customBlockedDomains;

    await page.setRequestInterception(true);

    page.on('request', (request) => {
        const requestUrl = request.url();
        const resourceType = request.resourceType();

        // Block tracking/analytics domains
        if (blockedDomains.length > 0) {
            const isBlockedDomain = blockedDomains.some(domain => requestUrl.includes(domain));
            if (isBlockedDomain) {
                request.abort();
                return;
            }
        }

        // Block resource types based on options
        const blockedTypes = [];
        if (blockImages) blockedTypes.push('image');
        if (blockStylesheets) blockedTypes.push('stylesheet');
        if (blockFonts) blockedTypes.push('font');
        if (blockMedia) blockedTypes.push('media');

        if (blockedTypes.includes(resourceType)) {
            request.abort();
        } else {
            request.continue();
        }
    });

    const blockingDesc = [];
    if (blockImages) blockingDesc.push('images');
    if (blockStylesheets) blockingDesc.push('stylesheets');
    if (blockFonts) blockingDesc.push('fonts');
    if (blockMedia) blockingDesc.push('media');
    if (blockTracking) blockingDesc.push('tracking');

    logger.info(`Resource blocking enabled: ${blockingDesc.join(', ')}`);
}

/**
 * Perform the actual content extraction from a page
 * @param {Page} page - Puppeteer page instance
 * @returns {Promise<Object>} Object with content and title
 */
async function performExtraction(page) {
    const extractedContent = await page.evaluate(() => {
        // Helper function to extract and escape cell text
        function getCellText(cell) { // NOSONAR - getCellText must be inside page.evaluate (browser context)
            let text = cell.innerText || cell.textContent || '';
            text = text.replaceAll(/\s+/g, ' ').trim();
            text = text.replaceAll('\\', '\\\\');
            text = text.replaceAll('|', String.raw`\|`);
            return text;
        }

        // Helper function to convert a row to pipe-delimited format
        function convertRowToText(row) {
            const cells = row.querySelectorAll(':scope > th, :scope > td');
            if (cells.length === 0) return null;
            const cellTexts = Array.from(cells).map(getCellText);
            return '| ' + cellTexts.join(' | ') + ' |';
        }

        // Helper function to convert a table to text format
        function convertTableToText(table) {
            const rows = table.querySelectorAll(':scope > tr, :scope > tbody > tr, :scope > thead > tr');
            if (rows.length === 0) return null;

            const rowTexts = Array.from(rows)
                .map(convertRowToText)
                .filter(text => text !== null);

            if (rowTexts.length === 0) return null;
            return '=== TABLE START ===\n' + rowTexts.join('\n') + '\n=== TABLE END ===';
        }

        // Remove scripts, styles, and noscript elements
        document.querySelectorAll('script, style, noscript').forEach(el => el.remove());

        // Convert tables to pipe-delimited format
        document.querySelectorAll('table').forEach(table => {
            const tableText = convertTableToText(table);
            if (tableText) {
                const preElement = document.createElement('pre');
                preElement.textContent = tableText;
                preElement.style.whiteSpace = 'pre-wrap';
                table.parentNode.replaceChild(preElement, table);
            }
        });

        return document.body.innerText;
    });
    const extractedTitle = await page.title();
    return { content: extractedContent, title: extractedTitle };
}

/**
 * Extract content from a page, preserving table structure
 * Tables are converted to pipe-delimited format with markers for downstream processing
 * @param {Page} page - Puppeteer page instance
 * @param {number} timeout - Extraction timeout in milliseconds (default: 10000)
 * @returns {Promise<Object>} Object with content and title
 */
async function extractPageContent(page, timeout = 10000) {
    const extractionPromise = performExtraction(page);

    const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Content extraction timeout')), timeout)
    );

    return await Promise.race([extractionPromise, timeoutPromise]);
}

module.exports = {
    puppeteer,
    getStandardBrowserArgs,
    launchBrowser,
    configureStandardPage,
    setupResourceBlocking,
    extractPageContent
};
