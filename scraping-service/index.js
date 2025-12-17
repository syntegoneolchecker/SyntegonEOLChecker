const express = require('express');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const cors = require('cors');
const pdfParse = require('pdf-parse');
const iconv = require('iconv-lite');
const jschardet = require('jschardet');

// Use stealth plugin to bypass bot detection (Cloudflare, etc.)
puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 3000;

// Memory management: Monitor actual memory usage and restart when approaching limit
// Render's free tier has 512MB memory limit
let requestCount = 0;
const MEMORY_LIMIT_MB = 450; // Restart threshold (leaves 62MB buffer before 512MB limit)
const MEMORY_WARNING_MB = 380; // Warning threshold (log detailed memory info)
let isShuttingDown = false; // Flag to signal shutdown in progress

// Memory usage tracking for analysis
let memoryHistory = [];

// Force garbage collection if available (start with --expose-gc flag)
function forceGarbageCollection() {
    if (global.gc) {
        const before = getMemoryUsageMB();
        global.gc();
        const after = getMemoryUsageMB();
        console.log(`GC: ${before.rss}MB → ${after.rss}MB (freed ${before.rss - after.rss}MB)`);
    }
}

// Helper: Get current memory usage in MB
function getMemoryUsageMB() {
    const used = process.memoryUsage();
    return {
        rss: Math.round(used.rss / 1024 / 1024),
        heapUsed: Math.round(used.heapUsed / 1024 / 1024),
        heapTotal: Math.round(used.heapTotal / 1024 / 1024),
        external: Math.round(used.external / 1024 / 1024)
    };
}

// Helper: Track memory usage history
function trackMemoryUsage(stage) {
    const memory = getMemoryUsageMB();
    const entry = {
        timestamp: new Date().toISOString(),
        stage,
        requestCount,
        ...memory
    };

    memoryHistory.push(entry);

    // Keep only last 20 entries to avoid memory bloat
    if (memoryHistory.length > 20) {
        memoryHistory.shift();
    }

    // Log warning if approaching limit
    if (memory.rss >= MEMORY_WARNING_MB) {
        console.warn(`⚠️  Memory approaching limit: ${memory.rss}MB RSS (warning threshold: ${MEMORY_WARNING_MB}MB)`);
        console.log(`Memory history (last 5): ${JSON.stringify(memoryHistory.slice(-5), null, 2)}`);
    }

    return memory;
}

// Helper: Check if we should restart based on memory usage
function shouldRestartDueToMemory() {
    const memory = getMemoryUsageMB();

    if (memory.rss >= MEMORY_LIMIT_MB) {
        console.error(`❌ Memory limit reached: ${memory.rss}MB >= ${MEMORY_LIMIT_MB}MB, scheduling restart`);
        console.log(`Memory breakdown: Heap=${memory.heapUsed}/${memory.heapTotal}MB, External=${memory.external}MB`);
        console.log(`Request count at restart: ${requestCount}`);
        return true;
    }

    return false;
}

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
            return `[PDF contains no extractable text - may be encrypted, password-protected, or image-based. Please review this product manually.]`;
        }

        console.log(`✓ Successfully extracted ${fullText.length} chars from PDF (${Math.min(5, data.numpages)} pages)`);

        return fullText;

    } catch (error) {
        console.error(`PDF extraction error from ${url}:`, error.message);

        // Check if error is related to encryption
        if (error.message.includes('Crypt') || error.message.includes('encrypt') || error.message.includes('password')) {
            return `[PDF is encrypted or password-protected and cannot be read. Please review this product manually.]`;
        }

        return `[PDF extraction failed: ${error.message}]`;
    }
}

