// Read-only job status endpoint
// Used by frontend for polling manual EOL check progress
// (Auto-checks poll Blobs directly in auto-eol-check-background)
const { getJob } = require('./lib/job-storage');
const { _successResponse, notFoundResponse, errorResponse } = require('./lib/response-builder');
const logger = require('./lib/logger');
const { requireAuth } = require('./lib/auth-middleware');

const jobStatusHandler = async function(event, context) {
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
        logger.debug(`[STATUS DEBUG] Fetching status for job: ${jobId}`);
        const job = await getJob(jobId, context);

        if (!job) {
            logger.warn(`[STATUS DEBUG] Job not found: ${jobId}`);
            return notFoundResponse('Job');
        }

        logger.debug(`[STATUS DEBUG] Job retrieved: status=${job.status}, urls=${job.urls?.length}, completed=${job.urls?.filter(u => u.status === 'complete').length}`);

        // Return current job status (read-only)
        const response = {
            jobId: job.jobId,
            status: job.status,
            maker: job.maker,
            model: job.model,
            urlCount: job.urls ? job.urls.length : 0,
            completedUrls: job.urls ? job.urls.filter(u => u.status === 'complete').length : 0,
            urls: job.urls || [], // Include URLs array for frontend workflow orchestration
            error: job.error,
            createdAt: job.createdAt,
            completedAt: job.completedAt,
            isDailyLimit: job.isDailyLimit || false,
            retrySeconds: job.retrySeconds || null
        };

        // If complete, include final result
        if (job.status === 'complete' && job.finalResult) {
            response.result = job.finalResult;
        }

        const formatUrlStatus = (u) => `${u.index}:${u.status}`;
        logger.debug(`[STATUS DEBUG] Returning status for job ${jobId}: ${job.status}, URLs: [${job.urls?.map(formatUrlStatus).join(', ')}]`);

        // NOTE: Frontend expects job data directly in response body, not wrapped in { success, data }
        // so we return manually instead of using successResponse()
        return {
            statusCode: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(response)
        };

    } catch (error) {
        logger.error('Job status error:', error);
        return errorResponse('Internal server error', { details: error.message });
    }
};

// Protect with authentication
exports.handler = requireAuth(jobStatusHandler);
