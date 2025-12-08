const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cors = require('cors');
const pdfParse = require('pdf-parse');

// Use stealth plugin to bypass bot detection (Cloudflare, etc.)
puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;

// Memory management: Track request count and restart after N requests
// This prevents hitting Render's 512MB memory limit
let requestCount = 0;
const MAX_REQUESTS_BEFORE_RESTART = 5; // Reduced from 10 to restart more frequently

// Request queue: Only allow one Puppeteer instance at a time
// This prevents memory spikes from concurrent browser instances
let puppeteerQueue = Promise.resolve();
function enqueuePuppeteerTask(task) {
    const result = puppeteerQueue.then(task, task); // Run task whether previous succeeded or failed
    puppeteerQueue = result.catch(() => {}); // Prevent unhandled rejections from blocking queue
    return result;
}

// Middleware
app.use(cors());
app.use(express.json());

// Helper: Check if URL is a PDF
function isPDFUrl(url) {
    return url.toLowerCase().includes('pdf') || url.toLowerCase().endsWith('.pdf');
}

// Helper: Check if URL is a text file
function isTextFileUrl(url) {
    const textExtensions = ['.txt', '.log', '.md', '.csv'];
    const urlLower = url.toLowerCase();
    return textExtensions.some(ext => urlLower.endsWith(ext));
}

// Helper: Extract text from HTML with enhanced table preservation
// NOTE: No truncation here - let the website handle all truncation logic
function extractHTMLText(html) {
    // First preserve table structure by adding markers
    let processedHtml = html
        .replace(/<tr[^>]*>/gi, '\n[ROW] ')
        .replace(/<\/tr>/gi, ' [/ROW]\n')
        .replace(/<td[^>]*>/gi, '[CELL] ')
        .replace(/<\/td>/gi, ' [/CELL] ')
        .replace(/<th[^>]*>/gi, '[HEADER] ')
        .replace(/<\/th>/gi, ' [/HEADER] ');

    // Remove unwanted elements
    const text = processedHtml
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
        .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#\d+;/g, ' ')
        .replace(/\s+/g, ' ')
        .replace(/\[ROW\]/g, '\n')
        .replace(/\[\/ROW\]/g, '')
        .replace(/\[CELL\]/g, '| ')
        .replace(/\[\/CELL\]/g, '')
        .replace(/\[HEADER\]/g, '| ')
        .replace(/\[\/HEADER\]/g, '')
        .trim();

    return text;
}

// Helper: Detect error pages
function isErrorPage(text) {
    if (!text || text.length < 200) {
        return true;
    }

    const errorIndicators = [
        '500 Internal Server Error',
        '404 Not Found',
        '403 Forbidden',
        'Internal Server Error',
        'Page Not Found',
        'Access Denied',
        'PAGE NOT FOUND',
        'Error404',
        'ページが見つかりませんでした',
        '申し訳ございませんが、ご指定のページが見つかりませんでした'
    ];

    return errorIndicators.some(indicator => text.includes(indicator));
}

// Helper: Extract text from PDF
// NOTE: No truncation here - let the website handle all truncation logic
async function extractPDFText(pdfBuffer, url) {
    try {
        console.log(`Parsing PDF from ${url} (${pdfBuffer.length} bytes)`);

        if (pdfBuffer.length === 0) {
            console.error(`PDF buffer is empty for ${url}`);
            return `[PDF is empty or could not be downloaded]`;
        }

        // Check PDF magic number
        const pdfHeader = pdfBuffer.slice(0, 5).toString('utf-8');
        if (!pdfHeader.startsWith('%PDF')) {
            console.error(`Invalid PDF header for ${url}: ${pdfHeader}`);
            return `[File is not a valid PDF - may be HTML or error page]`;
        }

        // Parse PDF - limit to first 5 pages
        const data = await pdfParse(pdfBuffer, {
            max: 5
        });

        const fullText = data.text
            .replace(/\s+/g, ' ')
            .trim();

        if (fullText.length === 0) {
            console.warn(`PDF parsed but extracted 0 characters from ${url}`);
            return `[PDF contains no extractable text - may be image-based PDF]`;
        }

        console.log(`✓ Successfully extracted ${fullText.length} chars from PDF (${Math.min(5, data.numpages)} pages)`);

        return fullText;

    } catch (error) {
        console.error(`PDF extraction error from ${url}:`, error.message);
        return `[PDF extraction failed: ${error.message}]`;
    }
}

