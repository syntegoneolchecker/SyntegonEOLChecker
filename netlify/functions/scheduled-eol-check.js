// Scheduled function that triggers daily at 21:00 GMT+9 (12:00 UTC)
// Checks if auto-check is enabled and starts the background checking process
const { getStore } = require('@netlify/blobs');
const { schedule } = require('@netlify/functions');

// Helper: Get current date in GMT+9 timezone
function getGMT9Date() {
    const now = new Date();
    // Convert to GMT+9 (add 9 hours to UTC)
    const gmt9Time = new Date(now.getTime() + (9 * 60 * 60 * 1000));
    return gmt9Time.toISOString().split('T')[0]; // YYYY-MM-DD
}

// Helper: Detect current deployment URL for scheduled functions
function getCurrentDeploymentUrl() {
    // For scheduled functions, DEPLOY_PRIME_URL and DEPLOY_URL are often undefined
    // We need to construct the URL based on available environment variables

    // Check if we have explicit deployment URLs (HTTP-triggered functions have these)
    if (process.env.DEPLOY_PRIME_URL) {
        return process.env.DEPLOY_PRIME_URL;
    }
    if (process.env.DEPLOY_URL) {
        return process.env.DEPLOY_URL;
    }

    // For scheduled functions, check CONTEXT to determine deployment type
    const context = process.env.CONTEXT; // Can be: "production", "deploy-preview", "branch-deploy"
    const branch = process.env.BRANCH || process.env.HEAD; // Branch name
    const url = process.env.URL; // Production URL

    console.log(`Deployment context: CONTEXT=${context}, BRANCH=${branch}, URL=${url}`);

    // If we're on a branch deploy, construct the branch URL
    if (context === 'branch-deploy' && branch && branch !== 'main' && url) {
        // Extract site name from production URL
        // e.g., https://syntegoneolchecker.netlify.app → syntegoneolchecker
        const siteName = url.replace('https://', '').replace('.netlify.app', '');
        const branchUrl = `https://${branch}--${siteName}.netlify.app`;
        console.log(`Constructed branch deploy URL: ${branchUrl}`);
        return branchUrl;
    }

    // Default to production URL
    return url || 'https://syntegoneolchecker.netlify.app';
}

const handler = async (event, context) => {
    console.log('Scheduled EOL check triggered at:', new Date().toISOString());

    try {
        const siteUrl = getCurrentDeploymentUrl();
        console.log(`Using site URL: ${siteUrl}`);

        const store = getStore({
            name: 'auto-check-state',
            siteID: process.env.SITE_ID,
            token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_TOKEN
        });

        // Get current state
        let state = await store.get('state', { type: 'json' });

        if (!state) {
            console.log('Auto-check state not initialized, skipping');
            return {
                statusCode: 200,
                body: JSON.stringify({ message: 'State not initialized' })
            };
        }

        console.log('Current state:', state);

        // Check if auto-check is enabled
        if (!state.enabled) {
            console.log('Auto-check is disabled, skipping');
            return {
                statusCode: 200,
                body: JSON.stringify({ message: 'Auto-check disabled' })
            };
        }

        // Check if already running
        if (state.isRunning) {
            console.log('Auto-check already running, skipping');
            return {
                statusCode: 200,
                body: JSON.stringify({ message: 'Already running' })
            };
        }

        // Check if we need to reset the daily counter (new day in GMT+9)
        const currentDate = getGMT9Date();
        if (state.lastResetDate !== currentDate) {
            console.log(`New day detected (${currentDate}), resetting counter from ${state.dailyCounter} to 0`);
            // Use set-auto-check-state to avoid race condition
            const resetResponse = await fetch(`${siteUrl}/.netlify/functions/set-auto-check-state`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ dailyCounter: 0, lastResetDate: currentDate })
            });
            if (!resetResponse.ok) {
                console.error('Failed to reset counter');
            }
            // Re-fetch state after update
            state = await store.get('state', { type: 'json' });
        }

        // Check if we've already done 20 checks today
        if (state.dailyCounter >= 20) {
            console.log('Daily limit reached (20 checks), skipping');
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
                console.log(`Tavily credits too low (${tavilyData.remaining}), disabling auto-check`);
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
        console.log('Triggering background EOL check...');

        // Mark as running - use set-auto-check-state to avoid race condition
        await fetch(`${siteUrl}/.netlify/functions/set-auto-check-state`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ isRunning: true })
        });

        // Trigger the background function
        const backgroundUrl = `${siteUrl}/.netlify/functions/auto-eol-check-background`;
        console.log(`Triggering background function at: ${backgroundUrl}`);
        console.log(`Environment: DEPLOY_PRIME_URL=${process.env.DEPLOY_PRIME_URL}, DEPLOY_URL=${process.env.DEPLOY_URL}, URL=${process.env.URL}`);

        const triggerResponse = await fetch(backgroundUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                triggeredBy: 'scheduled',
                siteUrl: siteUrl
            })
        });

        console.log('Background function triggered, status:', triggerResponse.status);
        if (!triggerResponse.ok) {
            const errorText = await triggerResponse.text();
            console.error('Background function error response:', errorText);
        }

        return {
            statusCode: 200,
            body: JSON.stringify({
                message: 'Background EOL check started',
                currentCounter: state.dailyCounter
            })
        };

    } catch (error) {
        console.error('Scheduled check error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};

// Schedule to run daily at 12:00 UTC (21:00 GMT+9)
exports.handler = schedule('0 12 * * *', handler);
