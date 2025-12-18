// Job storage using Netlify Blobs
const { getStore } = require('@netlify/blobs');

// Helper to get configured store
function getJobStore() {
    return getStore({
        name: 'eol-jobs',
        siteID: process.env.SITE_ID,
        token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_TOKEN
    });
}

/**
 * Delete a job from storage
 * @param {string} jobId - Job ID to delete
 * @param {Object} context - Netlify function context (optional)
 */
async function deleteJob(jobId, context) {
    const store = getJobStore();
    await store.delete(jobId);
    console.log(`Deleted job ${jobId} from storage`);
}

/**
 * Clean up old completed jobs (completed more than 5 minutes ago)
 * Called automatically on every new job creation to prevent blob storage bloat
 * @param {Object} context - Netlify function context (optional)
 */
async function cleanupOldJobs(context) {
    try {
        const store = getJobStore();
        const { blobs } = await store.list();

        const now = Date.now();
        const FIVE_MINUTES_MS = 5 * 60 * 1000;
        let deletedCount = 0;

        for (const blob of blobs) {
            try {
                const job = await store.get(blob.key, { type: 'json' });

                if (!job) {
                    // Blob exists but has no data - safe to skip
                    continue;
                }

                // Delete if job is completed or errored and older than 5 minutes
                if ((job.status === 'complete' || job.status === 'error') && job.completedAt) {
                    const completedTime = new Date(job.completedAt).getTime();
                    const ageMs = now - completedTime;

                    if (ageMs > FIVE_MINUTES_MS) {
                        await store.delete(blob.key);
                        deletedCount++;
                        console.log(`Cleaned up old job ${blob.key} (completed ${Math.round(ageMs / 1000 / 60)}m ago)`);
                    }
                }
            } catch (error) {
                // Handle different error types
                const is403Error = error.message?.includes('403') || error.statusCode === 403;
                const is404Error = error.message?.includes('404') || error.statusCode === 404;

                if (is403Error) {
                    // Permission error on old blob - skip it (likely corrupted or orphaned)
                    console.warn(`⚠️  Skipping blob ${blob.key}: Permission denied (403). This blob may be orphaned from an older version.`);
                } else if (is404Error) {
                    // Blob was deleted between list() and get() - this is fine
                    console.log(`Blob ${blob.key} was already deleted`);
                } else {
                    // Other errors - log but continue
                    console.error(`Error processing blob ${blob.key} during cleanup:`, error.message);
                }
                // Always continue with other blobs
            }
        }

        if (deletedCount > 0) {
            console.log(`✓ Cleanup complete: deleted ${deletedCount} old job(s)`);
        }
    } catch (error) {
        // Don't fail job creation if cleanup fails
        console.error('Job cleanup error (non-fatal):', error.message);
    }
}

/**
 * Create a new job and clean up old completed jobs
 * @param {string} maker - Manufacturer name
 * @param {string} model - Product model
 * @param {Object} context - Netlify function context (optional)
 * @returns {string} Job ID
 */
async function createJob(maker, model, context) {
    // Clean up old jobs first (await to prevent race conditions)
    // This ensures cleanup completes before creating new job
    await cleanupOldJobs(context);

    const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    const job = {
        jobId,
        maker,
        model,
        status: 'created', // created → urls_ready → fetching → analyzing → complete/error
        urls: [],
        urlResults: {},
        finalResult: null,
        error: null,
        createdAt: new Date().toISOString()
    };

    const store = getJobStore();
    await store.setJSON(jobId, job);

    console.log(`Created job ${jobId} for ${maker} ${model}`);
    return jobId;
}

// Save URLs to job
async function saveJobUrls(jobId, urls, context) {
    const store = getJobStore();
    const job = await store.get(jobId, { type: 'json' });

    if (!job) {
        throw new Error(`Job ${jobId} not found`);
    }

    // Initialize URL tracking
    job.urls = urls.map(urlInfo => ({
        ...urlInfo,
        status: 'pending' // pending → fetching → complete
    }));

    job.urlResults = {};
    job.status = 'urls_ready';

    await store.setJSON(jobId, job);
    console.log(`Saved ${urls.length} URLs to job ${jobId}`);
}

// Get job
async function getJob(jobId, context) {
    const store = getJobStore();
    const job = await store.get(jobId, { type: 'json' });
    return job;
}

