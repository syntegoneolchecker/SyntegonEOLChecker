// Initialize EOL check job - Search with Tavily and save URLs
const { createJob, saveJobUrls, saveFinalResult, saveUrlResult } = require('./lib/job-storage');
const { cleanupOldLogs } = require('./lib/log-storage');
const { validateInitializeJob, sanitizeString } = require('./lib/validators');
const { scrapeWithBrowserQL } = require('./lib/browserql-scraper');
const { tavily } = require('@tavily/core');
const logger = require('./lib/logger');

/**
 * Get manufacturer-specific direct URL if available
 * Returns null if manufacturer requires Tavily search
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

        case 'オリエンタルモーター':
            return {
                url: `https://www.orientalmotor.co.jp/ja/products/products-search/replacement?hinmei=${encodedModel}`,
                scrapingMethod: 'browserql' // Use BrowserQL for Cloudflare-protected site
            };

        case 'ミスミ':
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

        case 'キーエンス':
            return {
                url: 'https://www.keyence.co.jp/', // Base URL (actual search is interactive)
                scrapingMethod: 'keyence_interactive', // Special method for interactive search
                model: model // Pass model for interactive search
            };

        case 'タキゲン':
            return {
                url: `https://www.takigen.co.jp/search?k=${encodedModel}&d=0`,
                scrapingMethod: 'render',
                requiresValidation: true,
                requiresExtraction: true // Extract product URL from search results
            };

        case '日進電子':
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

        case 'IDEC':
            return {
                url: `https://jp.idec.com/search?text=${encodedModel}&includeDiscontinued=true&sort=relevance&type=products`,
                scrapingMethod: 'idec_dual_site', // JP site first, US site fallback
                model: model,
                jpUrl: `https://jp.idec.com/search?text=${encodedModel}&includeDiscontinued=true&sort=relevance&type=products`,
                usUrl: `https://us.idec.com/search?text=${encodedModel}&includeDiscontinued=true&sort=relevance&type=products`
            };

        case 'NBK':
            return {
                url: `https://www.nbk1560.com/search/?q=${encodedModel}&SelectedLanguage=ja-JP&page=1&imgsize=1&doctype=all&sort=0&pagemax=10&htmlLang=ja`,
                scrapingMethod: 'nbk_interactive', // Interactive search with product name preprocessing
                model: model // Pass model for preprocessing (remove 'x' and '-')
            };

        default:
            return null; // No direct URL strategy - use Tavily search
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
            return createValidationErrorResponse(validation.errors);
        }

        // Sanitize inputs
        const maker = sanitizeString(requestBody.maker, 200);
        const model = sanitizeString(requestBody.model, 200);
        logger.info('Creating job for:', { maker, model });

        // Clean up old logs (runs before creating job, similar to job cleanup)
        await cleanupOldLogs();

        // Create job (this also triggers job cleanup internally)
        const jobId = await createJob(maker, model, context);

        // Process manufacturer strategy or fall back to search
        const strategyResult = await processManufacturerStrategy(maker, model, jobId, context);
        if (strategyResult) {
            return strategyResult;
        }

        // Perform Tavily search as fallback
        return await performTavilySearch(maker, model, jobId, context);

    } catch (error) {
        logger.error('Initialize job error:', error);
        return createErrorResponse(500, 'Internal server error', error.message);
    }
};

// Helper functions
function handlePreflightAndMethodValidation(event) {
    if (event.httpMethod === 'OPTIONS') {
        return createCorsResponse(200, '');
    }

    if (event.httpMethod !== 'POST') {
        return createErrorResponse(405, 'Method Not Allowed');
    }

    return null;
}

function createCorsResponse(statusCode, body, additionalHeaders = {}) {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        ...additionalHeaders
    };

    return {
        statusCode,
        headers,
        body
    };
}

function createErrorResponse(statusCode, error, details = null) {
    const response = {
        statusCode,
        headers: {
            'Access-Control-Allow-Origin': '*',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ error })
    };

    if (details) {
        response.body = JSON.stringify({ error, details });
    }

    return response;
}

function createValidationErrorResponse(errors) {
    logger.error('Validation failed:', errors);
    return createErrorResponse(400, 'Validation failed', errors);
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
        logger.error(`Validation scraping failed for ${maker}: ${error.message}, falling back to Tavily search`);
        return null; // Fall through to Tavily search
    }
}

async function handleExtractionStrategy(maker, model, jobId, strategy, context) {
    logger.info(`Extracting product URL from ${maker} search results`);

    const searchHtml = await fetchHtml(strategy.url);
    const productPath = extractTakigenProductUrl(searchHtml);

    if (!productPath) {
        logger.info(`No product found in ${maker} search results, falling back to Tavily search`);
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
        logger.info(`404 page detected for ${strategy.url}, falling back to Tavily search`);
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
        logger.info(`No search results found on ${strategy.url}, falling back to Tavily search`);
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

    const urls = [urlEntry];
    await saveJobUrls(jobId, urls, context);

    logger.info(`Job ${jobId} initialized with direct URL strategy (1 URL, method: ${strategy.scrapingMethod})`);

    return createSuccessResponse(jobId, 'urls_ready', urls.length, 'direct_url',
        { scrapingMethod: strategy.scrapingMethod });
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

async function performTavilySearch(maker, model, jobId, context) {
    const searchQuery = `${maker} ${model}`;

    // Initialize Tavily client
    const tavilyClient = tavily({ apiKey: process.env.TAVILY_API_KEY });

    let tavilyData;
    try {
        tavilyData = await tavilyClient.search(searchQuery, getTavilySearchOptions());
    } catch (error) {
        logger.error('Tavily API error:', error);
        return createErrorResponse(500, 'Tavily API failed', error.message);
    }

    logger.info(`Tavily returned ${tavilyData.results?.length || 0} results`);

    if (!tavilyData.results || tavilyData.results.length === 0) {
        return await handleNoSearchResults(maker, model, jobId, context);
    }

    const urls = tavilyData.results.map((result, index) =>
        createUrlEntry(index, result.url, result.title, result.content || '')
    );

    await saveJobUrls(jobId, urls, context);
    logger.info(`Job ${jobId} initialized with ${urls.length} URLs`);

    return createSuccessResponse(jobId, 'urls_ready', urls.length);
}

function getTavilySearchOptions() {
    return {
        searchDepth: 'advanced',
        maxResults: 2,
        includeDomains: [
            'ccs-grp.com',
            'automationdirect.com',
            'takigen.co.jp',
            'mitsubishielectric.co.jp',
            'sentei.nissei-gtr.co.jp',
            'tamron.com',
            'search.sugatsune.co.jp',
            'sanwa.co.jp',
            'jp.idec.com',
            'jp.misumi-ec.com',
            'mitsubishielectric.com',
            'kvm-switches-online.com',
            'daitron.co.jp',
            'kdwan.co.jp',
            'hewtech.co.jp',
            'directindustry.com',
            'printerland.co.uk',
            'orimvexta.co.jp',
            'sankyo-seisakusho.co.jp',
            'tsubakimoto.co.jp',
            'nbk1560.com',
            'habasit.com',
            'nagoya.sc',
            'amazon.co.jp',
            'tps.co.jp/eol/',
            'ccs-inc.co.jp',
            'shinkoh-faulhaber.jp',
            'anelva.canon',
            'takabel.com',
            'ysol.co.jp',
            'digikey.jp',
            'rs-components.com',
            'fa-ubon.jp',
            'monotaro.com',
            'fujitsu.com',
            'hubbell.com',
            'adlinktech.com',
            'touchsystems.com',
            'elotouch.com',
            'aten.com',
            'canon.com',
            'axiomtek.com',
            'apc.com',
            'hp.com',
            'fujielectric.co.jp',
            'panasonic.jp',
            'wago.com',
            'schmersal.com',
            'apiste.co.jp',
            'tdklamda.com',
            'phoenixcontact.com',
            'idec.com',
            'patlite.co.jp',
            'smcworld.com',
            'sanyodenki.co.jp',
            'nissin-ele.co.jp',
            'sony.co.jp',
            'orientalmotor.co.jp',
            'keyence.co.jp',
            'fa.omron.co.jp',
            'tme.com/jp',
            'ntn.co.jp'
        ]
    };
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
