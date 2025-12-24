/**
 * Clear all logs endpoint
 * Deletes all logs currently stored in Netlify Blobs
 * This is a destructive operation and should be used with caution
 */

import { getStore } from '@netlify/blobs';
const logger = require('./lib/logger');

export const handler = async (event) => {
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

    logger.info(`Starting log clear operation: ${blobs.length} log(s) to delete`);

    // Delete all log blobs
    let deletedCount = 0;
    let errorCount = 0;
    const errors = [];

    for (const blob of blobs) {
      try {
        await store.delete(blob.key);
        deletedCount++;
      } catch (error) {
        errorCount++;
        // Handle race conditions (blob already deleted)
        if (error.statusCode === 404 || error.message?.includes('404')) {
          logger.info(`Log ${blob.key} was already deleted`);
          // Still count as deleted since it's gone
          deletedCount++;
          errorCount--;
        } else {
          logger.error(`Error deleting log blob ${blob.key}:`, error.message);
          errors.push({ key: blob.key, error: error.message });
        }
      }
    }

    logger.info(`✓ Log clear complete: deleted ${deletedCount} log(s), ${errorCount} error(s)`);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        deletedCount,
        errorCount,
        errors: errors.length > 0 ? errors : undefined,
        message: `Successfully deleted ${deletedCount} log(s)${errorCount > 0 ? ` with ${errorCount} error(s)` : ''}`
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
