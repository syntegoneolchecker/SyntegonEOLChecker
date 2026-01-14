// Initialize EOL check job - Search with SerpAPI and save URLs
const { createJob, saveJobUrls, saveFinalResult, saveUrlResult } = require('./lib/job-storage');
const { validateInitializeJob, sanitizeString } = require('./lib/validators');
const { scrapeWithBrowserQL } = require('./lib/browserql-scraper');
const { getJson } = require('serpapi');
const pdfParse = require('pdf-parse');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const logger = require('./lib/logger');
const config = require('./lib/config');
const { errorResponse, validationErrorResponse } = require('./lib/response-builder');

/**
 * Check if URL is a PDF
 */
function isPdfUrl(url) {
    const urlLower = url.toLowerCase();
    return urlLower.endsWith('.pdf') || urlLower.includes('/pdf/') || urlLower.includes('data_pdf');
}

/**
 * Extract text from PDF using pdfjs-dist (better CJK support)
 * Matches the fallback extraction logic used by Render service
 * @param {Buffer} pdfBuffer - PDF file buffer
 * @param {string} url - URL of the PDF (for logging)
 * @returns {Promise<string>} Extracted text
 */
async function extractWithPdfjsDist(pdfBuffer, url) {
    logger.info(`[PDF-SCREEN] Trying pdfjs-dist extraction for ${url}`);

    const loadingTask = pdfjsLib.getDocument({ data: pdfBuffer });
    const doc = await loadingTask.promise;

    const maxPages = Math.min(config.PDF_SCREENING_MAX_PAGES, doc.numPages);
    let fullText = '';

    for (let i = 1; i <= maxPages; i++) {
        const page = await doc.getPage(i);
        const textContent = await page.getTextContent();
        const pageText = textContent.items
            .map(item => item.str)
            .join(' ');
        fullText += pageText + ' ';
    }

    return fullText.replaceAll(/\s+/g, ' ').trim();
}

/**
 * Quick PDF text extraction check
 * Uses same library fallback chain as Render: pdf-parse → pdfjs-dist
 * This ensures screening accurately predicts whether extraction will succeed
 * @returns {Promise<{success: boolean, charCount: number, error?: string}>}
 */
async function quickPdfTextCheck(pdfUrl) {
    try {
        const response = await fetch(pdfUrl, {
            signal: AbortSignal.timeout(config.PDF_SCREENING_TIMEOUT_MS),
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; EOLChecker/1.0)' }
        });

        if (!response.ok) {
            return { success: false, charCount: 0, error: `HTTP ${response.status}` };
        }

        const contentType = response.headers.get('content-type');
        if (!contentType?.includes('pdf')) {
            return { success: false, charCount: 0, error: `Not a PDF (Content-Type: ${contentType})` };
        }

        const contentLength = response.headers.get('content-length');
        if (contentLength && parseInt(contentLength) > config.PDF_SCREENING_MAX_SIZE_MB * 1024 * 1024) {
            return {
                success: false,
                charCount: 0,
                error: `PDF too large (${(parseInt(contentLength) / 1024 / 1024).toFixed(1)}MB, max ${config.PDF_SCREENING_MAX_SIZE_MB}MB)`
            };
        }

        const buffer = await response.arrayBuffer();
        const pdfBuffer = Buffer.from(buffer);

        // Try pdf-parse first (faster)
        let fullText = '';
        let usedLibrary = '';

        try {
            const data = await pdfParse(pdfBuffer, {
                max: config.PDF_SCREENING_MAX_PAGES
            });
            fullText = data.text.replaceAll(/\s+/g, ' ').trim();

            if (fullText.length > 0) {
                usedLibrary = 'pdf-parse';
                logger.info(`[PDF-SCREEN] ✓ pdf-parse extracted ${fullText.length} chars`);
                return { success: true, charCount: fullText.length };
            }

            logger.info(`[PDF-SCREEN] pdf-parse extracted 0 characters, trying pdfjs-dist fallback...`);
        } catch (parseError) {
            logger.info(`[PDF-SCREEN] pdf-parse failed: ${parseError.message}, trying pdfjs-dist fallback...`);
        }

        // Fallback to pdfjs-dist (better CJK support)
        try {
            fullText = await extractWithPdfjsDist(pdfBuffer, pdfUrl);

            if (fullText.length === 0) {
                logger.warn(`[PDF-SCREEN] pdfjs-dist also extracted 0 characters`);
                return {
                    success: false,
                    charCount: 0,
                    error: 'No extractable text (both pdf-parse and pdfjs-dist failed)'
                };
            }

            usedLibrary = 'pdfjs-dist';
            logger.info(`[PDF-SCREEN] ✓ pdfjs-dist extracted ${fullText.length} chars`);
            return { success: true, charCount: fullText.length };

        } catch (pdfjsError) {
            logger.error(`[PDF-SCREEN] pdfjs-dist extraction failed: ${pdfjsError.message}`);

            // If both failed and got 0 chars, reject the PDF
            if (fullText.length === 0) {
                return {
                    success: false,
                    charCount: 0,
                    error: 'No extractable text (both libraries failed)'
                };
            }

            throw pdfjsError;
        }

    } catch (error) {
        if (error.name === 'AbortError') {
            return { success: false, charCount: 0, error: 'Timeout during PDF download' };
        }
        return { success: false, charCount: 0, error: error.message };
    }
}

