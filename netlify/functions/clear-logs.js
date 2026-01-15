/**
 * Clear all logs endpoint
 * Deletes all logs currently stored in Supabase PostgreSQL
 * This is a destructive operation and should be used with caution
 */

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

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_API_KEY) {
      throw new Error('Supabase not configured. Set SUPABASE_URL and SUPABASE_API_KEY environment variables.');
    }

    // First, get the count of logs to delete
    const countResponse = await fetch(`${process.env.SUPABASE_URL}/rest/v1/logs`, {
      method: 'HEAD',
      headers: {
        'apikey': process.env.SUPABASE_API_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_API_KEY}`,
        'Prefer': 'count=exact'
      }
    });

    const totalCount = Number.parseInt(countResponse.headers.get('content-range')?.split('/')[1] || '0');

    logger.info(`Clearing ${totalCount} log(s) from Supabase`);

    // Delete all logs using Supabase REST API
    // Use a filter that matches all records (timestamp >= minimum date)
    const deleteResponse = await fetch(`${process.env.SUPABASE_URL}/rest/v1/logs?timestamp=gte.1970-01-01T00:00:00.000Z`, {
      method: 'DELETE',
      headers: {
        'apikey': process.env.SUPABASE_API_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_API_KEY}`,
        'Prefer': 'return=minimal'
      }
    });

    if (!deleteResponse.ok) {
      throw new Error(`Failed to delete logs: ${deleteResponse.status} ${deleteResponse.statusText}`);
    }

    logger.info(`✓ Cleared ${totalCount} log(s) from Supabase`);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        deletedCount: totalCount,
        message: `Successfully cleared ${totalCount} log(s)`
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
