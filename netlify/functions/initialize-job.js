// Initialize EOL check job - Search with Tavily and save URLs
const { createJob, saveJobUrls, saveFinalResult, saveUrlResult } = require('./lib/job-storage');

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

        default:
            return null; // No direct URL strategy - use Tavily search
    }
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
        'no results found',
        'no products found',
        '0 results',
        'no items match',
        'did not match any products',
        'your search returned no results',
        'we could not find any results',
        'no matches found'
    ];

    for (const pattern of noResultsPatterns) {
        if (lowerContent.includes(pattern)) {
            console.log(`Detected "no results" pattern: "${pattern}"`);
            return true;
        }
    }

    return false;
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
        const { maker, model } = JSON.parse(event.body);

        if (!maker || !model) {
            return {
                statusCode: 400,
                headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Maker and model are required' })
            };
        }

        console.log('Creating job for:', { maker, model });

        // Create job
        const jobId = await createJob(maker, model, context);

        // Check if manufacturer has a direct URL strategy
        const manufacturerStrategy = getManufacturerUrl(maker, model);

        if (manufacturerStrategy) {
            // Check if this URL requires validation (e.g., NTN on motion.com)
            if (manufacturerStrategy.requiresValidation) {
                console.log(`URL requires validation for ${maker}: ${manufacturerStrategy.url}`);

                try {
                    // Scrape the URL with BrowserQL to check if results exist
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

        const tavilyResponse = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                api_key: process.env.TAVILY_API_KEY,
                query: searchQuery,
                search_depth: 'advanced',
                max_results: 2,  // 2 URLs to stay within token limits
                // NOTE: Removed include_raw_content - we'll scrape with Render instead
                include_domains: [
                    'mitsubishielectric.co.jp',
                    'sentei.nissei-gtr.co.jp',
                    'orimvexta.co.jp',
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
                    'tps.co.jp/eol/',
                    'ccs-inc.co.jp',
                    'shinkoh-faulhaber.jp',
                    'misumi-ec.com',
                    'anelva.canon',
                    'takabel.com',
                    'ysol.co.jp',
                    'manualslib.com',
                    'mouser.jp',
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
                    'omron.co.jp',
                    'ntn.co.jp'
                ]
            })
        });

        if (!tavilyResponse.ok) {
            const errorText = await tavilyResponse.text();
            console.error('Tavily API error:', errorText);
            return {
                statusCode: 500,
                headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    error: `Tavily API failed: ${tavilyResponse.status}`,
                    details: errorText
                })
            };
        }

        const tavilyData = await tavilyResponse.json();
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
