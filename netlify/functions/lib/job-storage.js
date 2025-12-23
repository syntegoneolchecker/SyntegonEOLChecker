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
 * @param {Object} _context - Netlify function context (optional)
 */
async function deleteJob(jobId, _context) {
    const store = getJobStore();
    await store.delete(jobId);
    console.log(`Deleted job ${jobId} from storage`);
}

/**
 * Clean up old completed jobs (completed more than 5 minutes ago)
 * Called automatically on every new job creation to prevent blob storage bloat
 * @param {Object} _context - Netlify function context (optional)
 */
async function cleanupOldJobs(_context) {
    try {
        const deletedCount = await performCleanup();
        logCleanupResult(deletedCount);
    } catch (error) {
        // Don't fail job creation if cleanup fails
        console.error('Job cleanup error (non-fatal):', error.message);
    }
}

async function performCleanup() {
    const store = getJobStore();
    const { blobs } = await store.list();
    let deletedCount = 0;

    for (const blob of blobs) {
        const shouldDelete = await processBlob(blob);
        if (shouldDelete) {
            deletedCount++;
        }
    }

    return deletedCount;
}

async function processBlob(blob) {
    const store = getJobStore();
    try {
        const job = await store.get(blob.key, { type: 'json' });

        if (!job) {
            return false; // Blob exists but has no data
        }

        if (shouldDeleteJob(job)) {
            // Race condition protection: Try to delete, but handle if already deleted
            try {
                await store.delete(blob.key);
                logDeletion(blob.key, job.completedAt);
                return true;
            } catch (deleteError) {
                // Another process may have deleted this job concurrently
                if (deleteError.statusCode === 404 || deleteError.message?.includes('404')) {
                    console.log(`Job ${blob.key} was already deleted by another process (race condition handled)`);
                    return false;
                }
                // Re-throw other errors
                throw deleteError;
            }
        }

        return false;
    } catch (error) {
        handleBlobError(error, blob.key);
        return false;
    }
}

function shouldDeleteJob(job) {
    const FIVE_MINUTES_MS = 5 * 60 * 1000;
    const ACTIVE_STATUSES = ['created', 'urls_ready', 'fetching', 'analyzing'];

    // Race condition protection: Never delete jobs that are actively being processed
    if (ACTIVE_STATUSES.includes(job.status)) {
        return false;
    }

    // Only delete completed or errored jobs
    if (!(job.status === 'complete' || job.status === 'error')) {
        return false;
    }

    // Must have a completion timestamp
    if (!job.completedAt) {
        return false;
    }

    // Only delete jobs older than 5 minutes
    const completedTime = new Date(job.completedAt).getTime();
    const ageMs = Date.now() - completedTime;

    return ageMs > FIVE_MINUTES_MS;
}

function handleBlobError(error, blobKey) {
    const errorMessage = error.message || '';
    const statusCode = error.statusCode;

    if (statusCode === 403 || errorMessage.includes('403')) {
        console.warn(`⚠️  Skipping blob ${blobKey}: Permission denied (403). This blob may be orphaned from an older version.`);
    } else if (statusCode === 404 || errorMessage.includes('404')) {
        console.log(`Blob ${blobKey} was already deleted`);
    } else {
        console.error(`Error processing blob ${blobKey} during cleanup:`, errorMessage);
    }
}

function logDeletion(blobKey, completedAt) {
    const ageMs = Date.now() - new Date(completedAt).getTime();
    const ageMinutes = Math.round(ageMs / 1000 / 60);
    console.log(`Cleaned up old job ${blobKey} (completed ${ageMinutes}m ago)`);
}

function logCleanupResult(deletedCount) {
    if (deletedCount > 0) {
        console.log(`✓ Cleanup complete: deleted ${deletedCount} old job(s)`);
    }
}

/**
 * Generate a random string for job IDs
 * @param {number} length - Desired length of random string
 * @returns {string} Random alphanumeric string
 */
function generateRandomString(length = 12) {
    try {
        // Try to use crypto.getRandomValues (secure)
        return Array.from(crypto.getRandomValues(new Uint8Array(length)))
            .map(b => b.toString(36))
            .join('')
            .replaceAll('.', '') // Remove dots if any
            .substring(0, length);
    } catch (error) {
        console.warn('crypto.getRandomValues failed, falling back to Math.random():', error.message);
        // Fallback to Math.random() if crypto fails
        return Array.from({ length }, () =>
            Math.floor(Math.random() * 36).toString(36)
        ).join('');
    }
}

/**
 * Create a new job and clean up old completed jobs
 * @param {string} maker - Manufacturer name
 * @param {string} model - Product model
 * @param {Object} context - Netlify function context (optional)
 * @returns {Promise<string>} Promise that resolves to Job ID
 */
async function createJob(maker, model, _context) {
    // Clean up old jobs first (await to prevent race conditions)
    // This ensures cleanup completes before creating new job
    await cleanupOldJobs(_context);

    const randomPart = generateRandomString(12);
    const jobId = `job_${Date.now()}_${randomPart}`;

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
async function saveJobUrls(jobId, urls, _context) {
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
async function getJob(jobId, _context) {
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
async function updateJobStatus(jobId, status, error, _context, metadata = {}) {
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
async function markUrlFetching(jobId, urlIndex, _context) {
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
async function saveUrlResult(jobId, urlIndex, result, _context) {
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
async function saveFinalResult(jobId, result, _context) {
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
async function replaceJobUrls(jobId, newUrls, _context) {
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
async function addUrlToJob(jobId, urlData, _context) {
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
