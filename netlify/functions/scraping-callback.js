// Receive results from Render scraping service and save them
const { saveUrlResult, getJob, replaceJobUrls } = require('./lib/job-storage');
const { tavily } = require('@tavily/core');

/**
 * Trigger fetch-url for the next pending URL
 * Must be awaited to ensure the HTTP request completes before function terminates
 */
async function triggerFetch(jobId, urlInfo, baseUrl) {
    try {
        const payload = {
            jobId,
            urlIndex: urlInfo.index,
            url: urlInfo.url,
            title: urlInfo.title,
            snippet: urlInfo.snippet,
            scrapingMethod: urlInfo.scrapingMethod
        };

        // Pass model for interactive searches (KEYENCE)
        if (urlInfo.model) {
            payload.model = urlInfo.model;
        }

        await fetch(`${baseUrl}/.netlify/functions/fetch-url`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
    } catch (error) {
        console.error('Failed to trigger next fetch:', error);
    }
}

/**
 * Perform Tavily search for IDEC fallback
 */
async function performTavilySearch(maker, model) {
    console.log(`Performing Tavily search for ${maker} ${model}`);

    const searchQuery = `${maker} ${model}`;
    const tavilyClient = tavily({ apiKey: process.env.TAVILY_API_KEY });

    try {
        const tavilyData = await tavilyClient.search(searchQuery, {
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
        });

        console.log(`Tavily returned ${tavilyData.results?.length || 0} results`);

        if (!tavilyData.results || tavilyData.results.length === 0) {
            return null;
        }

        return tavilyData.results.map((result, index) => ({
            index: index,
            url: result.url,
            title: result.title,
            snippet: result.content || '',
            scrapingMethod: 'render'
        }));

    } catch (error) {
        console.error('Tavily search error:', error);
        return null;
    }
}

/**
 * Check if this is an IDEC validation callback
 */
function isIdecValidationCallback(job, urlIndex, url, content) {
    if (!job || !job.urls || !job.urls[urlIndex]) {
        return false;
    }

    const urlInfo = job.urls[urlIndex];

    // Check if URL is IDEC search page
    const isIdecSearch = url && url.includes('jp.idec.com/search');

    // Check for IDEC validation failure marker
    const isValidationFailed = content && (
        content.includes('[IDEC_VALIDATION_FAILED]') ||
        content.includes('[No exact IDEC product match found')
    );

    return isIdecSearch && isValidationFailed;
}

/**
 * Check if this callback contains an IDEC product URL
 */
function isIdecProductUrl(url) {
    return url && url.includes('jp.idec.com') && url.includes('/p/');
}

/**
 * Retry helper for Blobs operations with exponential backoff
 * Handles transient network errors and blob storage propagation delays
 */
async function retryBlobsOperation(operationName, operation, maxRetries = 5) {
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`${operationName}: attempt ${attempt}/${maxRetries}`);
            const result = await operation();
            if (attempt > 1) {
                console.log(`✓ ${operationName} succeeded on attempt ${attempt}`);
            }
            return result;
        } catch (error) {
            lastError = error;
            const isSocketError = error.code === 'UND_ERR_SOCKET' ||
                                 error.message?.includes('socket') ||
                                 error.message?.includes('ECONNRESET') ||
                                 error.message?.includes('ETIMEDOUT');

            // Also retry on "Job not found" errors (blob storage propagation delay)
            const isJobNotFound = error.message?.includes('Job') && error.message?.includes('not found');

            console.error(`${operationName} failed on attempt ${attempt}/${maxRetries}:`, {
                message: error.message,
                code: error.code,
                isSocketError,
                isJobNotFound
            });

            if (attempt < maxRetries && (isSocketError || isJobNotFound)) {
                const backoffMs = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s
                console.log(`Retrying ${operationName} in ${backoffMs}ms...`);
                await new Promise(resolve => setTimeout(resolve, backoffMs));
            }
        }
    }

    // All retries failed
    console.error(`❌ ${operationName} failed after ${maxRetries} attempts`);
    throw lastError;
}

/**
 * IMPORTANT: This function must complete within Netlify's 30s timeout
 * - We await triggerFetch to ensure next URL is triggered (fast, < 1s)
 * - We skip triggering analysis (let polling loop handle it)
 * - This prevents timeouts when analyze-job waits for Groq token reset (30-60s)
 */
