const logger = require('./logger');

// Log storage management using Netlify Blobs
const { getStore } = require('@netlify/blobs');
const config = require('./config');

/**
 * Helper to get log store
 */
function getLogStore() {
    return getStore({
        name: 'logs',
        siteID: process.env.SITE_ID,
        token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_TOKEN
    });
}

/**
 * Clean up old logs (older than configured retention period)
 * Called automatically on every new EOL check to prevent blob storage bloat
 */
async function cleanupOldLogs() {
    try {
        const deletedCount = await performLogCleanup();
        logCleanupResult(deletedCount);
    } catch (error) {
        // Don't fail job creation if cleanup fails
        logger.error('Log cleanup error (non-fatal):', error.message);
    }
}

async function performLogCleanup() {
    const store = getLogStore();
    const { blobs } = await store.list({ prefix: 'logs-' });
    let deletedCount = 0;

    for (const blob of blobs) {
        const shouldDelete = await processLogBlob(blob, store);
        if (shouldDelete) {
            deletedCount++;
        }
    }

    return deletedCount;
}

async function processLogBlob(blob, store) {
    try {
        // Extract timestamp from blob key
        // Format: logs-YYYY-MM-DD-timestamp-randomId.json
        const keyParts = blob.key.match(/logs-(\d{4}-\d{2}-\d{2})-(\d+)-/);

        if (!keyParts) {
            // Old format or invalid key, skip
            return false;
        }

        const timestampMs = parseInt(keyParts[2], 10);

        if (shouldDeleteLog(timestampMs)) {
            // Try to delete, handle race conditions
            try {
                await store.delete(blob.key);
                logDeletion(blob.key, timestampMs);
                return true;
            } catch (deleteError) {
                // Another process may have deleted this log concurrently
                if (deleteError.statusCode === 404 || deleteError.message?.includes('404')) {
                    logger.info(`Log ${blob.key} was already deleted by another process (race condition handled)`);
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

function shouldDeleteLog(timestampMs) {
    const RETENTION_MS = config.LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const ageMs = Date.now() - timestampMs;
    return ageMs > RETENTION_MS;
}

function handleBlobError(error, blobKey) {
    const errorMessage = error.message || '';
    const statusCode = error.statusCode;

    if (statusCode === 403 || errorMessage.includes('403')) {
        logger.warn(`⚠️  Skipping log blob ${blobKey}: Permission denied (403). This blob may be orphaned from an older version.`);
    } else if (statusCode === 404 || errorMessage.includes('404')) {
        logger.info(`Log blob ${blobKey} was already deleted`);
    } else {
        logger.error(`Error processing log blob ${blobKey} during cleanup:`, errorMessage);
    }
}

function logDeletion(blobKey, timestampMs) {
    const ageMs = Date.now() - timestampMs;
    const ageHours = Math.round(ageMs / 1000 / 60 / 60);
    logger.info(`Cleaned up old log ${blobKey} (age: ${ageHours}h)`);
}

function logCleanupResult(deletedCount) {
    if (deletedCount > 0) {
        logger.info(`✓ Log cleanup complete: deleted ${deletedCount} old log(s)`);
    }
}

module.exports = {
    cleanupOldLogs
};
