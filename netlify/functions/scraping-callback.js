// Receive results from Render scraping service and save them
const { saveUrlResult, getJob } = require('./lib/job-storage');

exports.handler = async function(event, context) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const { jobId, urlIndex, content, title, snippet, url } = JSON.parse(event.body);

        console.log(`Scraping callback received for job ${jobId}, URL ${urlIndex}`);

        // Construct base URL from request headers
        const protocol = event.headers['x-forwarded-proto'] || 'https';
        const host = event.headers['host'];
        const baseUrl = `${protocol}://${host}`;

        // Save the result
        const allDone = await saveUrlResult(jobId, urlIndex, {
            url,
            title,
            snippet,
            fullContent: content
        }, context);

        console.log(`Result saved. All URLs done: ${allDone}`);

        if (allDone) {
            // All URLs fetched - trigger LLM analysis
            console.log(`All URLs complete for job ${jobId}, triggering analysis`);
            await triggerAnalysis(jobId, baseUrl);
        } else {
            // SEQUENTIAL EXECUTION: Trigger next pending URL (Render free tier = 1 concurrent request)
            console.log(`URL ${urlIndex} complete, checking for next pending URL...`);
            const job = await getJob(jobId, context);

            if (job) {
                // Find next pending URL
                const nextUrl = job.urls.find(u => u.status === 'pending');

                if (nextUrl) {
                    console.log(`Triggering next URL ${nextUrl.index}: ${nextUrl.url}`);
                    await triggerFetch(jobId, nextUrl, baseUrl);
                } else {
                    console.log(`No more pending URLs found (all may be fetching or complete)`);
                }
            }
        }

        return {
            statusCode: 200,
            body: JSON.stringify({ success: true })
        };

    } catch (error) {
        console.error('Scraping callback error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};

// Trigger next URL fetch
async function triggerFetch(jobId, urlInfo, baseUrl) {
    try {
        await fetch(`${baseUrl}/.netlify/functions/fetch-url`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jobId,
                urlIndex: urlInfo.index,
                url: urlInfo.url,
                title: urlInfo.title,
                snippet: urlInfo.snippet,
                scrapingMethod: urlInfo.scrapingMethod // Pass scraping method (render/browserql)
            })
        });
    } catch (error) {
        console.error('Failed to trigger next fetch:', error);
    }
}

// Trigger LLM analysis
async function triggerAnalysis(jobId, baseUrl) {
    try {
        await fetch(`${baseUrl}/.netlify/functions/analyze-job`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jobId })
        });
    } catch (error) {
        console.error('Failed to trigger analysis:', error);
    }
}