/**
 * Update job status
 * @param {string} jobId - Job ID
 * @param {string} status - New status (created, urls_ready, fetching, analyzing, complete, error)
 * @param {string} error - Error message (optional)
 * @param {Object} context - Netlify function context (optional)
 * @param {Object} metadata - Additional metadata to store (optional)
 */
async function updateJobStatus(jobId, status, error, context, metadata = {}) {
    const store = getJobStore();
    const job = await store.get(jobId, { type: 'json' });

    if (!job) {
        throw new Error(`Job ${jobId} not found. Jobs are automatically deleted 5 minutes after completion.`);
    }

    job.status = status;
    if (error) {
        job.error = error;
    }

    // Set completedAt timestamp for final states (enables cleanup)
    if ((status === 'complete' || status === 'error') && !job.completedAt) {
        job.completedAt = new Date().toISOString();
    }

    // Add any additional metadata (e.g., retrySeconds for rate limits)
    if (metadata && Object.keys(metadata).length > 0) {
        Object.assign(job, metadata);
    }

    await store.setJSON(jobId, job);
    console.log(`Updated job ${jobId} status to ${status}`);
}

// Mark URL as fetching
async function markUrlFetching(jobId, urlIndex, context) {
    const store = getJobStore();
    const job = await store.get(jobId, { type: 'json' });

    if (!job) {
        throw new Error(`Job ${jobId} not found`);
    }

    const url = job.urls.find(u => u.index === urlIndex);
    if (url) {
        url.status = 'fetching';
        await store.setJSON(jobId, job);
        console.log(`Marked URL ${urlIndex} as fetching for job ${jobId}`);
    }
}

// Save URL result and return whether all URLs are complete
async function saveUrlResult(jobId, urlIndex, result, context) {
    const store = getJobStore();
    const job = await store.get(jobId, { type: 'json' });

    if (!job) {
        throw new Error(`Job ${jobId} not found`);
    }

    // Save the result
    job.urlResults[urlIndex] = result;

    // Mark URL as complete
    const url = job.urls.find(u => u.index === urlIndex);
    if (url) {
        url.status = 'complete';
    }

    await store.setJSON(jobId, job);
    console.log(`Saved result for URL ${urlIndex} in job ${jobId}`);

    // Check if all URLs are complete
    const allComplete = job.urls.every(u => u.status === 'complete');
    return allComplete;
}

// Save final analysis result
async function saveFinalResult(jobId, result, context) {
    const store = getJobStore();
    const job = await store.get(jobId, { type: 'json' });

    if (!job) {
        throw new Error(`Job ${jobId} not found`);
    }

    job.finalResult = result;
    job.status = 'complete';
    job.completedAt = new Date().toISOString();

    await store.setJSON(jobId, job);
    console.log(`Saved final result for job ${jobId}`);
}

/**
 * Replace all URLs in a job (used for Tavily fallback)
 */
async function replaceJobUrls(jobId, newUrls, context) {
    const store = getJobStore();
    const job = await store.get(jobId, { type: 'json' });

    if (!job) {
        throw new Error(`Job ${jobId} not found`);
    }

    // Replace URLs and reset urlResults
    job.urls = newUrls.map((url, index) => ({
        ...url,
        index,
        status: url.status || 'pending'
    }));

    job.urlResults = {};

    await store.setJSON(jobId, job);

    console.log(`Replaced URLs for job ${jobId}: ${newUrls.length} new URLs`);
}

/**
 * Add a single URL to a job (used when IDEC validation succeeds)
 */
async function addUrlToJob(jobId, urlData, context) {
    const store = getJobStore();
    const job = await store.get(jobId, { type: 'json' });

    if (!job) {
        throw new Error(`Job ${jobId} not found`);
    }

    // Add new URL with next index
    const newIndex = job.urls.length;
    job.urls.push({
        ...urlData,
        index: newIndex,
        status: urlData.status || 'pending'
    });

    await store.setJSON(jobId, job);

    console.log(`Added URL to job ${jobId}: ${urlData.url}`);

    return newIndex;
}

module.exports = {
    createJob,
    saveJobUrls,
    getJob,
    updateJobStatus,
    markUrlFetching,
    saveUrlResult,
    saveFinalResult,
    replaceJobUrls,
    addUrlToJob,
    deleteJob
};
