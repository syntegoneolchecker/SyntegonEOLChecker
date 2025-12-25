/**
 * Clear all logs endpoint
 * Deletes all logs currently stored in Netlify Blobs
 * This is a destructive operation and should be used with caution
 */

const { getStore } = require('@netlify/blobs');
const logger = require('./lib/logger');

exports.handler = async (event) => {
  try {
    // Only allow POST requests for safety (prevents accidental deletion via GET)
    if (event.httpMethod !== 'POST') {
      return {
        statusCode: 405,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Method not allowed. Use POST.' })
      };
    }

    // Get the logs store
    const store = getStore({
      name: 'logs',
      siteID: process.env.SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_TOKEN
    });

    // List all log blobs
    const { blobs } = await store.list({ prefix: 'logs-' });

    logger.info(`Clearing ${blobs.length} log blob(s)`);

    // Delete all log blobs in parallel
    // Use allSettled to continue even if some deletions fail
    const results = await Promise.allSettled(
      blobs.map(blob => store.delete(blob.key))
    );

    const deletedCount = results.filter(r => r.status === 'fulfilled').length;

    logger.info(`✓ Cleared ${deletedCount} of ${blobs.length} log blob(s)`);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        deletedCount,
        message: `Successfully cleared ${deletedCount} log blob(s)`
      }, null, 2)
    };
  } catch (error) {
    logger.error('Error clearing logs:', error);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: false,
        error: error.message
      })
    };
  }
};
