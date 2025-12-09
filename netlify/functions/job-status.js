// SIMPLIFIED: Read-only job status endpoint (for debugging)
// All orchestration now happens in auto-eol-check-background's polling loop
const { getJob } = require('./lib/job-storage');

exports.handler = async function(event, context) {
    // Extract jobId from path
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

        // Return current job status (read-only)
        const response = {
            jobId: job.jobId,
            status: job.status,
            maker: job.maker,
            model: job.model,
            urlCount: job.urls ? job.urls.length : 0,
            completedUrls: job.urls ? job.urls.filter(u => u.status === 'complete').length : 0,
            error: job.error,
            createdAt: job.createdAt,
            completedAt: job.completedAt
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