// Helper: Detect and decode text with proper character encoding
// This fixes mojibake (文字化け) issues with Japanese and other non-UTF-8 content
function decodeWithProperEncoding(buffer, contentTypeHeader = '') {
    try {
        // Step 1: Try to get encoding from HTTP Content-Type header
        let encoding = null;
        if (contentTypeHeader) {
            const charsetMatch = contentTypeHeader.match(/charset=([^\s;]+)/i);
            if (charsetMatch) {
                encoding = charsetMatch[1].toLowerCase();
                console.log(`Encoding from Content-Type header: ${encoding}`);
            }
        }

        // Step 2: Check HTML meta tags for charset (first 2KB should contain meta tags)
        if (!encoding) {
            const preview = buffer.slice(0, 2048).toString('binary');

            // Look for <meta charset="...">
            const metaCharsetMatch = preview.match(/<meta[^>]+charset=["']?([^"'\s>]+)/i);
            if (metaCharsetMatch) {
                encoding = metaCharsetMatch[1].toLowerCase();
                console.log(`Encoding from meta charset tag: ${encoding}`);
            }

            // Look for <meta http-equiv="Content-Type" content="...charset=...">
            if (!encoding) {
                const httpEquivMatch = preview.match(/<meta[^>]+http-equiv=["']?content-type["']?[^>]+content=["']?[^"'>]*charset=([^"'\s>]+)/i);
                if (httpEquivMatch) {
                    encoding = httpEquivMatch[1].toLowerCase();
                    console.log(`Encoding from http-equiv meta tag: ${encoding}`);
                }
            }
        }

        // Step 3: Auto-detect encoding if still unknown (especially important for Japanese sites)
        if (!encoding) {
            const detected = jschardet.detect(buffer);
            if (detected && detected.encoding && detected.confidence > 0.7) {
                encoding = detected.encoding.toLowerCase();
                console.log(`Auto-detected encoding: ${encoding} (confidence: ${(detected.confidence * 100).toFixed(1)}%)`);
            }
        }

        // Step 4: Normalize encoding names and use fallbacks
        if (encoding) {
            // Normalize common encoding aliases
            const encodingMap = {
                'shift_jis': 'shift_jis',
                'shift-jis': 'shift_jis',
                'sjis': 'shift_jis',
                'x-sjis': 'shift_jis',
                'euc-jp': 'euc-jp',
                'eucjp': 'euc-jp',
                'iso-2022-jp': 'iso-2022-jp',
                'utf-8': 'utf8',
                'utf8': 'utf8'
            };

            encoding = encodingMap[encoding] || encoding;

            // Try to decode with detected encoding
            if (iconv.encodingExists(encoding)) {
                const decoded = iconv.decode(buffer, encoding);
                console.log(`✓ Successfully decoded content using ${encoding}`);
                return decoded;
            } else {
                console.warn(`⚠️  Encoding '${encoding}' not supported by iconv-lite, falling back to UTF-8`);
            }
        }

        // Step 5: Default fallback to UTF-8
        console.log('Using UTF-8 as fallback encoding');
        return buffer.toString('utf8');

    } catch (error) {
        console.error('Error during encoding detection/decoding:', error.message);
        // Final fallback: UTF-8
        return buffer.toString('utf8');
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

            // Check PDF size limit (20 MB = 20,971,520 bytes)
            const contentLength = response.headers.get('content-length');
            const MAX_PDF_SIZE = 20 * 1024 * 1024; // 20 MB

            if (contentLength) {
                const sizeBytes = parseInt(contentLength, 10);
                const sizeMB = (sizeBytes / 1024 / 1024).toFixed(2);

                if (sizeBytes > MAX_PDF_SIZE) {
                    console.warn(`⚠️  PDF too large (${sizeMB} MB > 20 MB), skipping: ${url}`);
                    return `[PDF file is too large (${sizeMB} MB). Files over 20 MB cannot be processed due to memory constraints. Please review this product manually.]`;
                }

                console.log(`PDF size: ${sizeMB} MB (within 20 MB limit)`);
            } else {
                console.warn(`⚠️  No Content-Length header for PDF, proceeding with caution: ${url}`);
            }

            const pdfBuffer = Buffer.from(await response.arrayBuffer());
            return await extractPDFText(pdfBuffer, url);
        }

        // Handle text files with proper encoding
        if (contentType.includes('text/plain') || isTextFile) {
            console.log(`Detected text file (Content-Type: ${contentType}): ${url}`);
            const buffer = Buffer.from(await response.arrayBuffer());
            const text = decodeWithProperEncoding(buffer, contentType);
            return text; // No truncation - let website handle it
        }

        // Handle HTML with proper encoding detection
        console.log(`Fetching HTML content from: ${url}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        const html = decodeWithProperEncoding(buffer, contentType);
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
                    // Adaptive retry delay: If we're about to restart (shutting down), use longer delay
                    // This gives the callback endpoint time to complete any in-flight operations
                    const baseBackoffMs = 1000 * Math.pow(2, attempt); // 2s, 4s, 8s
                    const backoffMs = isShuttingDown ? baseBackoffMs + 3000 : baseBackoffMs; // Add 3s during shutdown

                    console.log(`Retrying callback in ${backoffMs}ms${isShuttingDown ? ' (restart pending)' : ''}...`);
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
                const baseBackoffMs = 1000 * Math.pow(2, attempt); // 2s, 4s, 8s
                const backoffMs = isShuttingDown ? baseBackoffMs + 3000 : baseBackoffMs; // Add 3s during shutdown

                console.log(`Retrying callback in ${backoffMs}ms${isShuttingDown ? ' (restart pending)' : ''}...`);
                await new Promise(resolve => setTimeout(resolve, backoffMs));
            }
        }
    }
}

// Helper: Schedule process restart if memory limit reached
function scheduleRestartIfNeeded() {
    if (shouldRestartDueToMemory()) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`🔄 MEMORY LIMIT REACHED - RESTARTING`);
        console.log(`Current memory: ${getMemoryUsageMB().rss}MB RSS`);
        console.log(`Scheduling graceful restart in 2 seconds to free memory...`);
        console.log(`${'='.repeat(60)}\n`);

        // Set shutdown flag to reject new requests
        isShuttingDown = true;

        // Give time for response to be sent, then exit
        // Render will automatically restart the service
        setTimeout(() => {
            console.log('Exiting process for restart...');
            console.log(`Total requests processed before restart: ${requestCount}`);
            process.exit(0);
        }, 2000);
    }
}

// Health check endpoint
app.get('/health', (req, res) => {
    const memory = getMemoryUsageMB();
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        memory: {
            rss: memory.rss,
            heapUsed: memory.heapUsed,
            heapTotal: memory.heapTotal,
            limit: MEMORY_LIMIT_MB,
            warning: MEMORY_WARNING_MB,
            percentUsed: Math.round((memory.rss / MEMORY_LIMIT_MB) * 100)
        },
        requestCount: requestCount,
        isShuttingDown: isShuttingDown
    });
});

// Status endpoint (includes shutdown state)
app.get('/status', (req, res) => {
    const memory = getMemoryUsageMB();
    res.json({
        status: isShuttingDown ? 'shutting_down' : 'ok',
        requestCount: requestCount,
        memoryMB: memory.rss,
        memoryLimitMB: MEMORY_LIMIT_MB,
        timestamp: new Date().toISOString()
    });
});

// Middleware: Reject new scraping requests during shutdown
app.use((req, res, next) => {
    if (isShuttingDown && ['/scrape', '/scrape-keyence'].includes(req.path)) {
        console.log(`Rejecting ${req.path} request during shutdown`);
        return res.status(503).json({
            error: 'Service restarting',
            retryAfter: 30  // seconds
        });
    }
    next();
});

// Main scraping endpoint
app.post('/scrape', async (req, res) => {
    const { url, callbackUrl, jobId, urlIndex, title, snippet, extractionMode, model, jpProxyUrl, usProxyUrl, extractOnly } = req.body;

    // Check shutdown state before processing
    if (isShuttingDown) {
        console.log(`Rejecting /scrape request during shutdown (current memory: ${getMemoryUsageMB().rss}MB)`);
        return res.status(503).json({
            error: 'Service restarting due to memory limit',
            retryAfter: 30
        });
    }

    // Increment request counter and track memory
    requestCount++;
    const memBefore = trackMemoryUsage(`request_start_${requestCount}`);
    console.log(`[${new Date().toISOString()}] Request #${requestCount} - Memory: ${memBefore.rss}MB RSS`);

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    // Check if memory is already too high before starting scrape
    if (shouldRestartDueToMemory()) {
        console.error(`⚠️  Memory too high (${memBefore.rss}MB), forcing restart instead of scraping`);

        // Send error callback
        await sendCallback(callbackUrl, {
            jobId,
            urlIndex,
            content: `[Scraping skipped - service restarting due to high memory usage (${memBefore.rss}MB)]`,
            title: null,
            snippet,
            url
        });

        // Schedule restart
        scheduleRestartIfNeeded();

        return res.status(503).json({
            success: false,
            error: 'Service restarting due to high memory',
            memoryMB: memBefore.rss
        });
    }

    console.log(`[${new Date().toISOString()}] Scraping URL: ${url}`);
    if (callbackUrl) {
        console.log(`Callback URL provided: ${callbackUrl}`);
    }

    try {
        // Try fast fetch first (handles PDFs, text files, and simple HTML)
        console.log(`Attempting fast fetch for ${url}...`);
        let fastResult = await tryFastFetch(url);

        if (fastResult) {
            console.log(`[${new Date().toISOString()}] Fast fetch successful: ${url}`);
            console.log(`Content length: ${fastResult.length} characters`);

            // FIX #4: Detect empty/invalid content
            let finalContent = fastResult;
            if (!fastResult || fastResult.length < 50) {
                console.warn(`⚠️  Empty or invalid content (${fastResult ? fastResult.length : 0} chars), adding explanation`);
                finalContent = `[The website could not be scraped - received only ${fastResult ? fastResult.length : 0} characters. The site may be blocking automated access or the page may be empty.]`;
            }

            const result = {
                success: true,
                url: url,
                title: null,
                content: finalContent,
                contentLength: finalContent.length,
                method: 'fast_fetch',
                timestamp: new Date().toISOString()
            };

            // Send callback unconditionally
            await sendCallback(callbackUrl, {
                jobId,
                urlIndex,
                content: finalContent,
                title: null,
                snippet,
                url
            });

            // MEMORY CLEANUP: Force GC and null out large variables
            fastResult = null;
            finalContent = null;
            forceGarbageCollection();

            // Track memory after cleanup
            trackMemoryUsage(`request_complete_${requestCount}_fast_fetch`);

            // Schedule restart if memory limit reached
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
                '--disable-blink-features=AutomationControlled',
                // MEMORY OPTIMIZATIONS (prevent OOM on 512MB limit)
                '--single-process', // Run in single process to reduce overhead
                '--disable-features=site-per-process', // Reduce process isolation overhead
                '--js-flags=--max-old-space-size=256', // Limit V8 heap to 256MB
                '--disable-web-security', // Disable CORS (reduces memory for cross-origin checks)
                '--disable-features=IsolateOrigins', // Reduce memory isolation
                '--disable-site-isolation-trials' // Further reduce isolation overhead
            ],
            timeout: 120000 // 2 minutes
        });

        const page = await browser.newPage();

        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );

        // MEMORY OPTIMIZATION: Reduce viewport size to save rendering memory
        await page.setViewport({ width: 1280, height: 720 });

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

        // FIX #4: Detect empty/invalid content from Puppeteer
        let finalContent = content;
        if (!content || content.length < 50) {
            console.warn(`⚠️  Empty or invalid Puppeteer content (${content ? content.length : 0} chars), adding explanation`);
            finalContent = `[The website could not be scraped - Puppeteer extracted only ${content ? content.length : 0} characters. The site may require authentication, use anti-bot protection, or be temporarily unavailable.]`;
        }

        const result = {
            success: true,
            url: url,
            title: pageTitle,
            content: finalContent,
            contentLength: finalContent.length,
            method: 'puppeteer',
            timestamp: new Date().toISOString()
        };

        // Close browser IMMEDIATELY to free memory before callback
        await browser.close();
        browser = null;
        console.log('Browser closed, memory freed');

        // Send success callback unconditionally (browser already closed and freed)
        await sendCallback(callbackUrl, {
            jobId,
            urlIndex,
            content: finalContent,
            title: pageTitle,
            snippet,
            url
        });
        callbackSent = true;

        // MEMORY CLEANUP: Null out large variables and force GC
        content = null;
        finalContent = null;
        pageTitle = null;
        forceGarbageCollection();

        // Track memory after cleanup
        trackMemoryUsage(`request_complete_${requestCount}_puppeteer`);

        // Schedule restart if memory limit reached
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

    // Check shutdown state before processing
    if (isShuttingDown) {
        console.log(`Rejecting /scrape-keyence request during shutdown (current memory: ${getMemoryUsageMB().rss}MB)`);
        return res.status(503).json({
            error: 'Service restarting due to memory limit',
            retryAfter: 30
        });
    }

    // Increment request counter and track memory
    requestCount++;
    const memBefore = trackMemoryUsage(`keyence_start_${requestCount}`);
    console.log(`[${new Date().toISOString()}] KEYENCE Search Request #${requestCount} - Memory: ${memBefore.rss}MB RSS`);

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
                '--disable-blink-features=AutomationControlled',
                // MEMORY OPTIMIZATIONS for KEYENCE (prevent OOM on 512MB limit)
                '--single-process', // Run in single process to reduce overhead
                '--disable-features=site-per-process', // Reduce process isolation overhead
                '--js-flags=--max-old-space-size=256', // Limit V8 heap to 256MB
                '--disable-web-security', // Disable CORS (reduces memory for cross-origin checks)
                '--disable-features=IsolateOrigins', // Reduce memory isolation
                '--disable-site-isolation-trials' // Further reduce isolation overhead
            ],
            timeout: 120000
        });

        const page = await browser.newPage();

        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );

        // MEMORY OPTIMIZATION: Reduce viewport size to save rendering memory
        await page.setViewport({ width: 1280, height: 720 });

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

            // MEMORY OPTIMIZATION: Block images, media, and fonts to reduce memory usage
            if (['image', 'media', 'font'].includes(resourceType)) {
                request.abort();
                return;
            }

            // Block third-party analytics/tracking domains
            const isBlockedDomain = blockedDomains.some(domain => url.includes(domain));
            if (isBlockedDomain) {
                request.abort();
                return;
            }

            // Allow everything else (CSS/JS needed for KEYENCE functionality)
            request.continue();
        });
        console.log('Resource blocking: images, media, fonts, and analytics blocked; CSS/JS allowed for KEYENCE');

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

        // Press Enter and wait for navigation - with aggressive timeout to save memory
        try {
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }), // Reduced from 30s
                page.keyboard.press('Enter')
            ]);
            console.log('Navigation completed successfully');
        } catch (navError) {
            // Navigation timeout - but page might have loaded anyway
            console.log(`Navigation timeout (${navError.message}), checking if page loaded...`);
            // Reduce settle time from 2s to 1s to close browser faster
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        // Get the final URL after navigation
        const finalUrl = page.url();
        console.log(`Final page URL: ${finalUrl}`);

        // CRITICAL MEMORY FIX: Extract text directly in browser context instead of loading full HTML
        // This prevents transferring massive HTML strings to Node.js (saves 90%+ memory)
        console.log('Extracting text content (in-browser method)...');

        let text, title;
        try {
            // Race extraction against timeout to prevent hanging
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

            text = result.text || '';
            title = result.title || '';

            console.log(`✓ Extracted ${text.length} characters from KEYENCE page (memory-efficient method)`);
        } catch (extractionError) {
            console.error(`Content extraction failed: ${extractionError.message}`);
            // Fallback to empty content rather than crashing
            text = `[Content extraction failed: ${extractionError.message}]`;
            title = 'KEYENCE';
        }

        // FIX #4: Detect empty/invalid content from KEYENCE
        let finalContent = text;
        if (!text || text.length < 50) {
            console.warn(`⚠️  Empty or invalid KEYENCE content (${text ? text.length : 0} chars), adding explanation`);
            finalContent = `[KEYENCE search extracted only ${text ? text.length : 0} characters. The search may have returned no results, the page may be unavailable, or the site may be blocking automated access.]`;
        }

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

        // Close browser IMMEDIATELY to free memory before callback
        await browser.close();
        browser = null;
        console.log('Browser closed, memory freed');

        // Send callback unconditionally (browser already closed)
        if (callbackUrl) {
            await sendCallback(callbackUrl, {
                jobId,
                urlIndex,
                content: finalContent,
                title: title,
                snippet: `KEYENCE search result for ${model}`,
                url: finalUrl
            });
            callbackSent = true;
        }

        // MEMORY CLEANUP: Null out large variables and force GC
        text = null;
        finalContent = null;
        title = null;
        forceGarbageCollection();

        // Track memory after cleanup
        trackMemoryUsage(`keyence_complete_${requestCount}`);

        // KEYENCE searches use more memory - check if we should restart
        scheduleRestartIfNeeded();

        return res.json(keyenceResult);

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
            isShuttingDown = true;
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

// IDEC dual-site scraping endpoint
// Tries JP site first, then US site if no match found
app.post('/scrape-idec-dual', async (req, res) => {
    const { model, callbackUrl, jobId, urlIndex, title, snippet, jpProxyUrl, usProxyUrl, jpUrl, usUrl } = req.body;

    // Check shutdown state before processing
    if (isShuttingDown) {
        console.log(`Rejecting /scrape-idec-dual request during shutdown (current memory: ${getMemoryUsageMB().rss}MB)`);
        return res.status(503).json({
            error: 'Service restarting due to memory limit',
            retryAfter: 30
        });
    }

    // Increment request counter and track memory
    requestCount++;
    const memBefore = trackMemoryUsage(`idec_dual_start_${requestCount}`);
    console.log(`[${new Date().toISOString()}] IDEC Dual-Site Request #${requestCount} - Memory: ${memBefore.rss}MB RSS`);

    if (!model || !jpProxyUrl || !usProxyUrl || !jpUrl || !usUrl) {
        return res.status(400).json({ error: 'model, jpProxyUrl, usProxyUrl, jpUrl, and usUrl are required' });
    }

    console.log(`[${new Date().toISOString()}] IDEC Dual-Site: Searching for model: ${model}`);
    if (callbackUrl) {
        console.log(`Callback URL provided: ${callbackUrl}`);
    }

    // Helper function to parse proxy URL and extract credentials
    function parseProxyUrl(proxyUrl) {
        try {
            const url = new URL(proxyUrl);
            return {
                server: `${url.hostname}:${url.port}`,
                username: url.username || null,
                password: url.password || null
            };
        } catch (error) {
            console.error(`Failed to parse proxy URL: ${error.message}`);
            return null;
        }
    }

    // Helper function to extract IDEC product URL from search results
    async function extractIdecProductUrl(page, model) {
        try {
            // Wait for search results to load
            await page.waitForSelector('.listing__elements', { timeout: 5000, visible: true });
            console.log('IDEC search results loaded, extracting product URLs...');

            // Extract product URL matching the model
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

    // Helper function to scrape a single IDEC site (JP or US)
    async function scrapeIdecSite(siteUrl, proxyUrl, siteName) {
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
            const launchArgs = [
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
                '--single-process',
                '--disable-features=site-per-process',
                '--js-flags=--max-old-space-size=256',
                '--disable-web-security',
                '--disable-features=IsolateOrigins',
                '--disable-site-isolation-trials',
                `--proxy-server=${proxyConfig.server}`
            ];

            console.log(`Launching browser with ${siteName} proxy...`);
            browser = await puppeteer.launch({
                headless: 'new',
                args: launchArgs,
                timeout: 120000
            });
            console.log(`Browser launched successfully with ${siteName} proxy`);

            const page = await browser.newPage();

            // Set up proxy authentication if credentials exist
            if (proxyConfig.username && proxyConfig.password) {
                await page.authenticate({
                    username: proxyConfig.username,
                    password: proxyConfig.password
                });
                console.log(`Proxy authentication configured for ${siteName} proxy`);
            }

            await page.setUserAgent(
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            );

            await page.setViewport({ width: 1280, height: 720 });

            // Enable resource blocking to save memory
            await page.setRequestInterception(true);
            page.on('request', (request) => {
                const resourceType = request.resourceType();
                if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
                    request.abort();
                } else {
                    request.continue();
                }
            });

            // Navigate to IDEC search page
            console.log(`Navigating to ${siteName} search page: ${siteUrl}`);
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

            // Found exact match! Build full product URL
            const productUrl = extractionResult.url.startsWith('http')
                ? extractionResult.url
                : `https://${siteName === 'JP' ? 'jp' : 'us'}.idec.com${extractionResult.url}`;

            console.log(`✓ Found exact match on ${siteName} site: ${productUrl}`);

            // Close search browser
            await browser.close();
            browser = null;

            // Now scrape the product page with the same proxy
            console.log(`Scraping product page: ${productUrl}`);
            browser = await puppeteer.launch({
                headless: 'new',
                args: launchArgs,
                timeout: 120000
            });

            const productPage = await browser.newPage();

            // Set up proxy authentication again
            if (proxyConfig.username && proxyConfig.password) {
                await productPage.authenticate({
                    username: proxyConfig.username,
                    password: proxyConfig.password
                });
            }

            await productPage.setUserAgent(
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            );

            await productPage.setViewport({ width: 1280, height: 720 });

            // Enable resource blocking
            await productPage.setRequestInterception(true);
            productPage.on('request', (request) => {
                const resourceType = request.resourceType();
                if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
                    request.abort();
                } else {
                    request.continue();
                }
            });

            // Navigate to product page
            await productPage.goto(productUrl, {
                waitUntil: 'networkidle2',
                timeout: 45000
            });

            // Wait for content to render
            await new Promise(resolve => setTimeout(resolve, 3000));

            // Extract content
            const content = await productPage.evaluate(() => {
                const scripts = document.querySelectorAll('script, style, noscript');
                scripts.forEach(script => script.remove());
                return document.body.innerText;
            });

            const pageTitle = await productPage.title();

            console.log(`✓ Product page scraped from ${siteName} site: ${content.length} characters`);

            // Close browser
            await browser.close();
            browser = null;

            return {
                success: true,
                content: content,
                title: pageTitle,
                url: productUrl,
                site: siteName
            };

        } catch (error) {
            console.error(`Error scraping ${siteName} site: ${error.message}`);
            if (browser) {
                try {
                    await browser.close();
                } catch (closeErr) {
                    console.error(`Failed to close browser for ${siteName} site: ${closeErr.message}`);
                }
            }
            return { success: false, error: error.message };
        }
    }

    // Enqueue this task to prevent concurrent browser instances
    return enqueuePuppeteerTask(async () => {
        let callbackSent = false;

        try {
            // Try JP site first
            const jpResult = await scrapeIdecSite(jpUrl, jpProxyUrl, 'JP');

            if (jpResult.success) {
                // JP site succeeded - send callback with content
                console.log(`✓ IDEC JP site succeeded, sending callback`);
                await sendCallback(callbackUrl, {
                    jobId,
                    urlIndex,
                    content: jpResult.content,
                    title: jpResult.title,
                    snippet: `IDEC product page (JP site)`,
                    url: jpResult.url
                });
                callbackSent = true;

                // Clean up and return
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
            const usResult = await scrapeIdecSite(usUrl, usProxyUrl, 'US');

            if (usResult.success) {
                // US site succeeded - send callback with content
                console.log(`✓ IDEC US site succeeded, sending callback`);
                await sendCallback(callbackUrl, {
                    jobId,
                    urlIndex,
                    content: usResult.content,
                    title: usResult.title,
                    snippet: `IDEC product page (US site)`,
                    url: usResult.url
                });
                callbackSent = true;

                // Clean up and return
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

            // Both sites failed - send callback with placeholder
            console.log(`Both JP and US sites failed, sending placeholder`);
            const placeholderMessage = '[No results found for this product on the manufacturer website (searched both JP and US sites)]';

            await sendCallback(callbackUrl, {
                jobId,
                urlIndex,
                content: placeholderMessage,
                title: null,
                snippet: 'IDEC search - no results',
                url: jpUrl // Use JP URL as reference
            });
            callbackSent = true;

            // Clean up and return
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

            // Send error callback if not already sent
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

            // Clean up
            forceGarbageCollection();
            trackMemoryUsage(`idec_dual_complete_${requestCount}_error`);
            scheduleRestartIfNeeded();

            return res.status(500).json({
                success: false,
                error: error.message,
                model: model
            });
        }
    }); // End of enqueuePuppeteerTask
});

// NBK product page scraping endpoint with Japanese proxy
app.post('/scrape-nbk', async (req, res) => {
    const { productUrl, callbackUrl, jobId, urlIndex, title, snippet, jpProxyUrl } = req.body;

    // Check shutdown state before processing
    if (isShuttingDown) {
        console.log(`Rejecting /scrape-nbk request during shutdown (current memory: ${getMemoryUsageMB().rss}MB)`);
        return res.status(503).json({
            error: 'Service restarting due to memory limit',
            retryAfter: 30
        });
    }

    // Increment request counter and track memory
    requestCount++;
    const memBefore = trackMemoryUsage(`nbk_start_${requestCount}`);
    console.log(`[${new Date().toISOString()}] NBK Product Page Request #${requestCount} - Memory: ${memBefore.rss}MB RSS`);

    if (!productUrl || !jpProxyUrl) {
        return res.status(400).json({ error: 'productUrl and jpProxyUrl are required' });
    }

    console.log(`[${new Date().toISOString()}] NBK: Scraping product page: ${productUrl}`);
    if (callbackUrl) {
        console.log(`Callback URL provided: ${callbackUrl}`);
    }

    // Respond immediately to avoid timeout
    res.status(200).json({
        success: true,
        message: 'NBK product page scraping started',
        productUrl: productUrl
    });

    // Helper function to parse proxy URL
    function parseProxyUrl(proxyUrl) {
        try {
            const url = new URL(proxyUrl);
            return {
                server: `${url.hostname}:${url.port}`,
                username: url.username || null,
                password: url.password || null
            };
        } catch (error) {
            console.error(`Failed to parse proxy URL: ${error.message}`);
            return null;
        }
    }

    // Enqueue Puppeteer task to run asynchronously
    enqueuePuppeteerTask(async () => {
        let browser = null;
        let callbackSent = false;

        try {
            const proxyConfig = parseProxyUrl(jpProxyUrl);
            if (!proxyConfig) {
                throw new Error('Failed to parse JP proxy URL');
            }

            console.log(`NBK: Launching browser with JP proxy: ${proxyConfig.server}`);

            browser = await puppeteer.launch({
                headless: 'new',
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    `--proxy-server=${proxyConfig.server}`,
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
                    '--single-process',
                    '--disable-features=site-per-process',
                    '--js-flags=--max-old-space-size=256',
                    '--disable-web-security',
                    '--disable-features=IsolateOrigins',
                    '--disable-site-isolation-trials'
                ],
                timeout: 120000
            });

            const page = await browser.newPage();

            // Set proxy authentication if provided
            if (proxyConfig.username && proxyConfig.password) {
                console.log('NBK: Setting proxy authentication');
                await page.authenticate({
                    username: proxyConfig.username,
                    password: proxyConfig.password
                });
            }

            await page.setUserAgent(
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            );

            await page.setViewport({ width: 1280, height: 720 });

            // Enable request interception to block heavy resources
            await page.setRequestInterception(true);

            page.on('request', (request) => {
                const resourceType = request.resourceType();
                if (['image', 'media', 'font'].includes(resourceType)) {
                    request.abort();
                    return;
                }
                request.continue();
            });

            console.log(`NBK: Navigating to product page: ${productUrl}`);
            await page.goto(productUrl, {
                waitUntil: 'networkidle2',
                timeout: 60000
            });

            console.log('NBK: Product page loaded, extracting content...');

            // Extract page content
            const text = await page.evaluate(() => document.body.innerText || '');
            const finalContent = text.trim();

            console.log(`NBK: Successfully scraped product page (${finalContent.length} characters)`);

            // Close browser before callback
            await browser.close();
            browser = null;

            // Send callback with results
            if (callbackUrl) {
                console.log('NBK: Sending callback...');
                await sendCallback(callbackUrl, {
                    jobId,
                    urlIndex,
                    content: finalContent,
                    title: title || 'NBK Product',
                    snippet: snippet || 'NBK product page',
                    url: productUrl
                });
                callbackSent = true;
            }

            // Memory cleanup
            trackMemoryUsage(`nbk_complete_${requestCount}`);
            scheduleRestartIfNeeded();

            console.log('NBK: Task completed successfully');

        } catch (error) {
            console.error(`NBK scraping error:`, error);

            // Close browser IMMEDIATELY to free memory
            if (browser) {
                try {
                    await browser.close();
                    browser = null;
                    console.log('NBK: Browser closed after error');
                } catch (closeError) {
                    console.error('Error closing browser after NBK scraping error:', closeError);
                }
            }

            // Send error callback if not already sent
            if (callbackUrl && !callbackSent) {
                await sendCallback(callbackUrl, {
                    jobId,
                    urlIndex,
                    content: `[NBK product page scraping failed: ${error.message}]`,
                    title: null,
                    snippet: snippet || '',
                    url: productUrl
                });
            }

            console.log('NBK check failed - scheduling restart');
            scheduleRestartIfNeeded();

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
