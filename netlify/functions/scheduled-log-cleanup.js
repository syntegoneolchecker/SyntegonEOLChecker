/**
 * Scheduled log cleanup function
 * Runs periodically to enforce MAX_LOGS limit and LOG_RETENTION_DAYS
 *
 * Schedule: Runs every 6 hours (configurable in netlify.toml)
 *
 * Cleanup strategy:
 * 1. Delete logs older than LOG_RETENTION_DAYS (time-based)
 * 2. If count still exceeds MAX_LOGS, delete oldest logs (count-based)
 *
 * This runs in the background, so log viewing is fast and doesn't block on cleanup
 */

const { getStore } = require('@netlify/blobs');
const { schedule } = require('@netlify/functions');
const config = require('./lib/config');

/**
 * Extract timestamp from log blob key
 * Format: logs-YYYY-MM-DD-timestamp-randomId.json
 * Returns: timestamp in milliseconds, or null if invalid format
 */
function extractTimestampFromKey(key) {
    try {
        const match = key.match(/logs-(\d{4}-\d{2}-\d{2})-(\d+)-/);
        if (!match) {
            return null;
        }
        return Number.parseInt(match[2], 10);
    } catch {
        return null;
    }
}

/**
 * Delete blobs in batches to avoid timeout
 * Uses Promise.allSettled to continue even if some deletions fail
 */
async function deleteInBatches(store, blobsToDelete, batchSize = 100) {
    let deletedCount = 0;
    let failedCount = 0;

    for (let i = 0; i < blobsToDelete.length; i += batchSize) {
        const batch = blobsToDelete.slice(i, i + batchSize);

        const results = await Promise.allSettled(
            batch.map(blob => store.delete(blob.key))
        );

        for (const result of results) {
            if (result.status === 'fulfilled') {
                deletedCount++;
            } else if (!result.reason?.message?.includes('404')) {
                // Log error but continue (might be 404 if already deleted)
                failedCount++;
                console.error(`Failed to delete blob: ${result.reason?.message}`);
            }
        }
    }

    return { deletedCount, failedCount };
}

/**
 * Main cleanup function
 */
async function cleanupLogs() {
    const startTime = Date.now();
    console.log('[LOG CLEANUP] Starting scheduled log cleanup...');

    try {
        // Get the logs store
        const store = getStore({
            name: 'logs',
            siteID: process.env.SITE_ID,
            token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_TOKEN
        });

        // List all log blobs
        const { blobs } = await store.list({ prefix: 'logs-' });
        console.log(`[LOG CLEANUP] Found ${blobs.length} log blob(s)`);

        if (blobs.length === 0) {
            console.log('[LOG CLEANUP] No logs to clean up');
            return;
        }

        // Extract timestamps and filter invalid blobs
        const logsWithTimestamp = [];
        for (const blob of blobs) {
            const timestamp = extractTimestampFromKey(blob.key);
            if (timestamp) {
                logsWithTimestamp.push({ key: blob.key, timestamp });
            } else {
                console.warn(`[LOG CLEANUP] Skipping blob with invalid format: ${blob.key}`);
            }
        }

        // Sort by timestamp (newest first)
        logsWithTimestamp.sort((a, b) => b.timestamp - a.timestamp);

        // Get configuration
        const maxLogs = Number.parseInt(process.env.MAX_LOGS) || 300;
        const retentionMs = config.LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
        const cutoffTime = Date.now() - retentionMs;

        console.log(`[LOG CLEANUP] Configuration: MAX_LOGS=${maxLogs}, LOG_RETENTION_DAYS=${config.LOG_RETENTION_DAYS}`);

        // Determine which logs to delete
        const toDelete = [];

        // Phase 1: Delete logs older than retention period (regardless of count)
        const oldLogs = logsWithTimestamp.filter(log => log.timestamp < cutoffTime);
        toDelete.push(...oldLogs);
        console.log(`[LOG CLEANUP] Phase 1 (age-based): ${oldLogs.length} logs older than ${config.LOG_RETENTION_DAYS} day(s)`);

        // Phase 2: Delete logs beyond MAX_LOGS limit (keep newest)
        const recentLogs = logsWithTimestamp.filter(log => log.timestamp >= cutoffTime);
        if (recentLogs.length > maxLogs) {
            const excessLogs = recentLogs.slice(maxLogs); // Delete oldest of recent logs
            toDelete.push(...excessLogs);
            console.log(`[LOG CLEANUP] Phase 2 (count-based): ${excessLogs.length} logs beyond MAX_LOGS limit`);
        } else {
            console.log(`[LOG CLEANUP] Phase 2 (count-based): ${recentLogs.length} logs within MAX_LOGS limit, no deletion needed`);
        }

        // Remove duplicates (in case a log qualifies for both phases)
        const uniqueToDelete = [...new Map(toDelete.map(log => [log.key, log])).values()];

        if (uniqueToDelete.length === 0) {
            console.log('[LOG CLEANUP] No logs to delete');
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
            console.log(`[LOG CLEANUP] ✓ Cleanup complete in ${elapsed}s (no deletions needed)`);
            return;
        }

        console.log(`[LOG CLEANUP] Deleting ${uniqueToDelete.length} log(s)...`);

        // Delete in batches
        const { deletedCount, failedCount } = await deleteInBatches(store, uniqueToDelete, 100);

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        const remaining = logsWithTimestamp.length - deletedCount;

        console.log(`[LOG CLEANUP] ✓ Cleanup complete in ${elapsed}s`);
        console.log(`[LOG CLEANUP]   - Deleted: ${deletedCount} log(s)`);
        console.log(`[LOG CLEANUP]   - Failed: ${failedCount} log(s)`);
        console.log(`[LOG CLEANUP]   - Remaining: ${remaining} log(s)`);

    } catch (error) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        console.error(`[LOG CLEANUP] ✗ Cleanup failed after ${elapsed}s:`, error);
        throw error;
    }
}

/**
 * Scheduled handler (runs on schedule defined in netlify.toml)
 */
const handler = async (_event) => {
    console.log('[LOG CLEANUP] Scheduled cleanup triggered');

    try {
        await cleanupLogs();

        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                message: 'Log cleanup completed successfully'
            })
        };
    } catch (error) {
        console.error('[LOG CLEANUP] Handler error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                success: false,
                error: error.message
            })
        };
    }
};

// Export as scheduled function (runs every 6 hours)
// Schedule is configured in netlify.toml
exports.handler = schedule('0 */6 * * *', handler);
