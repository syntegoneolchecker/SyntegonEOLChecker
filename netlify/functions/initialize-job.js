// Initialize EOL check job - Search with Tavily and save URLs
const { createJob, saveJobUrls, saveFinalResult, saveUrlResult } = require('./lib/job-storage');
const { validateInitializeJob, sanitizeString } = require('./lib/validators');
const { tavily } = require('@tavily/core');

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
                scrapingMethod: 'render',
                model: model,
                requiresValidation: true,
                requiresIdecExtraction: true
            };

        default:
            return null; // No direct URL strategy - use Tavily search
    }
}

/**
 * Fetch HTML directly via HTTP (for simple pages that don't need JavaScript rendering)
 */
async function fetchHtml(url) {
    console.log(`Fetching HTML via HTTP: ${url}`);

    const response = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
    });

    if (!response.ok) {
        throw new Error(`HTTP error: ${response.status}`);
    }

    const html = await response.text();
    console.log(`Fetched HTML successfully: ${html.length} characters`);

    return html;
}

/**
 * Scrape URL using BrowserQL (for Cloudflare-protected sites)
 * Same implementation as in fetch-url.js
 */
async function scrapeWithBrowserQL(url) {
    const browserqlApiKey = process.env.BROWSERQL_API_KEY;

    if (!browserqlApiKey) {
        throw new Error('BROWSERQL_API_KEY environment variable not set');
    }

    console.log(`Scraping with BrowserQL: ${url}`);

    const query = `
        mutation ScrapeUrl {
            goto(
                url: "${url}"
                waitUntil: networkIdle
            ) {
                status
            }

            pageContent: evaluate(content: """
                (() => {
                    try {
                        const scripts = document.querySelectorAll('script, style, noscript');
                        scripts.forEach(el => el.remove());
                        return JSON.stringify({ text: document.body.innerText, error: null });
                    } catch (e) {
                        return JSON.stringify({ text: null, error: e?.message ?? String(e) });
                    }
                })()
            """) {
                value
            }
        }
    `;

    const response = await fetch(`https://production-sfo.browserless.io/stealth/bql?token=${browserqlApiKey}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ query })
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`BrowserQL API error: ${response.status} - ${errorText}`);
    }

    const result = await response.json();

    if (result.errors) {
        throw new Error(`BrowserQL GraphQL errors: ${JSON.stringify(result.errors)}`);
    }

    if (!result.data || !result.data.pageContent) {
        throw new Error('BrowserQL returned no data');
    }

    const evaluateResult = JSON.parse(result.data.pageContent.value);

    if (evaluateResult.error) {
        throw new Error(`BrowserQL evaluation error: ${evaluateResult.error}`);
    }

    const content = evaluateResult.text;

    if (!content) {
        throw new Error('BrowserQL returned empty content');
    }

    console.log(`BrowserQL scraped successfully: ${content.length} characters`);

    return {
        content,
        success: true
    };
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
            console.log(`Detected "no results" pattern: "${pattern}"`);
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
            console.log(`Detected 404 pattern: "${pattern}"`);
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
            console.log('Takigen search results div not found in HTML');
            return null;
        }

        const divContent = divMatch[1];

        // Extract the first href from an <a> tag
        const hrefPattern = /href="(\/products\/detail\/[^"]+)"/;
        const hrefMatch = divContent.match(hrefPattern);

        if (!hrefMatch) {
            console.log('No product href found in Takigen search results div');
            return null;
        }

        const productPath = hrefMatch[1];
        console.log(`Extracted Takigen product path: ${productPath}`);
        return productPath;

    } catch (error) {
        console.error(`Error extracting Takigen product URL: ${error.message}`);
        return null;
    }
}

exports.handler = async function(event, context) {
    console.log('Initialize job request');

    // Handle CORS
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Allow-Methods': 'POST, OPTIONS'
            },
            body: ''
        };
    }

    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Method Not Allowed' })
        };
    }

    try {
        const requestBody = JSON.parse(event.body);

        // Validate input
        const validation = validateInitializeJob(requestBody);
        if (!validation.valid) {
            console.error('Validation failed:', validation.errors);
            return {
                statusCode: 400,
                headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Validation failed', details: validation.errors })
            };
        }

        // Sanitize inputs
        const maker = sanitizeString(requestBody.maker, 200);
        const model = sanitizeString(requestBody.model, 200);

        console.log('Creating job for:', { maker, model });

        // Create job
        const jobId = await createJob(maker, model, context);

        // Check if manufacturer has a direct URL strategy
        const manufacturerStrategy = getManufacturerUrl(maker, model);

        if (manufacturerStrategy) {
            // Check if this URL requires validation (e.g., NTN on motion.com, Takigen)
            if (manufacturerStrategy.requiresValidation) {
                console.log(`URL requires validation for ${maker}: ${manufacturerStrategy.url}`);

                try {
                    // Special handling for Takigen - extract product URL from search results
                    if (manufacturerStrategy.requiresExtraction) {
                        console.log(`Extracting product URL from ${maker} search results`);

                        // Takigen uses server-side rendering, so fetchHtml is sufficient
                        const searchHtml = await fetchHtml(manufacturerStrategy.url);
                        const productPath = extractTakigenProductUrl(searchHtml);

                        if (!productPath) {
                            console.log(`No product found in ${maker} search results, falling back to Tavily search`);
                            // Fall through to Tavily search below
                        } else {
                            // Build the full product URL
                            const productUrl = `https://www.takigen.co.jp${productPath}`;
                            console.log(`Extracted ${maker} product URL: ${productUrl}`);

                            // Save this URL for scraping
                            const urls = [{
                                index: 0,
                                url: productUrl,
                                title: `${maker} ${model} Product Page`,
                                snippet: `Direct product page for ${maker} ${model}`,
                                scrapingMethod: manufacturerStrategy.scrapingMethod
                            }];

                            await saveJobUrls(jobId, urls, context);

                            console.log(`Job ${jobId} initialized with extracted ${maker} product URL`);

                            return {
                                statusCode: 200,
                                headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    jobId,
                                    status: 'urls_ready',
                                    urlCount: 1,
                                    strategy: 'takigen_extracted_url',
                                    extractedUrl: productUrl
                                })
                            };
                        }
                    } else if (manufacturerStrategy.requires404Check) {
                        // Special handling for 日進電子 - check if page is 404
                        console.log(`Checking for 404 page for ${maker}`);

                        // Fetch the HTML to check if it's a 404 page
                        const html = await fetchHtml(manufacturerStrategy.url);

                        // Check if page is 404
                        if (is404Page(html)) {
                            console.log(`404 page detected for ${manufacturerStrategy.url}, falling back to Tavily search`);
                            // Fall through to Tavily search below
                        } else {
                            // Valid product page! Save this URL for scraping
                            console.log(`Valid product page found for ${maker} ${model}`);

                            const urls = [{
                                index: 0,
                                url: manufacturerStrategy.url,
                                title: `${maker} ${model} Product Page`,
                                snippet: `Direct product page for ${maker} ${model}`,
                                scrapingMethod: manufacturerStrategy.scrapingMethod
                            }];

                            await saveJobUrls(jobId, urls, context);

                            console.log(`Job ${jobId} initialized with validated ${maker} product URL`);

                            return {
                                statusCode: 200,
                                headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    jobId,
                                    status: 'urls_ready',
                                    urlCount: 1,
                                    strategy: 'nissin_validated_url'
                                })
                            };
                        }
                    } else if (manufacturerStrategy.requiresIdecExtraction) {
                        // Special handling for IDEC - extract product URL using proxies via Render
                        console.log(`Extracting IDEC product URL for ${maker} ${model}`);

                        const scrapingServiceUrl = process.env.SCRAPING_SERVICE_URL || 'https://eolscrapingservice.onrender.com';

                        // Get proxy URLs from environment variables
                        const jpProxyUrl = process.env.IDEC_JP_PROXY;
                        const usProxyUrl = process.env.IDEC_US_PROXY;

                        if (!jpProxyUrl || !usProxyUrl) {
                            console.error('IDEC proxy environment variables not set, falling back to Tavily search');
                            // Fall through to Tavily search below
                        } else {
                            try {
                                // Call Render with extractOnly mode (no callback needed)
                                const idecPayload = {
                                    url: manufacturerStrategy.url,
                                    extractionMode: 'idec',
                                    model: manufacturerStrategy.model,
                                    jpProxyUrl: jpProxyUrl,
                                    usProxyUrl: usProxyUrl,
                                    extractOnly: true
                                };

                                console.log(`Calling Render for IDEC URL extraction: ${scrapingServiceUrl}/scrape`);

                                const response = await fetch(`${scrapingServiceUrl}/scrape`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify(idecPayload)
                                });

                                if (!response.ok) {
                                    const errorText = await response.text();
                                    console.error(`Render IDEC extraction failed: ${response.status} - ${errorText}`);
                                    // Fall through to Tavily search below
                                } else {
                                    const result = await response.json();

                                    if (result.success && result.url) {
                                        // Successfully extracted product URL!
                                        console.log(`✓ IDEC product URL extracted: ${result.url}`);

                                        const urls = [{
                                            index: 0,
                                            url: result.url,
                                            title: `${maker} ${model} Product Page`,
                                            snippet: `Direct product page for ${maker} ${model}`,
                                            scrapingMethod: manufacturerStrategy.scrapingMethod
                                        }];

                                        await saveJobUrls(jobId, urls, context);

                                        console.log(`Job ${jobId} initialized with extracted IDEC product URL`);

                                        return {
                                            statusCode: 200,
                                            headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
                                            body: JSON.stringify({
                                                jobId,
                                                status: 'urls_ready',
                                                urlCount: 1,
                                                strategy: 'idec_extracted_url',
                                                extractedUrl: result.url
                                            })
                                        };
                                    } else {
                                        console.log(`IDEC extraction returned no product URL, falling back to Tavily search`);
                                        // Fall through to Tavily search below
                                    }
                                }
                            } catch (error) {
                                console.error(`IDEC extraction error: ${error.message}, falling back to Tavily search`);
                                // Fall through to Tavily search below
                            }
                        }
                    } else {
                        // Standard validation (e.g., NTN) - scrape and check for results
                        const scrapeResult = await scrapeWithBrowserQL(manufacturerStrategy.url);

                        // Check if search returned no results
                        if (hasNoSearchResults(scrapeResult.content)) {
                            console.log(`No search results found on ${manufacturerStrategy.url}, falling back to Tavily search`);
                            // Fall through to Tavily search below (don't return here)
                        } else {
                            // Results found! Save this URL with the scraped content
                            console.log(`Search results found on motion.com, using this content for analysis`);

                            const urls = [{
                                index: 0,
                                url: manufacturerStrategy.url,
                                title: `${maker} ${model} Search Results`,
                                snippet: `Search results from motion.com for ${maker} ${model}`,
                                scrapingMethod: manufacturerStrategy.scrapingMethod
                            }];

                            await saveJobUrls(jobId, urls, context);

                            // Save the scraped content immediately
                            await saveUrlResult(jobId, 0, {
                                url: manufacturerStrategy.url,
                                title: `${maker} ${model} Search Results`,
                                snippet: `Search results from motion.com`,
                                fullContent: scrapeResult.content
                            }, context);

                            console.log(`Job ${jobId} initialized with validated direct URL (content already scraped)`);

                            // Mark job as ready for analysis (content already fetched)
                            return {
                                statusCode: 200,
                                headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    jobId,
                                    status: 'ready_for_analysis',
                                    urlCount: 1,
                                    strategy: 'validated_direct_url',
                                    contentLength: scrapeResult.content.length
                                })
                            };
                        }
                    }
                } catch (error) {
                    console.error(`Validation scraping failed for ${maker}: ${error.message}, falling back to Tavily search`);
                    // Fall through to Tavily search below
                }
            } else {
                // Standard direct URL (no validation needed)
                console.log(`Using direct URL strategy for ${maker}: ${manufacturerStrategy.url} (scraping: ${manufacturerStrategy.scrapingMethod})`);

                const urls = [{
                    index: 0,
                    url: manufacturerStrategy.url,
                    title: `${maker} ${model} Product Page`,
                    snippet: `Direct product page for ${maker} ${model}`,
                    scrapingMethod: manufacturerStrategy.scrapingMethod
                }];

                // Pass model for interactive searches (KEYENCE)
                if (manufacturerStrategy.model) {
                    urls[0].model = manufacturerStrategy.model;
                }

                await saveJobUrls(jobId, urls, context);

                console.log(`Job ${jobId} initialized with direct URL strategy (1 URL, method: ${manufacturerStrategy.scrapingMethod})`);

                return {
                    statusCode: 200,
                    headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        jobId,
                        status: 'urls_ready',
                        urlCount: urls.length,
                        strategy: 'direct_url',
                        scrapingMethod: manufacturerStrategy.scrapingMethod
                    })
                };
            }
        }

        // Perform Tavily search (URLs only - no raw_content)
        const searchQuery = `${maker} ${model}`;

        // Initialize Tavily client
        const tavilyClient = tavily({ apiKey: process.env.TAVILY_API_KEY });

        // Perform search using SDK
        let tavilyData;
        try {
            tavilyData = await tavilyClient.search(searchQuery, {
                searchDepth: 'advanced',
                maxResults: 2,  // 2 URLs to stay within token limits
                // NOTE: No includeRawContent - we'll scrape with Render instead
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
            });
        } catch (error) {
            console.error('Tavily API error:', error);
            return {
                statusCode: 500,
                headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    error: 'Tavily API failed',
                    details: error.message
                })
            };
        }

        console.log(`Tavily returned ${tavilyData.results?.length || 0} results`);

        if (!tavilyData.results || tavilyData.results.length === 0) {
            // No search results - complete job immediately with UNKNOWN status
            console.log(`No search results found for ${maker} ${model}`);
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
            return {
                statusCode: 200,
                headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
                body: JSON.stringify({ jobId, status: 'complete', message: 'No search results found' })
            };
        }

        // Extract URLs from search results
        const urls = tavilyData.results.map((result, index) => ({
            index: index,
            url: result.url,
            title: result.title,
            snippet: result.content || '' // Use snippet for context
        }));

        await saveJobUrls(jobId, urls, context);

        console.log(`Job ${jobId} initialized with ${urls.length} URLs`);

        return {
            statusCode: 200,
            headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jobId,
                status: 'urls_ready',
                urlCount: urls.length
            })
        };

    } catch (error) {
        console.error('Initialize job error:', error);
        return {
            statusCode: 500,
            headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Internal server error', details: error.message })
        };
    }
};