/**
 * Screen a single URL to check if it's accessible
 * @returns {Promise<{valid: boolean, type: string, reason: string, charCount?: number}>}
 */
async function screenUrl(urlInfo) {
    const { link: url, title } = urlInfo;

    if (!isPdfUrl(url)) {
        return {
            valid: true,
            type: 'html',
            reason: 'Non-PDF URL, will scrape as HTML'
        };
    }

    // It's a PDF - attempt to extract text
    logger.info(`[PDF-SCREEN] Checking PDF: ${title || url}`);
    const result = await quickPdfTextCheck(url);

    if (result.success && result.charCount >= config.PDF_SCREENING_MIN_CHARS) {
        return {
            valid: true,
            type: 'pdf',
            charCount: result.charCount,
            reason: `PDF with ${result.charCount} extractable characters`
        };
    } else if (result.success && result.charCount < config.PDF_SCREENING_MIN_CHARS) {
        return {
            valid: false,
            type: 'pdf',
            reason: `PDF has only ${result.charCount} characters (min ${config.PDF_SCREENING_MIN_CHARS})`
        };
    } else {
        return {
            valid: false,
            type: 'pdf',
            reason: result.error || 'PDF text extraction failed'
        };
    }
}

/**
 * Screen and select valid URLs with PDF checking
 * @returns {Promise<Array>} Array of valid URLs
 */
async function screenAndSelectUrls(candidateUrls, maxUrls = 2) {
    logger.info(`[PDF-SCREEN] Starting URL screening: ${candidateUrls.length} candidates, need ${maxUrls} valid URLs`);

    const validUrls = [];
    let attemptedCount = 0;

    for (const urlInfo of candidateUrls) {
        if (validUrls.length >= maxUrls) break;
        attemptedCount++;

        logger.info(`[PDF-SCREEN] URL ${attemptedCount}/${candidateUrls.length}: ${urlInfo.link}`);

        const screenResult = await screenUrl(urlInfo);

        if (screenResult.valid) {
            validUrls.push(urlInfo);
            logger.info(`[PDF-SCREEN] → Result: PASS ✓ (${screenResult.reason})`);
        } else {
            logger.info(`[PDF-SCREEN] → Result: FAIL ✗ (${screenResult.reason})`);
            logger.info(`[PDF-SCREEN] Trying next URL from search results...`);
        }
    }

    if (validUrls.length < maxUrls) {
        logger.warn(`[PDF-SCREEN] Only found ${validUrls.length}/${maxUrls} valid URLs after screening ${attemptedCount} candidates`);
    } else {
        logger.info(`[PDF-SCREEN] Screening complete: ${validUrls.length}/${maxUrls} valid URLs found after checking ${attemptedCount} candidates`);
    }

    return validUrls;
}

/**
 * Get manufacturer-specific direct URL if available
 * Returns null if manufacturer requires SerpAPI search
 * Returns object with { url, scrapingMethod } if direct URL available
 * scrapingMethod: 'render' (default Puppeteer) or 'browserql' (for Cloudflare-protected sites)
 */
