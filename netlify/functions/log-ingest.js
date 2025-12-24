/**
 * Central log ingestion endpoint
 * Receives logs from all services and stores them in Netlify Blobs
 * Logs are stored in daily files, one JSON line per log entry
 */

import { getStore } from '@netlify/blobs';
const logger = require('./lib/logger');

export const handler = async (event) => {
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

    // Create a key based on the date (YYYY-MM-DD format)
    const date = new Date(logEntry.timestamp);
    const dateKey = date.toISOString().split('T')[0];
    const logKey = `logs-${dateKey}.jsonl`;

    // Get existing logs for today (if any)
    let existingLogs = '';
    try {
      existingLogs = await store.get(logKey, { type: 'text' }) || '';
    } catch (err) {
      // File doesn't exist yet, that's OK
      existingLogs = '';
    }

    // Append the new log entry as a JSON line
    const logLine = JSON.stringify(logEntry) + '\n';
    const updatedLogs = existingLogs + logLine;

    // Store back to blob
    await store.set(logKey, updatedLogs);

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, stored: logKey })
    };
  } catch (error) {
    logger.error('Error ingesting log:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to ingest log', message: error.message })
    };
  }
};
