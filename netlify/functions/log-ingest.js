/**
 * Central log ingestion endpoint
 * Receives logs from all services and stores them in Netlify Blobs
 * Each log is stored as an individual blob with unique key for thread-safety
 * Format: logs-YYYY-MM-DD-timestamp-randomId.json
 */

const { getStore } = require('@netlify/blobs');
const logger = require('./lib/logger');

/**
 * Generate a random string for unique log IDs
 */
function generateRandomId(length = 8) {
  try {
    return Array.from(crypto.getRandomValues(new Uint8Array(length)))
      .map(b => b.toString(36))
      .join('')
      .replaceAll('.', '')
      .substring(0, length);
  } catch {
    // Fallback to Math.random() if crypto fails
    return Array.from({ length }, () =>
      Math.floor(Math.random() * 36).toString(36)
    ).join('');
  }
}

exports.handler = async (event) => {
  // Only accept POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const logEntry = JSON.parse(event.body);

    // Validate required fields
    if (!logEntry.timestamp || !logEntry.level || !logEntry.source) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing required fields: timestamp, level, source' })
      };
    }

    // Get the logs store
    const store = getStore({
      name: 'logs',
      siteID: process.env.SITE_ID,
      token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_TOKEN
    });

    // Create a unique key for this log entry to prevent race conditions
    // Format: logs-YYYY-MM-DD-timestamp-randomId.json
    const date = new Date(logEntry.timestamp);
    const dateKey = date.toISOString().split('T')[0];
    const timestampMs = date.getTime();
    const randomId = generateRandomId(8);
    const logKey = `logs-${dateKey}-${timestampMs}-${randomId}.json`;

    // Store as individual blob (thread-safe, no race conditions)
    await store.setJSON(logKey, logEntry);

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, stored: logKey })
    };
  } catch (error) {
    console.error('[ERROR] Error ingesting log:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to ingest log', message: error.message })
    };
  }
};