exports.handler = async function(event, context) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const startTime = Date.now();
    let jobId, urlIndex;

    try {
        const { jobId: _jobId, urlIndex: _urlIndex, content, title, snippet, url } = JSON.parse(event.body);
        jobId = _jobId;
        urlIndex = _urlIndex;

        console.log(`[CALLBACK START] Job ${jobId}, URL ${urlIndex} (${content?.length || 0} chars)`);

        // Construct base URL from request headers
        const protocol = event.headers['x-forwarded-proto'] || 'https';
        const host = event.headers['host'];
        const baseUrl = `${protocol}://${host}`;

        // Save the result WITH RETRY LOGIC
        let allDone;
        try {
            allDone = await retryBlobsOperation(
                `saveUrlResult(${jobId}, ${urlIndex})`,
                async () => await saveUrlResult(jobId, urlIndex, {
                    url,
                    title,
                    snippet,
                    fullContent: content
                }, context)
            );
        } catch (error) {
            console.error(`CRITICAL: Failed to save URL result after retries:`, error);
            return {
                statusCode: 500,
                body: JSON.stringify({
                    error: 'Failed to save result to storage after retries',
                    details: error.message
                })
            };
        }

        console.log(`Result saved. All URLs done: ${allDone}`);

        // Get job for IDEC validation detection
        const job = await getJob(jobId, context);

        // ===== IDEC VALIDATION HANDLING =====
        // Check if this is an IDEC validation callback
        if (isIdecValidationCallback(job, urlIndex, url, content)) {
            console.log(`[IDEC VALIDATION FAILED] Triggering Tavily fallback for job ${jobId}`);

            // Perform Tavily search
            const tavilyUrls = await performTavilySearch(job.maker, job.model);

            if (tavilyUrls && tavilyUrls.length > 0) {
                console.log(`✓ Tavily returned ${tavilyUrls.length} URLs for IDEC fallback`);

                // Replace IDEC search URL with Tavily URLs
                await replaceJobUrls(jobId, tavilyUrls, context);

                // Trigger fetch for first Tavily URL
                console.log(`Triggering fetch for first Tavily URL: ${tavilyUrls[0].url}`);
                await triggerFetch(jobId, tavilyUrls[0], baseUrl);

                console.log(`[IDEC FALLBACK COMPLETE] Switched to Tavily URLs`);

                const duration = Date.now() - startTime;
                console.log(`[CALLBACK END] Job ${jobId}, URL ${urlIndex} - IDEC fallback in ${duration}ms`);

                return {
                    statusCode: 200,
                    body: JSON.stringify({ success: true, fallback: 'tavily' })
                };
            } else {
                console.error(`Tavily search returned no results for IDEC fallback`);
                // Continue with normal flow (job will complete with error)
            }
        }

        // Check if this is an IDEC product URL (validation succeeded)
        else if (isIdecProductUrl(url)) {
            console.log(`[IDEC VALIDATION SUCCESS] Product URL found: ${url}`);

            // The URL in the callback is already the product URL from Render's extractOnly mode
            // Replace the search URL with the product URL
            await replaceJobUrls(jobId, [{
                index: 0,
                url: url,
                title: title || `IDEC Product Page`,
                snippet: snippet || `Direct product page`,
                scrapingMethod: 'render'
            }], context);

            // Trigger fetch for the product URL
            console.log(`Triggering fetch for IDEC product URL: ${url}`);
            await triggerFetch(jobId, {
                index: 0,
                url: url,
                title: title || `IDEC Product Page`,
                snippet: snippet || `Direct product page`,
                scrapingMethod: 'render'
            }, baseUrl);

            console.log(`[IDEC VALIDATION COMPLETE] Switched to product URL`);

            const duration = Date.now() - startTime;
            console.log(`[CALLBACK END] Job ${jobId}, URL ${urlIndex} - IDEC success in ${duration}ms`);

            return {
                statusCode: 200,
                body: JSON.stringify({ success: true, validation: 'idec_product_url' })
            };
        }

        // ===== NORMAL PIPELINE CONTINUATION =====
        // Continue pipeline: trigger next URL or let polling loop handle analysis
        if (allDone) {
            // All URLs complete - let polling loop detect and trigger analysis
            // We don't trigger analysis here to avoid 30s timeout (analyze-job can take 30-60s waiting for Groq tokens)
            console.log(`✓ All URLs complete for job ${jobId}. Polling loop will trigger analysis.`);
        } else {
            // Find and trigger next pending URL
            console.log(`Checking for next pending URL...`);

            if (job) {
                const nextUrl = job.urls.find(u => u.status === 'pending');

                if (nextUrl) {
                    console.log(`Triggering next URL ${nextUrl.index}: ${nextUrl.url}`);
                    await triggerFetch(jobId, nextUrl, baseUrl);
                } else {
                    console.log(`No more pending URLs found (this should not happen)`);
                }
            } else {
                console.error(`Failed to get job ${jobId} for next URL trigger`);
            }
        }

        const duration = Date.now() - startTime;
        console.log(`[CALLBACK END] Job ${jobId}, URL ${urlIndex} - Success in ${duration}ms`);

        return {
            statusCode: 200,
            body: JSON.stringify({ success: true })
        };

    } catch (error) {
        const duration = Date.now() - startTime;
        console.error(`[CALLBACK ERROR] Job ${jobId}, URL ${urlIndex} - Failed in ${duration}ms:`, {
            message: error.message,
            code: error.code,
            stack: error.stack
        });

        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};
