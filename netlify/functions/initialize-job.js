// Initialize EOL check job - Search with Tavily and save URLs
const { createJob, saveJobUrls, saveFinalResult } = require('./lib/job-storage');

/**
 * Get manufacturer-specific direct URL if available
 * Returns null if manufacturer requires Tavily search
 */
function getManufacturerUrl(maker, model) {
    const normalizedMaker = maker.trim();
    const encodedModel = encodeURIComponent(model.trim());

    switch(normalizedMaker) {
        case 'SMC':
            return `https://www.smcworld.com/webcatalog/s3s/ja-jp/detail/?partNumber=${encodedModel}`;

        case 'オリエンタルモーター':
            return `https://www.orientalmotor.co.jp/ja/products/products-search/replacement?hinmei=${encodedModel}`;

        case 'ミスミ':
            return `https://jp.misumi-ec.com/vona2/result/?Keyword=${encodedModel}`;

        default:
            return null; // No direct URL strategy - use Tavily search
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
        const directUrl = getManufacturerUrl(maker, model);

        if (directUrl) {
            // Use manufacturer-specific direct URL (no Tavily search needed)
            console.log(`Using direct URL strategy for ${maker}: ${directUrl}`);

            const urls = [{
                index: 0,
                url: directUrl,
                title: `${maker} ${model} Product Page`,
                snippet: `Direct product page for ${maker} ${model}`
            }];

            await saveJobUrls(jobId, urls, context);

            console.log(`Job ${jobId} initialized with direct URL strategy (1 URL)`);

            return {
                statusCode: 200,
                headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jobId,
                    status: 'urls_ready',
                    urlCount: urls.length,
                    strategy: 'direct_url'
                })
            };
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