// Helper: Try fast fetch without Puppeteer (for PDFs and simple pages)
async function tryFastFetch(url, timeout = 5000) {
    try {
        const isPDF = isPDFUrl(url);
        const isTextFile = isTextFileUrl(url);
        const fetchTimeout = isPDF ? 20000 : timeout;

        if (isPDF) {
            console.log(`Detected PDF URL, using ${fetchTimeout}ms timeout: ${url}`);
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), fetchTimeout);

        const response = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EOLChecker/1.0)' },
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            console.log(`Fast fetch failed: HTTP ${response.status} for ${url}`);
            if (isPDF) {
                return `[Could not fetch PDF: HTTP ${response.status}]`;
            }
            return null;
        }

        const contentType = response.headers.get('content-type') || '';

        // Handle PDF files
        if (contentType.includes('application/pdf') || isPDF) {
            console.log(`Detected PDF (Content-Type: ${contentType}), extracting text: ${url}`);
            const pdfBuffer = Buffer.from(await response.arrayBuffer());
            return await extractPDFText(pdfBuffer, url);
        }

        // Handle text files
        if (contentType.includes('text/plain') || isTextFile) {
            console.log(`Detected text file (Content-Type: ${contentType}): ${url}`);
            const text = await response.text();
            return text; // No truncation - let website handle it
        }

        // Handle HTML
        const html = await response.text();
        const text = extractHTMLText(html);

        if (isErrorPage(text)) {
            console.log(`Detected error page for ${url}`);
            return null;
        }

        return text;

    } catch (error) {
        console.error(`Fast fetch error for ${url}:`, error.message);

        const isPDF = isPDFUrl(url);
        if (isPDF) {
            return `[PDF fetch failed: ${error.message}]`;
        }

        return null;
    }
}

// Helper: Send callback unconditionally (with retry logic and response validation)
async function sendCallback(callbackUrl, payload, maxRetries = 3) {
    if (!callbackUrl) return;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`Sending callback (attempt ${attempt}/${maxRetries}): ${callbackUrl}`);
            const response = await fetch(callbackUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            // CRITICAL FIX: Validate response status
            if (!response.ok) {
                const errorText = await response.text().catch(() => 'Could not read response body');
                console.error(`Callback returned HTTP ${response.status} on attempt ${attempt}/${maxRetries}:`, errorText);

                if (attempt < maxRetries) {
                    // Retry on HTTP errors (500, 502, 503, 504, etc.)
                    const backoffMs = 1000 * Math.pow(2, attempt); // 2s, 4s, 8s
                    console.log(`Retrying callback in ${backoffMs}ms...`);
                    await new Promise(resolve => setTimeout(resolve, backoffMs));
                    continue; // Try again
                } else {
                    throw new Error(`Callback failed with HTTP ${response.status}: ${errorText}`);
                }
            }

            // Success!
            console.log(`✓ Callback successful (HTTP ${response.status})`);
            return;
        } catch (callbackError) {
            console.error(`Callback attempt ${attempt} failed:`, callbackError.message);
            if (attempt === maxRetries) {
                console.error(`❌ All ${maxRetries} callback attempts failed - callback lost`);
                throw callbackError; // Propagate error so scraping endpoint can handle it
            } else {
                // Wait before retry (exponential backoff)
                const backoffMs = 1000 * Math.pow(2, attempt); // 2s, 4s, 8s
                console.log(`Retrying callback in ${backoffMs}ms...`);
                await new Promise(resolve => setTimeout(resolve, backoffMs));
            }
        }
    }
}

