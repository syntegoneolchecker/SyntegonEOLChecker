// Set auto-check state in Netlify Blobs
const { getStore } = require('@netlify/blobs');
const logger = require('./lib/logger');
const { handleCORSPreflight, successResponse, errorResponse, methodNotAllowedResponse } = require('./lib/response-builder');

exports.handler = async function(event, context) {
    // Handle CORS
    const corsResponse = handleCORSPreflight(event, 'POST, OPTIONS');
    if (corsResponse) return corsResponse;

    if (event.httpMethod !== 'POST') {
        return methodNotAllowedResponse('POST');
    }

    try {
        // Diagnostic logging for blob store configuration
        const siteID = process.env.SITE_ID;
        const hasToken = !!(process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_TOKEN);
        const deployContext = process.env.CONTEXT;
        const branch = process.env.BRANCH;

        logger.info('SET blob store config:', {
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
        const updates = JSON.parse(event.body);

        // Get current state
        let state = await store.get('state', { type: 'json' });
        logger.info('SET current state from blob:', state);

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

        return successResponse({ state });

    } catch (error) {
        logger.error('Set auto-check state error:', error);
        return errorResponse('Failed to set auto-check state', { details: error.message });
    }
};
