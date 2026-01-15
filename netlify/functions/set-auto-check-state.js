// Set auto-check state in Netlify Blobs
const { getStore } = require('@netlify/blobs');
const logger = require('./lib/logger');

exports.handler = async function(event, _context) {
    // Handle CORS
    if (event.httpMethod === 'OPTIONS') {
        return {
            statusCode: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Allow-Methods': 'POST, OPTIONS'
            },
            body: ''
        };
    }

    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ error: 'Method Not Allowed' })
        };
    }

    try {
        const store = getStore({
            name: 'auto-check-state',
            siteID: process.env.SITE_ID,
            token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_TOKEN,
            consistency: 'strong'
        });
        const updates = JSON.parse(event.body);

        // Get current state
        let state = await store.get('state', { type: 'json' });

        // Initialize if not exists
        if (!state) {
            state = {
                enabled: false,
                dailyCounter: 0,
                lastResetDate: new Date().toISOString().split('T')[0],
                isRunning: false,
                lastActivityTime: null
            };
        }

        // Apply updates (only allow specific fields to be updated)
        if (updates.hasOwnProperty('enabled')) {
            state.enabled = updates.enabled;
        }
        if (updates.hasOwnProperty('dailyCounter')) {
            state.dailyCounter = updates.dailyCounter;
        }
        if (updates.hasOwnProperty('lastResetDate')) {
            state.lastResetDate = updates.lastResetDate;
        }
        if (updates.hasOwnProperty('isRunning')) {
            state.isRunning = updates.isRunning;
            // When isRunning changes, update lastActivityTime
            if (updates.isRunning) {
                state.lastActivityTime = new Date().toISOString();
            }
        }
        if (updates.hasOwnProperty('lastActivityTime')) {
            state.lastActivityTime = updates.lastActivityTime;
        }

        // Save updated state
        await store.setJSON('state', state);

        logger.info('Auto-check state updated:', state);

        return {
            statusCode: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                success: true,
                state: state
            })
        };

    } catch (error) {
        logger.error('Set auto-check state error:', error);
        return {
            statusCode: 500,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                error: 'Failed to set auto-check state',
                details: error.message
            })
        };
    }
};
