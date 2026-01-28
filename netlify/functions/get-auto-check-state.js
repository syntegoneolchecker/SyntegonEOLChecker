// Get auto-check state from Netlify Blobs
const { getStore } = require('@netlify/blobs');
const logger = require('./lib/logger');
const { getCorsOrigin, handleCORSPreflight, errorResponse } = require('./lib/response-builder');

exports.handler = async function(event, _context) {
    // Handle CORS
    const corsResponse = handleCORSPreflight(event, 'GET, OPTIONS');
    if (corsResponse) return corsResponse;

    try {
        // Diagnostic logging for blob store configuration
        const siteID = process.env.SITE_ID;

        const store = getStore({
            name: 'auto-check-state',
            siteID: siteID,
            token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_TOKEN,
            consistency: 'strong'
        });

        // Get state from blob storage
        let state = await store.get('state', { type: 'json' });

        // Initialize default state if not exists
        if (!state) {
            state = {
                enabled: false,
                dailyCounter: 0,
                lastResetDate: new Date().toISOString().split('T')[0], // YYYY-MM-DD
                isRunning: false,
                lastActivityTime: null
            };
            // Save default state
            await store.setJSON('state', state);
        }

        return {
            statusCode: 200,
            headers: {
                'Access-Control-Allow-Origin': getCorsOrigin(),
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            },
            body: JSON.stringify(state)
        };

    } catch (error) {
        logger.error('Get auto-check state error:', error);
        return errorResponse('Failed to get auto-check state', { details: error.message });
    }
};