function getManufacturerUrl(maker, model) {
    const normalizedMaker = maker.trim();
    const encodedModel = encodeURIComponent(model.trim());

    switch(normalizedMaker) {
        case 'SMC':
            return {
                url: `https://www.smcworld.com/webcatalog/s3s/ja-jp/detail/?partNumber=${encodedModel}`,
                scrapingMethod: 'render'
            };

        case 'ORIENTAL MOTOR':
            return {
                url: `https://www.orientalmotor.co.jp/ja/products/products-search/replacement?hinmei=${encodedModel}`,
                scrapingMethod: 'browserql' // Use BrowserQL for Cloudflare-protected site
            };

        case 'MISUMI':
            return {
                url: `https://jp.misumi-ec.com/vona2/result/?Keyword=${encodedModel}`,
                scrapingMethod: 'render'
            };

        case 'NTN':
            return {
                url: `https://www.motion.com/products/search;q=${encodedModel};facet_attributes.MANUFACTURER_NAME=NTN`,
                scrapingMethod: 'browserql',
                requiresValidation: true // Need to check if search returns results
            };

        case 'KEYENCE':
            return {
                url: 'https://www.keyence.co.jp/', // Base URL (actual search is interactive)
                scrapingMethod: 'keyence_interactive', // Special method for interactive search
                model: model // Pass model for interactive search
            };

        case 'TAKIGEN':
            return {
                url: `https://www.takigen.co.jp/search?k=${encodedModel}&d=0`,
                scrapingMethod: 'render',
                requiresValidation: true,
                requiresExtraction: true // Extract product URL from search results
            };

        case 'NISSIN ELECTRONIC':
            return {
                url: `https://nissin-ele.co.jp/product/${encodedModel}`,
                scrapingMethod: 'render',
                requiresValidation: true,
                requires404Check: true // Check if page is 404 (contains "Page not found")
            };

        case 'MURR':
            return {
                url: `https://shop.murrinc.com/index.php?lang=1&cl=search&searchparam=${encodedModel}`,
                scrapingMethod: 'render'
            };

        case 'NBK':
            return {
                url: `https://www.nbk1560.com/search/?q=${encodedModel}&SelectedLanguage=ja-JP&page=1&imgsize=1&doctype=all&sort=0&pagemax=10&htmlLang=ja`,
                scrapingMethod: 'nbk_interactive', // Interactive search with product name preprocessing
                model: model // Pass model for preprocessing (remove 'x' and '-')
            };

        default:
            return null; // No direct URL strategy - use SerpAPI search
    }
}

/**
 * Fetch HTML directly via HTTP (for simple pages that don't need JavaScript rendering)
 */
async function fetchHtml(url) {
    logger.info(`Fetching HTML via HTTP: ${url}`);

    const response = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
    });

    if (!response.ok) {
        throw new Error(`HTTP error: ${response.status}`);
    }

    const html = await response.text();
    logger.info(`Fetched HTML successfully: ${html.length} characters`);

    return html;
}

/**
 * Check if content indicates "no search results" on motion.com
 * Returns true if no results found, false if results exist
 */
function hasNoSearchResults(content) {
    if (!content) return true;

    const lowerContent = content.toLowerCase();

    // Common "no results" patterns
    const noResultsPatterns = [
        'no results for:'      // motion.com specific pattern
    ];

    for (const pattern of noResultsPatterns) {
        if (lowerContent.includes(pattern)) {
            logger.info(`Detected "no results" pattern: "${pattern}"`);
            return true;
        }
    }

    return false;
}

/**
 * Check if content indicates a 404 page
 * Returns true if 404 page detected, false otherwise
 */
function is404Page(content) {
    if (!content) return false;

    const lowerContent = content.toLowerCase();

    // 404 patterns
    const notFoundPatterns = [
        'page not found',
        'ページが見つかりません',
        '404 not found',
        '404 error'
    ];

    for (const pattern of notFoundPatterns) {
        if (lowerContent.includes(pattern)) {
            logger.info(`Detected 404 pattern: "${pattern}"`);
            return true;
        }
    }

    return false;
}

/**
 * Extract first product URL from Takigen search results HTML
 * Returns the product URL path (e.g., "/products/detail/A-1038/A-1038") or null if not found
 */
