// Get auto-check state from Netlify Blobs
const { getStore } = require('@netlify/blobs');

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
        const store = getStore('auto-check-state');

        // Get state from blob storage
        let state = await store.get('state', { type: 'json' });

        // Initialize default state if not exists
        if (!state) {
            state = {
                enabled: false,
                dailyCounter: 0,
                lastResetDate: new Date().toISOString().split('T')[0], // YYYY-MM-DD
                isRunning: false
            };
            // Save default state
            await store.setJSON('state', state);
        }

        return {
            statusCode: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(state)
        };

    } catch (error) {
        console.error('Get auto-check state error:', error);
        return {
            statusCode: 500,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                error: 'Failed to get auto-check state',
                details: error.message
            })
        };
    }
};
