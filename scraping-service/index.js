const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');
const pdfParse = require('pdf-parse');

const app = express();
const PORT = process.env.PORT || 3000;

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
function extractHTMLText(html, maxLength = 10000) {
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

    return text.substring(0, maxLength);
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
async function extractPDFText(pdfBuffer, url, maxLength = 10000) {
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

        const truncated = fullText.substring(0, maxLength);
        console.log(`✓ Successfully extracted ${fullText.length} chars from PDF (truncated to ${truncated.length}, ${Math.min(5, data.numpages)} pages)`);

        return truncated;

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
            return await extractPDFText(pdfBuffer, url, 10000);
        }

        // Handle text files
        if (contentType.includes('text/plain') || isTextFile) {
            console.log(`Detected text file (Content-Type: ${contentType}): ${url}`);
            const text = await response.text();
            return text.substring(0, 10000);
        }

        // Handle HTML
        const html = await response.text();
        const text = extractHTMLText(html, 10000);

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

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Main scraping endpoint
app.post('/scrape', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    console.log(`[${new Date().toISOString()}] Scraping URL: ${url}`);

    try {
        // Try fast fetch first (handles PDFs, text files, and simple HTML)
        console.log(`Attempting fast fetch for ${url}...`);
        const fastResult = await tryFastFetch(url);

        if (fastResult) {
            console.log(`[${new Date().toISOString()}] Fast fetch successful: ${url}`);
            console.log(`Content length: ${fastResult.length} characters`);

            return res.json({
                success: true,
                url: url,
                title: null,
                content: fastResult,
                contentLength: fastResult.length,
                method: 'fast_fetch',
                timestamp: new Date().toISOString()
            });
        }

        // Fast fetch failed - check if it's a PDF or text file
        if (isPDFUrl(url) || isTextFileUrl(url)) {
            console.log(`[${new Date().toISOString()}] PDF/text file fetch failed, not attempting Puppeteer`);
            return res.status(500).json({
                success: false,
                error: 'PDF or text file could not be fetched',
                url: url
            });
        }

        // Use Puppeteer for dynamic HTML pages only
        console.log(`Fast fetch failed, using Puppeteer for ${url}...`);
        let browser = null;

        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--disable-gpu'
            ],
            timeout: 60000
        });

        const page = await browser.newPage();

        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );

        await page.setViewport({ width: 1920, height: 1080 });

        await page.goto(url, {
            waitUntil: 'networkidle2',
            timeout: 60000
        });

        await page.waitForTimeout(2000);

        const content = await page.evaluate(() => {
            const scripts = document.querySelectorAll('script, style, noscript');
            scripts.forEach(script => script.remove());
            return document.body.innerText;
        });

        const title = await page.title();

        console.log(`[${new Date().toISOString()}] Successfully scraped with Puppeteer: ${url}`);
        console.log(`Content length: ${content.length} characters`);

        await browser.close();

        res.json({
            success: true,
            url: url,
            title: title,
            content: content,
            contentLength: content.length,
            method: 'puppeteer',
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        console.error(`[${new Date().toISOString()}] Scraping error:`, error.message);

        res.status(500).json({
            success: false,
            error: error.message,
            url: url
        });
    }
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
                            '--disable-gpu'
                        ],
                        timeout: 60000
                    });
                }

                const page = await browser.newPage();

                await page.setUserAgent(
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                );

                await page.setViewport({ width: 1920, height: 1080 });

                await page.goto(url, {
                    waitUntil: 'networkidle2',
                    timeout: 60000
                });

                await page.waitForTimeout(2000);

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