// Helper: Schedule process restart if request limit reached
function scheduleRestartIfNeeded() {
    if (requestCount >= MAX_REQUESTS_BEFORE_RESTART) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`🔄 REQUEST LIMIT REACHED (${requestCount}/${MAX_REQUESTS_BEFORE_RESTART})`);
        console.log(`Scheduling graceful restart in 2 seconds to free memory...`);
        console.log(`${'='.repeat(60)}\n`);

        // Give time for response to be sent, then exit
        // Render will automatically restart the service
        setTimeout(() => {
            console.log('Exiting process for restart...');
            process.exit(0);
        }, 2000);
    }
}

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Main scraping endpoint
app.post('/scrape', async (req, res) => {
    const { url, callbackUrl, jobId, urlIndex, title, snippet } = req.body;

    // Memory management: Increment request counter
    requestCount++;
    console.log(`[${new Date().toISOString()}] Request #${requestCount}/${MAX_REQUESTS_BEFORE_RESTART}`);

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    console.log(`[${new Date().toISOString()}] Scraping URL: ${url}`);
    if (callbackUrl) {
        console.log(`Callback URL provided: ${callbackUrl}`);
    }

    try {
        // Try fast fetch first (handles PDFs, text files, and simple HTML)
        console.log(`Attempting fast fetch for ${url}...`);
        const fastResult = await tryFastFetch(url);

        if (fastResult) {
            console.log(`[${new Date().toISOString()}] Fast fetch successful: ${url}`);
            console.log(`Content length: ${fastResult.length} characters`);

            const result = {
                success: true,
                url: url,
                title: null,
                content: fastResult,
                contentLength: fastResult.length,
                method: 'fast_fetch',
                timestamp: new Date().toISOString()
            };

            // Send callback unconditionally
            await sendCallback(callbackUrl, {
                jobId,
                urlIndex,
                content: fastResult,
                title: null,
                snippet,
                url
            });

            // Schedule restart if memory limit approaching
            scheduleRestartIfNeeded();

            return res.json(result);
        }

        // Fast fetch failed - check if it's a PDF or text file
        if (isPDFUrl(url) || isTextFileUrl(url)) {
            console.log(`[${new Date().toISOString()}] PDF/text file fetch failed, not attempting Puppeteer`);

            const errorResult = {
                success: false,
                error: 'PDF or text file could not be fetched',
                url: url
            };

            // Send error callback unconditionally
            await sendCallback(callbackUrl, {
                jobId,
                urlIndex,
                content: '[PDF or text file could not be fetched]',
                title: null,
                snippet,
                url
            });

            // Schedule restart if memory limit approaching
            scheduleRestartIfNeeded();

            return res.status(500).json(errorResult);
        }

        // Use Puppeteer for dynamic HTML pages only
        console.log(`Fast fetch failed, using Puppeteer for ${url}...`);

        // Enqueue this Puppeteer task to prevent concurrent browser instances
        return enqueuePuppeteerTask(async () => {
            let browser = null;
            let callbackSent = false; // Track if we've sent callback to avoid duplicates

            try {
                browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu',
                // Additional memory-saving args
                '--disable-software-rasterizer',
                '--disable-background-networking',
                '--disable-default-apps',
                '--disable-sync',
                '--disable-extensions',
                // Explicitly disable automation flag (Cloudflare detection)
                '--disable-blink-features=AutomationControlled'
            ],
            timeout: 120000 // 2 minutes
        });

        const page = await browser.newPage();

        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );

        await page.setViewport({ width: 1920, height: 1080 });

        // Conditionally enable resource blocking
        // Skip resource blocking for Cloudflare-protected sites (Oriental Motor)
        // as CSS/JS might be needed for the challenge to complete
        const isCloudflareProtected = url.includes('orientalmotor.co.jp');

        // Aggressive tracking/analytics domain blocking list
        const blockedDomains = [
            'google-analytics.com', 'googletagmanager.com', 'doubleclick.net',
            'googleadservices.com', 'googlesyndication.com',
            'facebook.net', 'facebook.com/tr', 'connect.facebook.net',
            'adsrvr.org', 'adnxs.com', 'taboola.com', 'outbrain.com',
            'clarity.ms', 'hotjar.com', 'mouseflow.com',
            'im-apps.net', 'nakanohito.jp', 'yahoo.co.jp/rt',
            'creativecdn.com', 'slim02.jp', 'cameleer',
            'recommend-jp.misumi-ec.com', 'insight.adsrvr.org'
        ];

        if (!isCloudflareProtected) {
            // Enable request interception to block heavy resources (reduces memory usage by 50-70%)
            await page.setRequestInterception(true);

            page.on('request', (request) => {
                const requestUrl = request.url();
                const resourceType = request.resourceType();

                // Block tracking/analytics domains
                const isBlockedDomain = blockedDomains.some(domain => requestUrl.includes(domain));
                if (isBlockedDomain) {
                    request.abort();
                    return;
                }

                // Block images, stylesheets, fonts, and media to save memory
                if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
                    request.abort();
                } else {
                    request.continue();
                }
            });
            console.log('Resource blocking enabled: images, fonts, media, and tracking domains blocked');
        } else {
            console.log('Resource blocking DISABLED for Cloudflare-protected site (Oriental Motor)');
        }

        // Network monitoring to diagnose timeout causes
        const pendingRequests = new Map(); // Map<url, {startTime, resourceType}>

        page.on('request', request => {
            pendingRequests.set(request.url(), {
                startTime: Date.now(),
                resourceType: request.resourceType()
            });
        });

        page.on('requestfinished', request => {
            pendingRequests.delete(request.url());
        });

        page.on('requestfailed', request => {
            pendingRequests.delete(request.url());
        });

        // Detect MISUMI pages
        const isMisumiPage = url.includes('misumi-ec.com');
        // Use networkidle2 for all pages - tracking domains are blocked, so it won't hang
        const waitStrategy = 'networkidle2';
        const navTimeout = 45000; // Increased to 45s to allow MISUMI API calls to complete

        // Try navigation with timeout, extract content even if it times out
        let navigationTimedOut = false;
        try {
            await page.goto(url, {
                waitUntil: waitStrategy, // domcontentloaded for MISUMI, networkidle2 for others
                timeout: navTimeout
            });
            console.log(`Navigation completed with ${waitStrategy}`);
        } catch (navError) {
            // Check if it's a timeout error
            if (navError.message.includes('timeout') || navError.message.includes('Navigation timeout')) {
                console.log(`Navigation timed out after ${navTimeout/1000}s, but page may have partial content - continuing with extraction`);
                navigationTimedOut = true;

                // NETWORK DIAGNOSTICS: Log pending requests to identify timeout cause
                console.log(`\n=== NETWORK TIMEOUT DIAGNOSTICS ===`);
                console.log(`Total pending requests: ${pendingRequests.size}`);

                if (pendingRequests.size > 0) {
                    // Group by resource type
                    const byType = new Map();
                    for (const [url, info] of pendingRequests) {
                        if (!byType.has(info.resourceType)) {
                            byType.set(info.resourceType, []);
                        }
                        byType.get(info.resourceType).push({
                            url,
                            duration: Date.now() - info.startTime
                        });
                    }

                    // Log summary by type
                    console.log(`\nPending requests by type:`);
                    for (const [type, requests] of byType) {
                        console.log(`  ${type}: ${requests.length}`);
                    }

                    // Log top 10 longest pending requests
                    const sortedRequests = Array.from(pendingRequests.entries())
                        .map(([url, info]) => ({
                            url,
                            duration: Date.now() - info.startTime,
                            type: info.resourceType
                        }))
                        .sort((a, b) => b.duration - a.duration)
                        .slice(0, 10);

                    console.log(`\nTop 10 longest pending requests:`);
                    sortedRequests.forEach((req, i) => {
                        const seconds = (req.duration / 1000).toFixed(1);
                        console.log(`  ${i + 1}. [${req.type}] ${seconds}s - ${req.url.substring(0, 100)}${req.url.length > 100 ? '...' : ''}`);
                    });
                }
                console.log(`===================================\n`);

                // Don't throw - continue to extract whatever content is available
            } else {
                // Other navigation errors (not timeout) - rethrow
                throw navError;
            }
        }

        // Additional wait for JavaScript rendering after network settles
        // networkidle2 means data is loaded, just need JS to render it
        if (isCloudflareProtected) {
            // Cloudflare challenge needs extra time
            await new Promise(resolve => setTimeout(resolve, 20000));
            console.log('Extended 20-second wait for Cloudflare challenge completion');
        } else if (navigationTimedOut) {
            // Timeout: minimal wait
            await new Promise(resolve => setTimeout(resolve, 1000));
        } else {
            // Standard wait for JS rendering (data already loaded via networkidle2)
            await new Promise(resolve => setTimeout(resolve, 3000));
        }

        // Extract content with timeout protection (page might be in bad state after nav timeout)
        let content = '';
        let pageTitle = '';

        try {
            // Wrap extraction in Promise.race with 10s timeout (reduced from 30s)
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
                setTimeout(() => reject(new Error('Content extraction timeout')), 10000)
            );

            const result = await Promise.race([extractionPromise, timeoutPromise]);
            content = result.content;
            pageTitle = result.title;

            if (navigationTimedOut) {
                console.log(`[${new Date().toISOString()}] Scraped with Puppeteer (partial - timeout): ${url}`);
                console.log(`Content length: ${content.length} characters (extracted after 60s timeout)`);
            } else {
                console.log(`[${new Date().toISOString()}] Successfully scraped with Puppeteer: ${url}`);
                console.log(`Content length: ${content.length} characters`);
            }
        } catch (extractError) {
            console.error(`Content extraction failed after navigation timeout: ${extractError.message}`);

            // Extraction failed - send error callback unconditionally
            await sendCallback(callbackUrl, {
                jobId,
                urlIndex,
                content: `[Content extraction failed: ${extractError.message}]`,
                title: null,
                snippet,
                url
            });
            callbackSent = true;

            // Close browser before returning
            try {
                await browser.close();
            } catch (closeErr) {
                console.error('Failed to close browser:', closeErr.message);
            }

            // Schedule restart if memory limit approaching
            scheduleRestartIfNeeded();

            return res.status(500).json({
                success: false,
                error: `Content extraction failed: ${extractError.message}`,
                url: url
            });
        }

        await browser.close();

        const result = {
            success: true,
            url: url,
            title: pageTitle,
            content: content,
            contentLength: content.length,
            method: 'puppeteer',
            timestamp: new Date().toISOString()
        };

        // Send success callback unconditionally
        await sendCallback(callbackUrl, {
            jobId,
            urlIndex,
            content: content,
            title: pageTitle,
            snippet,
            url
        });
        callbackSent = true;

        // Schedule restart if memory limit approaching
        scheduleRestartIfNeeded();

        res.json(result);

            } catch (puppeteerError) {
                // Catastrophic Puppeteer error (browser crash, launch failure, etc.)
                console.error(`[${new Date().toISOString()}] Puppeteer catastrophic error:`, puppeteerError.message);

                // Send error callback unconditionally (if not already sent)
                if (!callbackSent) {
                    await sendCallback(callbackUrl, {
                        jobId,
                        urlIndex,
                        content: `[Scraping failed completely: ${puppeteerError.message}]`,
                        title: null,
                        snippet,
                        url
                    });
                }

                // Close browser if it's open
                if (browser) {
                    try {
                        await browser.close();
                    } catch (closeErr) {
                        console.error('Failed to close browser:', closeErr.message);
                    }
                }

                // Schedule restart if memory limit approaching
                scheduleRestartIfNeeded();

                return res.status(500).json({
                    success: false,
                    error: `Puppeteer error: ${puppeteerError.message}`,
                    url: url
                });
            } finally {
                // Ensure browser is always closed, even if errors occur
                if (browser) {
                    try {
                        await browser.close();
                        browser = null;
                    } catch (closeErr) {
                        console.error('Failed to close browser in finally block:', closeErr.message);
                    }
                }
            }
        }); // End of enqueuePuppeteerTask

    } catch (error) {
        console.error(`[${new Date().toISOString()}] Scraping error:`, error.message);

        // Send error callback unconditionally (outer catch - should rarely reach here)
        await sendCallback(callbackUrl, {
            jobId,
            urlIndex,
            content: `[Scraping error: ${error.message}]`,
            title: null,
            snippet,
            url
        });

        // Schedule restart if memory limit approaching
        scheduleRestartIfNeeded();

        res.status(500).json({
            success: false,
            error: error.message,
            url: url
        });
    }
});