function extractTakigenProductUrl(html) {
    if (!html) return null;

    try {
        // Look for the div containing search results with class="p-4 flex flex-wrap flex-col md:flex-row"
        // Extract the first <a> tag's href attribute
        const divPattern = /<div class="p-4 flex flex-wrap flex-col md:flex-row">(.*?)<\/div>/s;
        const divMatch = html.match(divPattern);

        if (!divMatch) {
            logger.info('Takigen search results div not found in HTML');
            return null;
        }

        const divContent = divMatch[1];

        // Extract the first href from an <a> tag
        const hrefPattern = /href="(\/products\/detail\/[^"]+)"/;
        const hrefMatch = divContent.match(hrefPattern);

        if (!hrefMatch) {
            logger.info('No product href found in Takigen search results div');
            return null;
        }

        const productPath = hrefMatch[1];
        logger.info(`Extracted Takigen product path: ${productPath}`);
        return productPath;

    } catch (error) {
        logger.error(`Error extracting Takigen product URL: ${error.message}`);
        return null;
    }
}

exports.handler = async function(event, context) {
    logger.info('Initialize job request');

    // Handle preflight and method validation first
    const preflightResponse = handlePreflightAndMethodValidation(event);
    if (preflightResponse) return preflightResponse;

    try {
        const requestBody = JSON.parse(event.body);

        // Validate input
        const validation = validateInitializeJob(requestBody);
        if (!validation.valid) {
            logger.error('Validation failed:', validation.errors);
            return validationErrorResponse(validation.errors);
        }

        // Sanitize inputs
        const maker = sanitizeString(requestBody.maker, 200);
        const model = sanitizeString(requestBody.model, 200);
        logger.info('Creating job for:', { maker, model });

        // Create job (this also triggers job cleanup internally)
        // Note: Log cleanup is now handled by scheduled-log-cleanup.js
        const jobId = await createJob(maker, model, context);

        // Process manufacturer strategy or fall back to search
        const strategyResult = await processManufacturerStrategy(maker, model, jobId, context);
        if (strategyResult) {
            return strategyResult;
        }

        // Perform SerpAPI search as fallback
        return await performSerpAPISearch(maker, model, jobId, context);

    } catch (error) {
        logger.error('Initialize job error:', error);
        return errorResponse('Internal server error', error.message, 500);
    }
};

// Helper functions
function handlePreflightAndMethodValidation(event) {
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 204,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Allow-Methods': 'POST, OPTIONS'
            },
            body: ''
        };
    }

    if (event.httpMethod !== 'POST') {
        return errorResponse('Method not allowed', null, 405);
    }

    return null;
}

async function processManufacturerStrategy(maker, model, jobId, context) {
    const manufacturerStrategy = getManufacturerUrl(maker, model);

    if (!manufacturerStrategy) {
        return null;
    }

    if (manufacturerStrategy.requiresValidation) {
        return await handleValidationRequiredStrategy(maker, model, jobId, manufacturerStrategy, context);
    } else {
        return await handleDirectUrlStrategy(maker, model, jobId, manufacturerStrategy, context);
    }
}

async function handleValidationRequiredStrategy(maker, model, jobId, strategy, context) {
    logger.info(`URL requires validation for ${maker}: ${strategy.url}`);

    try {
        if (strategy.requiresExtraction) {
            return await handleExtractionStrategy(maker, model, jobId, strategy, context);
        } else if (strategy.requires404Check) {
            return await handle404CheckStrategy(maker, model, jobId, strategy, context);
        } else {
            return await handleStandardValidationStrategy(maker, model, jobId, strategy, context);
        }
    } catch (error) {
        logger.error(`Validation scraping failed for ${maker}: ${error.message}, falling back to SerpAPI search`);
        return null; // Fall through to SerpAPI search
    }
}

async function handleExtractionStrategy(maker, model, jobId, strategy, context) {
    logger.info(`Extracting product URL from ${maker} search results`);

    const searchHtml = await fetchHtml(strategy.url);
    const productPath = extractTakigenProductUrl(searchHtml);

    if (!productPath) {
        logger.info(`No product found in ${maker} search results, falling back to SerpAPI search`);
        return null;
    }

    const productUrl = `https://www.takigen.co.jp${productPath}`;
    logger.info(`Extracted ${maker} product URL: ${productUrl}`);

    const urls = [createUrlEntry(0, productUrl, `${maker} ${model} Product Page`,
        `Direct product page for ${maker} ${model}`, strategy.scrapingMethod)];

    await saveJobUrls(jobId, urls, context);

    logger.info(`Job ${jobId} initialized with extracted ${maker} product URL`);

    return createSuccessResponse(jobId, 'urls_ready', 1, 'takigen_extracted_url', { extractedUrl: productUrl });
}

