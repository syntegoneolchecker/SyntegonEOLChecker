// Puppeteer configuration and common browser setup
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

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
        '--single-process', // Run in single process to reduce overhead
        '--disable-features=site-per-process', // Reduce process isolation overhead
        '--js-flags=--max-old-space-size=256', // Limit V8 heap to 256MB
        '--disable-web-security', // Disable CORS (reduces memory for cross-origin checks)
        '--disable-features=IsolateOrigins', // Reduce memory isolation
        '--disable-site-isolation-trials' // Further reduce isolation overhead
    ];
}

/**
 * Browser launch arguments with proxy configuration
 * @param {string} proxyServer - Proxy server address (e.g., "proxy.example.com:8080")
 * @returns {Array<string>} Browser launch arguments with proxy
 */
function getBrowserArgsWithProxy(proxyServer) {
    const args = getStandardBrowserArgs();
    args.push(`--proxy-server=${proxyServer}`);
    return args;
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
 * Launch browser with proxy configuration
 * @param {string} proxyServer - Proxy server address
 * @param {Object} options - Additional launch options
 * @returns {Promise<Browser>} Puppeteer browser instance
 */
async function launchBrowserWithProxy(proxyServer, options = {}) {
    return await puppeteer.launch({
        headless: 'new',
        args: getBrowserArgsWithProxy(proxyServer),
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
        viewportHeight = 720,
        proxyUsername = null,
        proxyPassword = null
    } = options;

    await page.setUserAgent(userAgent);
    await page.setViewport({ width: viewportWidth, height: viewportHeight });

    // Set up proxy authentication if credentials provided
    if (proxyUsername && proxyPassword) {
        await page.authenticate({
            username: proxyUsername,
            password: proxyPassword
        });
        console.log('Proxy authentication configured');
    }
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
        blockStylesheets = true,
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

    console.log(`Resource blocking enabled: ${blockingDesc.join(', ')}`);
}

/**
 * Extract content from a page
 * @param {Page} page - Puppeteer page instance
 * @param {number} timeout - Extraction timeout in milliseconds (default: 10000)
 * @returns {Promise<Object>} Object with content and title
 */
async function extractPageContent(page, timeout = 10000) {
    const extractionPromise = (async () => {
        const extractedContent = await page.evaluate(() => {
            const scripts = document.querySelectorAll('script, style, noscript');
            scripts.forEach(script => script.remove());
            return document.body.innerText;
        });
        const extractedTitle = await page.title();
        return { content: extractedContent, title: extractedTitle };
    })();

    const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Content extraction timeout')), timeout)
    );

    return await Promise.race([extractionPromise, timeoutPromise]);
}

module.exports = {
    puppeteer,
    getStandardBrowserArgs,
    getBrowserArgsWithProxy,
    launchBrowser,
    launchBrowserWithProxy,
    configureStandardPage,
    setupResourceBlocking,
    extractPageContent
};
