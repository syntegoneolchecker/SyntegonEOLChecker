// Scheduled function that triggers daily at 21:00 GMT+9 (12:00 UTC)
// Checks if auto-check is enabled and starts the background checking process
const { getStore } = require('@netlify/blobs');
const { schedule } = require('@netlify/functions');
const logger = require('./lib/logger');

// Helper: Get current date in GMT+9 timezone
function getGMT9Date() {
    const now = new Date();
    // Convert to GMT+9 (add 9 hours to UTC)
    const gmt9Time = new Date(now.getTime() + (9 * 60 * 60 * 1000));
    return gmt9Time.toISOString().split('T')[0]; // YYYY-MM-DD
}

// Helper: Detect current deployment URL for scheduled functions
function getCurrentDeploymentUrl(event, context) {
    // Scheduled functions have the deployment URL in the event object, not environment variables!
    // Priority order:
    // 1. Extract from event.rawUrl (most reliable)
    // 2. Extract from event.headers.host
    // 3. Decode from context.clientContext.custom.netlify
    // 4. Fall back to environment variables

    // Priority 1: Extract from rawUrl (e.g., "https://develop--site.netlify.app/.netlify/functions/...")
    if (event?.rawUrl) {
        try {
            const url = new URL(event.rawUrl);
            const siteUrl = `${url.protocol}//${url.host}`;
            logger.info(`Detected site URL from event.rawUrl: ${siteUrl}`);
            return siteUrl;
        } catch (error) {
            logger.warn('Failed to parse event.rawUrl:', error.message);
        }
    }

    // Priority 2: Extract from headers.host
    if (event?.headers?.host) {
        const protocol = event.headers['x-forwarded-proto'] || 'https';
        const siteUrl = `${protocol}://${event.headers.host}`;
        logger.info(`Detected site URL from event.headers.host: ${siteUrl}`);
        return siteUrl;
    }

    // Priority 3: Decode from context.clientContext.custom.netlify (base64-encoded JSON)
    if (context?.clientContext?.custom?.netlify) {
        try {
            const decoded = Buffer.from(context.clientContext.custom.netlify, 'base64').toString('utf-8');
            const data = JSON.parse(decoded);
            if (data.site_url) {
                logger.info(`Detected site URL from context.clientContext: ${data.site_url}`);
                return data.site_url;
            }
        } catch (error) {
            logger.warn('Failed to decode context.clientContext.custom.netlify:', error.message);
        }
    }

    // Priority 4: Fallback to environment variables (rarely available for scheduled functions)
    if (process.env.SCHEDULED_FUNCTION_TARGET_URL) {
        logger.info(`Using explicit target URL: ${process.env.SCHEDULED_FUNCTION_TARGET_URL}`);
        return process.env.SCHEDULED_FUNCTION_TARGET_URL;
    }

    if (process.env.DEPLOY_PRIME_URL) {
        return process.env.DEPLOY_PRIME_URL;
    }
    if (process.env.DEPLOY_URL) {
        return process.env.DEPLOY_URL;
    }

    // Priority 5: Default to production URL
    const fallbackUrl = process.env.URL || 'https://syntegoneolchecker.netlify.app';
    logger.info(`Using fallback URL: ${fallbackUrl}`);
    return fallbackUrl;
}

const handler = async (event, context) => {
    logger.info('Scheduled EOL check triggered at:', new Date().toISOString());

    try {
        const siteUrl = getCurrentDeploymentUrl(event, context);
        logger.info(`Using site URL: ${siteUrl}`);

        const store = getStore({
            name: 'auto-check-state',
            siteID: process.env.SITE_ID,
            token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_TOKEN
        });

        // Get current state
        let state = await store.get('state', { type: 'json' });

        if (!state) {
            logger.info('Auto-check state not initialized, skipping');
            return {
                statusCode: 200,
                body: JSON.stringify({ message: 'State not initialized' })
            };
        }

        logger.info('Current state:', state);

        // Check if auto-check is enabled
        if (!state.enabled) {
            logger.info('Auto-check is disabled, skipping');
            return {
                statusCode: 200,
                body: JSON.stringify({ message: 'Auto-check disabled' })
            };
        }

        // Check if already running
        if (state.isRunning) {
            logger.info('Auto-check already running, skipping');
            return {
                statusCode: 200,
                body: JSON.stringify({ message: 'Already running' })
            };
        }

        // Check if we need to reset the daily counter (new day in GMT+9)
        const currentDate = getGMT9Date();
        if (state.lastResetDate !== currentDate) {
            logger.info(`New day detected (${currentDate}), resetting counter from ${state.dailyCounter} to 0`);
            // Use set-auto-check-state to avoid race condition
            const resetResponse = await fetch(`${siteUrl}/.netlify/functions/set-auto-check-state`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ dailyCounter: 0, lastResetDate: currentDate })
            });
            if (!resetResponse.ok) {
                logger.error('Failed to reset counter');
            }
            // Re-fetch state after update
            state = await store.get('state', { type: 'json' });
        }

        // Check if we've already done 20 checks today
        if (state.dailyCounter >= 20) {
            logger.info('Daily limit reached (20 checks), skipping');
            return {
                statusCode: 200,
                body: JSON.stringify({ message: 'Daily limit reached' })
            };
        }

        // Check Tavily credits
        const tavilyResponse = await fetch(`${siteUrl}/.netlify/functions/get-tavily-usage`);
        if (tavilyResponse.ok) {
            const tavilyData = await tavilyResponse.json();
            if (tavilyData.remaining <= 50) {
                logger.info(`Tavily credits too low (${tavilyData.remaining}), disabling auto-check`);
                // Use set-auto-check-state to avoid race condition
                await fetch(`${siteUrl}/.netlify/functions/set-auto-check-state`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled: false })
                });
                return {
                    statusCode: 200,
                    body: JSON.stringify({ message: 'Credits too low, auto-check disabled' })
                };
            }
        }

        // All checks passed - trigger the background function
        logger.info('Triggering background EOL check...');

        // Mark as running - use set-auto-check-state to avoid race condition
        await fetch(`${siteUrl}/.netlify/functions/set-auto-check-state`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ isRunning: true })
        });

        // Trigger the background function
        const backgroundUrl = `${siteUrl}/.netlify/functions/auto-eol-check-background`;
        logger.info(`Triggering background function at: ${backgroundUrl}`);
        logger.info(`Environment: DEPLOY_PRIME_URL=${process.env.DEPLOY_PRIME_URL}, DEPLOY_URL=${process.env.DEPLOY_URL}, URL=${process.env.URL}`);

        const triggerResponse = await fetch(backgroundUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                triggeredBy: 'scheduled',
                siteUrl: siteUrl
            })
        });

        logger.info('Background function triggered, status:', triggerResponse.status);
        if (!triggerResponse.ok) {
            const errorText = await triggerResponse.text();
            logger.error('Background function error response:', errorText);
        }

        return {
            statusCode: 200,
            body: JSON.stringify({
                message: 'Background EOL check started',
                currentCounter: state.dailyCounter
            })
        };

    } catch (error) {
        logger.error('Scheduled check error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};

// Schedule to run daily at 12:00 UTC (21:00 GMT+9)
exports.handler = schedule('0 12 * * *', handler);
