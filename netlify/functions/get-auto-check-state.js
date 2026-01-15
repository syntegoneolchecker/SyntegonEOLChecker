// Get auto-check state from Netlify Blobs
const { getStore } = require('@netlify/blobs');
const logger = require('./lib/logger');

exports.handler = async function(event, context) {
    // Handle CORS
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Allow-Methods': 'GET, OPTIONS'
            },
            body: ''
        };
    }

    try {
        // Diagnostic logging for blob store configuration
        const siteID = process.env.SITE_ID;
        const hasToken = !!(process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_TOKEN);
        const deployContext = process.env.CONTEXT; // 'production', 'deploy-preview', 'branch-deploy'
        const branch = process.env.BRANCH;

        logger.info('GET blob store config:', {
            siteID: siteID || 'NOT SET',
            hasToken,
            deployContext,
            branch,
            deployId: context?.deployId || 'NOT AVAILABLE'
        });

        const store = getStore({
            name: 'auto-check-state',
            siteID: siteID,
            token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_TOKEN,
            consistency: 'strong'
        });

        // Get state from blob storage
        let state = await store.get('state', { type: 'json' });
        logger.info('GET state from blob:', state);

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
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            },
            body: JSON.stringify(state)
        };

    } catch (error) {
        logger.error('Get auto-check state error:', error);
        return {
            statusCode: 500,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json',
                'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate'
            },
            body: JSON.stringify({
                error: 'Failed to get auto-check state',
                details: error.message
            })
        };
    }
};
