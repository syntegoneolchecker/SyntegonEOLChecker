// Reset database - clears all data from Netlify Blobs
const { getStore } = require('@netlify/blobs');
const logger = require('./lib/logger');

exports.handler = async function(event, _context) {
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({ error: 'Method Not Allowed - use POST' })
        };
    }

    try {
        const store = getStore({
            name: 'eol-database',
            siteID: process.env.SITE_ID,
            token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_TOKEN
        });

        // Delete the main database blob
        await store.delete('database.csv');

        logger.info('Database cleared successfully');

        return {
            statusCode: 200,
            headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
            body: JSON.stringify({
                success: true,
                message: 'Database cleared. Page will reload with empty database.'
            })
        };
    } catch (error) {
        logger.error('Reset error:', error);
        return {
            statusCode: 500,
            headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: error.message })
        };
    }
};