async function handle404CheckStrategy(maker, model, jobId, strategy, context) {
    logger.info(`Checking for 404 page for ${maker}`);

    const html = await fetchHtml(strategy.url);

    if (is404Page(html)) {
        logger.info(`404 page detected for ${strategy.url}, falling back to SerpAPI search`);
        return null;
    }

    logger.info(`Valid product page found for ${maker} ${model}`);

    const urls = [createUrlEntry(0, strategy.url, `${maker} ${model} Product Page`,
        `Direct product page for ${maker} ${model}`, strategy.scrapingMethod)];

    await saveJobUrls(jobId, urls, context);

    logger.info(`Job ${jobId} initialized with validated ${maker} product URL`);

    return createSuccessResponse(jobId, 'urls_ready', 1, 'nissin_validated_url');
}

async function handleStandardValidationStrategy(maker, model, jobId, strategy, context) {
    const scrapeResult = await scrapeWithBrowserQL(strategy.url);

    if (hasNoSearchResults(scrapeResult.content)) {
        logger.info(`No search results found on ${strategy.url}, falling back to SerpAPI search`);
        return null;
    }

    logger.info(`Search results found on motion.com, using this content for analysis`);

    const urls = [createUrlEntry(0, strategy.url, `${maker} ${model} Search Results`,
        `Search results from motion.com for ${maker} ${model}`, strategy.scrapingMethod)];

    await saveJobUrls(jobId, urls, context);

    await saveUrlResult(jobId, 0, {
        url: strategy.url,
        title: `${maker} ${model} Search Results`,
        snippet: `Search results from motion.com`,
        fullContent: scrapeResult.content
    }, context);

    logger.info(`Job ${jobId} initialized with validated direct URL (content already scraped)`);

    return createSuccessResponse(jobId, 'ready_for_analysis', 1, 'validated_direct_url',
        { contentLength: scrapeResult.content.length });
}

async function handleDirectUrlStrategy(maker, model, jobId, strategy, context) {
    logger.info(`Using direct URL strategy for ${maker}: ${strategy.url} (scraping: ${strategy.scrapingMethod})`);

    const urlEntry = createUrlEntry(0, strategy.url, `${maker} ${model} Product Page`,
        `Direct product page for ${maker} ${model}`, strategy.scrapingMethod);

    // Add optional properties
    if (strategy.model) urlEntry.model = strategy.model;
    if (strategy.jpUrl) urlEntry.jpUrl = strategy.jpUrl;
    if (strategy.usUrl) urlEntry.usUrl = strategy.usUrl;
    if (strategy.fallbackUrl) urlEntry.fallbackUrl = strategy.fallbackUrl;

    const urls = [urlEntry];
    await saveJobUrls(jobId, urls, context);

    logger.info(`Job ${jobId} initialized with direct URL strategy (1 URL, method: ${strategy.scrapingMethod})`);

    return createSuccessResponse(jobId, 'urls_ready', urls.length, 'direct_url',
        { scrapingMethod: strategy.scrapingMethod });
}

/**
 * Check if a URL string ends with the product model name (exact match only)
 * @param {string} url - URL to check
 * @param {string} normalizedModel - Normalized (uppercase) product model
 * @returns {boolean} True if URL string ends with exact model name
 */
function urlEndsWithModel(url, normalizedModel) {
    try {
        // Simple case-insensitive string check: does the URL end with the model name?
        return url.toUpperCase().endsWith(normalizedModel);
    } catch (e) {
        logger.warn(`Failed to check URL for model matching: ${url}`, e.message);
        return false;
    }
}

/**
 * Select best 2 URLs from SerpAPI results using smart prioritization
 * Prioritizes URLs ending with exact product model name
 * @param {Array} serpResults - Array of SerpAPI organic search results
 * @param {string} model - Product model to match
 * @returns {Array} Best 2 URLs selected
 */