// KEYENCE-specific scraping endpoint (interactive search)
app.post('/scrape-keyence', async (req, res) => {
    const { model, callbackUrl, jobId, urlIndex } = req.body;

    // Memory management: Increment request counter
    requestCount++;
    console.log(`[${new Date().toISOString()}] KEYENCE Search Request #${requestCount}/${MAX_REQUESTS_BEFORE_RESTART}`);

    if (!model) {
        return res.status(400).json({ error: 'Model is required' });
    }

    console.log(`[${new Date().toISOString()}] KEYENCE: Searching for model: ${model}`);
    if (callbackUrl) {
        console.log(`Callback URL provided: ${callbackUrl}`);
    }

    // Enqueue this Puppeteer task to prevent concurrent browser instances
    return enqueuePuppeteerTask(async () => {
        let browser = null;
        let callbackSent = false;

        try {
            browser = await puppeteer.launch({
            headless: 'new',
            args: [
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
                '--disable-blink-features=AutomationControlled'
            ],
            timeout: 120000
        });

        const page = await browser.newPage();

        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );

        await page.setViewport({ width: 1920, height: 1080 });

        // Enable request interception to block only heavy resources (images and media)
        // IMPORTANT: Allow stylesheets and scripts - KEYENCE needs them to render properly
        // Also block third-party analytics/tracking that prevents load event
        await page.setRequestInterception(true);

        const blockedDomains = [
            'im-apps.net',           // Analytics
            'nakanohito.jp',         // Japanese analytics
            'clarity.ms',            // Microsoft Clarity
            'taboola.com',           // Taboola ads/tracking
            'facebook.net',          // Facebook Pixel
            'google-analytics.com',  // Google Analytics
            'googletagmanager.com',  // Google Tag Manager
            'doubleclick.net'        // Google ads
        ];

        page.on('request', (request) => {
            const url = request.url();
            const resourceType = request.resourceType();

            // Block images and media
            if (['image', 'media'].includes(resourceType)) {
                request.abort();
                return;
            }

            // Block third-party analytics/tracking domains
            const isBlockedDomain = blockedDomains.some(domain => url.includes(domain));
            if (isBlockedDomain) {
                request.abort();
                return;
            }

            // Allow everything else
            request.continue();
        });
        console.log('Resource blocking: images, media, and analytics blocked; CSS/JS allowed for KEYENCE');

        console.log('Navigating to KEYENCE homepage...');
        await page.goto('https://www.keyence.co.jp/', {
            waitUntil: 'domcontentloaded',  // Faster than 'load' (~5-10s vs ~20s)
            timeout: 30000
        });

        console.log('KEYENCE homepage loaded, waiting for search elements to render...');

        // Wait briefly for JavaScript to render the search bar
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

        // Find the search input using specific class
        const inputSelector = '.m-form-search__input';

        console.log(`Setting search input value to "${model}" and pressing Enter...`);
        // Set value directly in the input
        await page.evaluate((selector, value) => {
            const input = document.querySelector(selector);
            if (input) {
                input.value = value;
                // Trigger input event so page JavaScript knows value changed
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }, inputSelector, model);

        // Click the input to ensure it's focused and ready for keyboard events
        await page.click(inputSelector);

        // Press Enter and wait for navigation - with error recovery
        try {
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
                page.keyboard.press('Enter')
            ]);
        } catch (navError) {
            // Navigation timeout - but page might have loaded anyway
            console.log(`Navigation timeout: ${navError.message}`);
            await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s for page to settle
        }

        // Get the final URL after navigation
        const finalUrl = page.url();
        console.log(`Final page URL: ${finalUrl}`);

        // Extract content from the current page (whether navigation succeeded or not)
        const htmlContent = await page.content();
        const text = extractHTMLText(htmlContent);

        console.log(`Extracted ${text.length} characters from KEYENCE page`);

        // Get page title
        const title = await page.title();

        const result = {
            success: true,
            url: finalUrl,
            originalSearch: model,
            title: title,
            content: text,
            contentLength: text.length,
            method: 'keyence_interactive_search',
            timestamp: new Date().toISOString()
        };

        // Close browser IMMEDIATELY to free memory before callback
        await browser.close();
        browser = null;
        console.log('Browser closed, memory freed');

        // Send callback unconditionally (browser already closed)
        if (callbackUrl) {
            await sendCallback(callbackUrl, {
                jobId,
                urlIndex,
                content: text,
                title: title,
                snippet: `KEYENCE search result for ${model}`,
                url: finalUrl
            });
            callbackSent = true;
        }

        // Force restart after KEYENCE check (uses more memory than normal checks)
        console.log('KEYENCE check complete - forcing restart to free memory');
        requestCount = MAX_REQUESTS_BEFORE_RESTART;
        scheduleRestartIfNeeded();

        return res.json(result);

        } catch (error) {
            console.error(`KEYENCE scraping error:`, error);

            // Close browser IMMEDIATELY to free memory before callback
            if (browser) {
                try {
                    await browser.close();
                    browser = null;
                    console.log('Browser closed after error, memory freed');
                } catch (closeError) {
                    console.error('Error closing browser after KEYENCE scraping error:', closeError);
                }
            }

            // Send error callback if not already sent (browser already closed)
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

            // Force restart after KEYENCE check (even on error - uses more memory than normal checks)
            console.log('KEYENCE check failed - forcing restart to free memory');
            requestCount = MAX_REQUESTS_BEFORE_RESTART;
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
                    browser = null;
                } catch (closeErr) {
                    console.error('Failed to close browser in finally block:', closeErr.message);
                }
            }
        }
    }); // End of enqueuePuppeteerTask
});

