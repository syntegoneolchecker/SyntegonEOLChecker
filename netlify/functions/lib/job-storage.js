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

// Create a new job
async function createJob(maker, model, context) {
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

// Update job status
async function updateJobStatus(jobId, status, error, context) {
    const store = getJobStore();
    const job = await store.get(jobId, { type: 'json' });

    if (!job) {
        throw new Error(`Job ${jobId} not found`);
    }

    job.status = status;
    if (error) {
        job.error = error;
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

module.exports = {
    createJob,
    saveJobUrls,
    getJob,
    updateJobStatus,
    markUrlFetching,
    saveUrlResult,
    saveFinalResult
};
