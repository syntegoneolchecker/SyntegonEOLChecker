// Check job status and trigger URL fetching if needed
const { getJob, updateJobStatus } = require('./lib/job-storage');

exports.handler = async function(event, context) {
    // Extract jobId from path - handles both /job-status/jobId and /.netlify/functions/job-status/jobId
    const pathParts = event.path.split('/');
    const jobId = pathParts[pathParts.length - 1];

    // Handle CORS
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Allow-Methods': 'GET, OPTIONS'
            },
            body: ''
        };
    }

    try {
        const job = await getJob(jobId, context);

        if (!job) {
            return {
                statusCode: 404,
                headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
                body: JSON.stringify({ error: 'Job not found' })
            };
        }

        // Construct base URL from request headers (used by multiple paths below)
        const protocol = event.headers['x-forwarded-proto'] || 'https';
        const host = event.headers['host'];
        const baseUrl = `${protocol}://${host}`;

        // If content is already ready for analysis (e.g., NTN validation), trigger analysis directly
        if (job.status === 'ready_for_analysis') {
            console.log(`Content already scraped for job ${jobId}, triggering analysis`);

            // Update status to analyzing FIRST (to prevent duplicate triggers)
            await updateJobStatus(jobId, 'analyzing', null, context);
            job.status = 'analyzing';

            const analyzeUrl = `${baseUrl}/.netlify/functions/analyze-job`;
            console.log(`Analysis endpoint: ${analyzeUrl}`);

            fetch(analyzeUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jobId })
            }).then(() => {
                console.log(`Analysis triggered for job ${jobId}`);
            }).catch(error => {
                console.error(`Failed to trigger analysis:`, error.message);
            });
        }

        // If URLs are ready but not being fetched yet, trigger fetching
        if (job.status === 'urls_ready') {
            console.log(`Triggering URL fetching for job ${jobId}`);

            // Update status to fetching FIRST (to prevent duplicate triggers)
            await updateJobStatus(jobId, 'fetching', null, context);
            job.status = 'fetching';

            const fetchUrl = `${baseUrl}/.netlify/functions/fetch-url`;
            console.log(`Fetch endpoint: ${fetchUrl}`);

            // SEQUENTIAL EXECUTION: Only trigger first URL (Render free tier = 1 concurrent request)
            // scraping-callback will trigger next URL after this one completes
            const firstUrl = job.urls[0];
            if (firstUrl) {
                console.log(`Triggering first URL (sequential): ${firstUrl.url}`);

                const payload = {
                    jobId,
                    urlIndex: firstUrl.index,
                    url: firstUrl.url,
                    title: firstUrl.title,
                    snippet: firstUrl.snippet,
                    scrapingMethod: firstUrl.scrapingMethod // Pass scraping method (render/browserql/keyence_interactive)
                };

                // Pass model for interactive searches (KEYENCE)
                if (firstUrl.model) {
                    payload.model = firstUrl.model;
                }

                fetch(fetchUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                }).then(() => {
                    console.log(`First fetch-url triggered (subsequent URLs will be triggered by callback)`);
                }).catch(error => {
                    console.error(`Failed to trigger first fetch-url:`, error.message);
                });
            }
        }

        // Return current job status
        const response = {
            jobId: job.jobId,
            status: job.status,
            maker: job.maker,
            model: job.model,
            urlCount: job.urls ? job.urls.length : 0,
            completedUrls: job.urls ? job.urls.filter(u => u.status === 'complete').length : 0,
            error: job.error
        };

        // If complete, include final result
        if (job.status === 'complete' && job.finalResult) {
            response.result = job.finalResult;
        }

        return {
            statusCode: 200,
            headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
            body: JSON.stringify(response)
        };

    } catch (error) {
        console.error('Job status error:', error);
        return {
            statusCode: 500,
            headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Internal server error', details: error.message })
        };
    }
};
