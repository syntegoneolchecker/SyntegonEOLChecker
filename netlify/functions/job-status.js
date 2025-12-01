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

        // If URLs are ready but not being fetched yet, trigger fetching
        if (job.status === 'urls_ready') {
            console.log(`Triggering URL fetching for job ${jobId}`);

            // Update status to fetching FIRST (to prevent duplicate triggers)
            await updateJobStatus(jobId, 'fetching', null, context);
            job.status = 'fetching';

            // Trigger fetch for each URL (fire-and-forget - don't wait for completion)
            // Construct base URL from request headers
            const protocol = event.headers['x-forwarded-proto'] || 'https';
            const host = event.headers['host'];
            const baseUrl = `${protocol}://${host}`;
            const fetchUrl = `${baseUrl}/.netlify/functions/fetch-url`;
            console.log(`Fetch endpoint: ${fetchUrl}`);

            // Fire-and-forget: trigger all fetch-url functions without waiting
            // They will update job state themselves when complete
            let triggeredCount = 0;
            job.urls.forEach((urlInfo) => {
                console.log(`Triggering fetch for URL ${urlInfo.index}: ${urlInfo.url}`);

                fetch(fetchUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        jobId,
                        urlIndex: urlInfo.index,
                        url: urlInfo.url,
                        title: urlInfo.title,
                        snippet: urlInfo.snippet
                    })
                }).then(() => {
                    console.log(`Fetch trigger sent for URL ${urlInfo.index}`);
                }).catch(error => {
                    console.error(`Failed to trigger fetch for URL ${urlInfo.index}:`, error.message);
                });

                triggeredCount++;
            });

            console.log(`All ${triggeredCount} fetch-url calls triggered (fire-and-forget)`);
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