function selectBestUrls(serpResults, model) {
    const normalizedModel = model.trim().toUpperCase();

    // Categorize URLs
    const exactMatchUrls = [];
    const regularUrls = [];

    for (const result of serpResults) {
        if (urlEndsWithModel(result.link, normalizedModel)) {
            exactMatchUrls.push(result);
        } else {
            regularUrls.push(result);
        }
    }

        // Log selected URLs for debugging
    serpResults.forEach((result, index) => {
        logger.info(`Found URL Number ${index + 1}: ${result.link}`);
    });

    logger.info(`Smart URL selection: ${exactMatchUrls.length} exact matches, ${regularUrls.length} regular URLs from ${serpResults.length} total`);

    // Select best 2 URLs based on priority
    let selectedResults = [];

    if (exactMatchUrls.length >= 2) {
        // Use first 2 exact matches
        selectedResults = exactMatchUrls.slice(0, 2);
        logger.info(`Selected 2 URLs with exact model match in path`);
    } else if (exactMatchUrls.length === 1) {
        // Use 1 exact match + top 1 from regular
        selectedResults = [exactMatchUrls[0], regularUrls[0]].filter(Boolean);
        logger.info(`Selected 1 exact match + 1 top regular URL`);
    } else {
        // Use top 2 from regular (current behavior)
        selectedResults = regularUrls.slice(0, 2);
        logger.info(`No exact matches found, using top 2 regular URLs`);
    }

    // Log selected URLs for debugging
    selectedResults.forEach((result, index) => {
        logger.info(`Selected URL ${index + 1}: ${result.link}`);
    });

    return selectedResults;
}

function createUrlEntry(index, url, title, snippet, scrapingMethod = null) {
    const entry = {
        index,
        url,
        title,
        snippet
    };

    if (scrapingMethod) {
        entry.scrapingMethod = scrapingMethod;
    }

    return entry;
}

function createSuccessResponse(jobId, status, urlCount, strategy, additionalData = {}) {
    const response = {
        statusCode: 200,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            jobId,
            status,
            urlCount,
            strategy,
            ...additionalData
        })
    };

    return response;
}

async function performSerpAPISearch(maker, model, jobId, context) {
    let searchQuery = `${maker} ${model}`;

    logger.info(`Performing SerpAPI search for ${searchQuery} with sites to search`);

    // Constructing query with sites to search from config
    config.SERPAPI_SITES_TO_SEARCH.forEach(site => searchQuery += ' site:' + site + ' OR');
    searchQuery = searchQuery.slice(0, -3);

    let serpData;
    try {
        // Perform synchronous SerpAPI search
        serpData = await new Promise((resolve, reject) => {
            getJson({
                api_key: process.env.SERPAPI_API_KEY,
                engine: config.SERPAPI_ENGINE,
                q: searchQuery,
                google_domain: config.SERPAPI_GOOGLE_DOMAIN
            }, (json) => {
                if (json.error) {
                    reject(new Error(json.error));
                } else {
                    resolve(json);
                }
            });
        });
    } catch (error) {
        logger.error('SerpAPI error:', error);
        return errorResponse('SerpAPI failed', error.message, 500);
    }

    const organicResults = serpData.organic_results || [];
    logger.info(`SerpAPI returned ${organicResults.length} organic results`);

    if (organicResults.length === 0) {
        return await handleNoSearchResults(maker, model, jobId, context);
    }

    // Smart URL selection: prioritize URLs ending with exact product model
    const selectedResults = selectBestUrls(organicResults, model);

    // Screen URLs for PDF accessibility (replace unreadable PDFs with next best URL)
    const validResults = await screenAndSelectUrls(selectedResults.length >= 2 ? selectedResults : organicResults, 2);

    if (validResults.length === 0) {
        logger.warn('No valid URLs found after PDF screening');
        return await handleNoSearchResults(maker, model, jobId, context);
    }

    const urls = validResults.map((result, index) =>
        createUrlEntry(index, result.link, result.title, result.snippet || '')
    );

    await saveJobUrls(jobId, urls, context);
    logger.info(`Job ${jobId} initialized with ${urls.length} URLs`);

    return createSuccessResponse(jobId, 'urls_ready', urls.length);
}


async function handleNoSearchResults(maker, model, jobId, context) {
    logger.info(`No search results found for ${maker} ${model}`);

    const result = {
        status: 'UNKNOWN',
        explanation: 'No search results found',
        successor: {
            status: 'UNKNOWN',
            model: null,
            explanation: ''
        }
    };

    await saveFinalResult(jobId, result, context);

    return createSuccessResponse(jobId, 'complete', 0, 'no_results',
        { message: 'No search results found' });
}