// Batch scraping endpoint (multiple URLs)
app.post('/scrape-batch', async (req, res) => {
    const { urls } = req.body;

    if (!urls || !Array.isArray(urls)) {
        return res.status(400).json({ error: 'URLs array is required' });
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
                    browser = await puppeteer.launch({
                        headless: 'new',
                        args: [
                            '--no-sandbox',
                            '--disable-setuid-sandbox',
                            '--disable-dev-shm-usage',
                            '--disable-accelerated-2d-canvas',
                            '--no-first-run',
                            '--no-zygote',
                            '--disable-gpu',
                            // Additional memory-saving args
                            '--disable-software-rasterizer',
                            '--disable-background-networking',
                            '--disable-default-apps',
                            '--disable-sync',
                            '--disable-extensions',
                            // Explicitly disable automation flag (Cloudflare detection)
                            '--disable-blink-features=AutomationControlled'
                        ],
                        timeout: 120000 // 2 minutes
                    });
                }

                const page = await browser.newPage();

                await page.setUserAgent(
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                );

                await page.setViewport({ width: 1920, height: 1080 });

                // Conditionally enable resource blocking
                // Skip resource blocking for Cloudflare-protected sites (Oriental Motor)
                const isCloudflareProtected = url.includes('orientalmotor.co.jp');

                if (!isCloudflareProtected) {
                    // Enable request interception to block heavy resources (reduces memory usage by 50-70%)
                    await page.setRequestInterception(true);

                    page.on('request', (request) => {
                        const resourceType = request.resourceType();
                        // Block images, stylesheets, fonts, and media to save memory
                        if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
                            request.abort();
                        } else {
                            request.continue();
                        }
                    });
                } else {
                    console.log('Resource blocking DISABLED for Cloudflare-protected site (Oriental Motor)');
                }

                await page.goto(url, {
                    waitUntil: 'networkidle2', // Wait until ≤2 network connections remain
                    timeout: 120000 // 2 minutes for heavy dynamic sites
                });

                // Additional wait for JavaScript rendering
                // Longer wait for Cloudflare-protected sites (challenge can take 10-20s)
                const postLoadWait = isCloudflareProtected ? 20000 : 5000;
                await new Promise(resolve => setTimeout(resolve, postLoadWait));

                if (isCloudflareProtected) {
                    console.log('Extended 20-second wait for Cloudflare challenge completion');
                }

                const content = await page.evaluate(() => {
                    const scripts = document.querySelectorAll('script, style, noscript');
                    scripts.forEach(script => script.remove());
                    return document.body.innerText;
                });

                const title = await page.title();

                await page.close();

                results.push({
                    success: true,
                    url: url,
                    title: title,
                    content: content,
                    contentLength: content.length,
                    method: 'puppeteer'
                });

                console.log(`[${new Date().toISOString()}] Scraped ${url} with Puppeteer (${content.length} chars)`);

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
});

app.listen(PORT, () => {
    console.log(`Scraping service running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
});
