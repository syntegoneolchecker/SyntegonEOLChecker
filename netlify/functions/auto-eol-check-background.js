// Background function for automatic EOL checking (chains itself)
// Checks ONE product and triggers next check if counter < 20
const { getStore } = require('@netlify/blobs');
const { parseCSV, toCSV } = require('./lib/csv-parser');

// Helper: Get current date in GMT+9 timezone
function getGMT9Date() {
    const now = new Date();
    const gmt9Time = new Date(now.getTime() + (9 * 60 * 60 * 1000));
    return gmt9Time.toISOString().split('T')[0];
}

// Helper: Get current date and time in GMT+9 timezone (formatted like manual checks)
function getGMT9DateTime() {
    const now = new Date();
    // Use Asia/Tokyo timezone to match GMT+9
    return now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' });
}

// Helper: Wake up Render scraping service (cold start)
async function wakeRenderService() {
    console.log('Waking up Render scraping service...');
    const startTime = Date.now();

    try {
        const response = await fetch('https://eolscrapingservice.onrender.com/health', {
            signal: AbortSignal.timeout(30000) // 30s timeout
        });

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`Render service responded in ${elapsed}s, status: ${response.status}`);

        return response.ok;
    } catch (error) {
        console.error('Failed to wake Render service:', error.message);
        return false;
    }
}

// Helper: Check if Groq tokens are ready (N/A means fully reset)
async function checkGroqTokens(siteUrl) {
    try {
        const response = await fetch(`${siteUrl}/.netlify/functions/get-groq-usage`);
        if (!response.ok) return true; // Assume OK if can't check

        const data = await response.json();

        // Check if resetSeconds is null or undefined (means N/A)
        if (data.resetSeconds === null || data.resetSeconds === undefined) {
            console.log('Groq tokens fully reset (N/A)');
            return true;
        }

        // Wait for reset if needed
        if (data.resetSeconds > 0) {
            console.log(`Groq tokens reset in ${data.resetSeconds}s, waiting...`);
            await new Promise(resolve => setTimeout(resolve, (data.resetSeconds + 1) * 1000));
            console.log('Groq tokens should be reset now');
            return true;
        }

        return true;
    } catch (error) {
        console.error('Error checking Groq tokens:', error.message);
        return true; // Proceed anyway
    }
}

// Helper: Check if Auto Check is enabled for a product row
function isAutoCheckEnabled(row) {
    const autoCheckValue = (row[12] || '').trim().toUpperCase();

    // Auto Check column (column 12):
    // - "YES" or blank/whitespace: enabled (process this product)
    // - "NO": disabled (skip this product)

    if (autoCheckValue === '' || autoCheckValue === 'YES') {
        return true;
    }

    if (autoCheckValue === 'NO') {
        return false;
    }

    // For any other value, default to enabled
    return true;
}

// Helper: Find next product to check
async function findNextProduct() {
    try {
        // Get database
        const csvStore = getStore({
            name: 'eol-database',
            siteID: process.env.SITE_ID,
            token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_TOKEN
        });
        const csvContent = await csvStore.get('database.csv');

        if (!csvContent) {
            console.log('No products in database');
            return null;
        }

        // Parse CSV using shared utility
        const data = parseCSV(csvContent);

        if (data.length <= 1) {
            console.log('No products in database (only headers)');
            return null;
        }

        const rows = data.slice(1); // Skip header

        // Filter out products with Auto Check = NO
        const autoCheckEnabledRows = rows.filter(row => isAutoCheckEnabled(row));

        if (autoCheckEnabledRows.length === 0) {
            console.log('No products with Auto Check enabled');
            return null;
        }

        console.log(`Total products: ${rows.length}, Auto Check enabled: ${autoCheckEnabledRows.length}, Auto Check disabled: ${rows.length - autoCheckEnabledRows.length}`);

        // Priority 1: Products with empty Information Date (column 11)
        const unchecked = autoCheckEnabledRows.filter(row => !row[11] || row[11].trim() === '');
        if (unchecked.length > 0) {
            console.log(`Found ${unchecked.length} unchecked products (with Auto Check enabled), selecting first`);
            return unchecked[0];
        }

        // Priority 2: Product with oldest Information Date
        const checked = autoCheckEnabledRows.filter(row => row[11] && row[11].trim() !== '');
        if (checked.length === 0) {
            console.log('All products checked, no oldest found');
            return null;
        }

        // Sort by date (oldest first)
        checked.sort((a, b) => {
            const dateA = new Date(a[11]);
            const dateB = new Date(b[11]);
            return dateA - dateB;
        });

        console.log(`Found ${checked.length} checked products (with Auto Check enabled), selecting oldest: ${checked[0][11]}`);
        return checked[0];

    } catch (error) {
        console.error('Error finding next product:', error);
        return null;
    }
}

// Helper: Execute EOL check for a product
async function executeEOLCheck(product, siteUrl) {
    const model = product[3]; // Column 3
    const manufacturer = product[4]; // Column 4
    const sapNumber = product[0]; // Column 0

    console.log(`Executing EOL check for: ${manufacturer} ${model} (SAP: ${sapNumber})`);

    if (!model || !manufacturer) {
        console.log('Missing model or manufacturer, skipping');
        return false;
    }

    try {
        console.log(`Using site URL: ${siteUrl}`);

        // Initialize job
        const initUrl = `${siteUrl}/.netlify/functions/initialize-job`;
        console.log(`Calling initialize-job at: ${initUrl}`);

        const initResponse = await fetch(initUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, maker: manufacturer })
        });

        if (!initResponse.ok) {
            const errorText = await initResponse.text();
            console.error('Job initialization failed:', initResponse.status, errorText);
            return false;
        }

        const initData = await initResponse.json();
        const jobId = initData.jobId;

        if (!jobId) {
            console.error('No job ID received');
            return false;
        }

        console.log(`Job initialized: ${jobId}`);

        // Poll for completion (max 60 attempts = 2 minutes)
        const result = await pollJobStatus(jobId, manufacturer, model, siteUrl);

        if (!result) {
            console.error('Job polling failed');
            return false;
        }

        // Update the product in database
        await updateProduct(sapNumber, result);

        console.log(`✓ EOL check completed for ${manufacturer} ${model}`);
        return true;

    } catch (error) {
        console.error('EOL check error:', error);
        return false;
    }
}

// Helper: Poll job by checking Blobs directly and orchestrating workflow
async function pollJobStatus(jobId, manufacturer, model, siteUrl) {
    const maxAttempts = 60; // 60 attempts × 2s = 2 minutes max
    let attempts = 0;
    let analyzeTriggered = false;
    let fetchTriggered = false;

    // Get job storage helper
    const { getStore } = require('@netlify/blobs');
    const { updateJobStatus } = require('./lib/job-storage');
    const jobStore = getStore({
        name: 'eol-jobs',
        siteID: process.env.SITE_ID,
        token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_TOKEN
    });

    console.log(`Polling job ${jobId} (max ${maxAttempts} attempts, 2 minutes)`);

    while (attempts < maxAttempts) {
        attempts++;

        // Log progress every 30 attempts (~1 minute)
        if (attempts % 30 === 0) {
            console.log(`Polling attempt ${attempts}/${maxAttempts} (~${Math.round(attempts * 2 / 60)} min elapsed)...`);
        }

        // RENDER HEALTH CHECK: At attempt 15 (~30 seconds), check if Render crashed
        // This saves ~90 seconds compared to waiting for full timeout (60 attempts = 2 minutes)
        if (attempts === 15) {
            console.log('Polling attempt 15/60 (~30s elapsed) - checking Render service health...');
            try {
                const renderHealthUrl = 'https://eolscrapingservice.onrender.com/health';
                const healthResponse = await fetch(renderHealthUrl, {
                    signal: AbortSignal.timeout(5000) // 5s timeout
                });

                if (!healthResponse.ok) {
                    console.error(`⚠️  Render service unhealthy at attempt 15 (HTTP ${healthResponse.status})`);
                    console.log('Likely cause: Render crashed during scraping. Skipping this check to save time.');

                    return {
                        status: 'UNKNOWN',
                        explanation: 'EOL check skipped - scraping service crashed during processing (detected at 30s). This product will be retried on the next check cycle.',
                        successor: { status: 'UNKNOWN', model: null, explanation: '' }
                    };
                }

                const healthData = await healthResponse.json();
                console.log(`✓ Render service healthy (memory: ${healthData.memory?.rss || 'N/A'}MB, requests: ${healthData.requestCount || 'N/A'})`);
            } catch (healthError) {
                console.error(`⚠️  Render health check failed at attempt 15: ${healthError.message}`);
                console.log('Assuming Render crashed. Skipping this check to save time.');

                return {
                    status: 'UNKNOWN',
                    explanation: 'EOL check skipped - scraping service appears to have crashed (health check failed at 30s). This product will be retried on the next check cycle.',
                    successor: { status: 'UNKNOWN', model: null, explanation: '' }
                };
            }
        }

        try {
            // Poll Blobs directly
            const job = await jobStore.get(jobId, { type: 'json' });

            if (!job) {
                console.error(`Job ${jobId} not found in Blobs storage`);
                await new Promise(resolve => setTimeout(resolve, 2000));
                continue;
            }

            // Check if job is complete
            if (job.status === 'complete' && job.finalResult) {
                console.log(`✓ Job complete after ${attempts} attempts (~${Math.round(attempts * 2 / 60)} min)`);
                return job.finalResult;
            }

            if (job.status === 'error') {
                console.error(`Job failed with error: ${job.error}`);
                return {
                    status: 'UNKNOWN',
                    explanation: `Job failed: ${job.error}`,
                    successor: { status: 'UNKNOWN', model: null, explanation: '' }
                };
            }

            // STEP 1: If URLs are ready, trigger fetch-url
            if (job.status === 'urls_ready' && !fetchTriggered) {
                console.log(`✓ URLs ready, triggering fetch-url (attempt ${attempts})`);

                // Update status to 'fetching'
                await updateJobStatus(jobId, 'fetching', null, {});

                // Trigger fetch-url for the first URL
                const firstUrl = job.urls[0];
                if (firstUrl) {
                    try {
                        const fetchUrl = `${siteUrl}/.netlify/functions/fetch-url`;
                        const payload = {
                            jobId,
                            urlIndex: firstUrl.index,
                            url: firstUrl.url,
                            title: firstUrl.title,
                            snippet: firstUrl.snippet,
                            scrapingMethod: firstUrl.scrapingMethod
                        };

                        // Pass model for KEYENCE interactive searches
                        if (firstUrl.model) {
                            payload.model = firstUrl.model;
                        }

                        // Fire-and-forget (Render scraping takes 30-60s, we can't wait)
                        fetch(fetchUrl, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(payload)
                        }).catch(err => {
                            console.error(`Failed to trigger fetch-url: ${err.message}`);
                        });

                        console.log(`✓ fetch-url triggered for ${firstUrl.url}`);
                        fetchTriggered = true;
                    } catch (error) {
                        console.error(`Error triggering fetch-url: ${error.message}`);
                    }
                }
            }

            // STEP 2: Check if scraping is complete and analysis needs to be triggered
            const allUrlsComplete = job.urls && job.urls.length > 0 && job.urls.every(u => u.status === 'complete');

            if (allUrlsComplete && !analyzeTriggered && job.status !== 'analyzing' && job.status !== 'complete') {
                console.log(`✓ All URLs scraped, triggering analyze-job synchronously (attempt ${attempts})`);

                try {
                    // Call analyze-job SYNCHRONOUSLY (not fire-and-forget)
                    const analyzeUrl = `${siteUrl}/.netlify/functions/analyze-job`;
                    const analyzeResponse = await fetch(analyzeUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ jobId }),
                        signal: AbortSignal.timeout(25000) // 25s timeout (under Netlify's 26s limit)
                    });

                    if (analyzeResponse.ok) {
                        const analyzeData = await analyzeResponse.json();
                        console.log(`✓ Analysis completed successfully: ${analyzeData.result?.status}`);
                        analyzeTriggered = true;

                        // Re-fetch job to get updated status
                        const updatedJob = await jobStore.get(jobId, { type: 'json' });
                        if (updatedJob?.status === 'complete' && updatedJob.finalResult) {
                            console.log(`✓ Job complete after analysis`);
                            return updatedJob.finalResult;
                        }
                    } else {
                        const errorText = await analyzeResponse.text().catch(() => 'Unknown error');
                        console.error(`analyze-job failed: ${analyzeResponse.status} - ${errorText}`);
                        analyzeTriggered = true; // Don't retry on same poll cycle
                    }
                } catch (error) {
                    // Timeout or network error - analysis might still be running
                    if (error.name === 'TimeoutError' || error.message.includes('timeout')) {
                        console.warn(`analyze-job timed out after 25s (likely Groq token wait), will check on next poll`);
                        analyzeTriggered = true; // Analysis is running in background
                    } else {
                        console.error(`analyze-job error: ${error.message}`);
                        analyzeTriggered = true; // Don't retry on same poll cycle
                    }
                }
            }

            // Wait 2 seconds before next poll
            await new Promise(resolve => setTimeout(resolve, 2000));

        } catch (error) {
            console.error(`Polling error (attempt ${attempts}): ${error.message}`);
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }

    // Timeout after max attempts
    const timeoutMinutes = Math.round(maxAttempts * 2 / 60);
    console.error(`⏱️  Job ${jobId} timed out after ${maxAttempts} attempts (~${timeoutMinutes} minutes)`);

    return {
        status: 'UNKNOWN',
        explanation: `EOL check timed out after ${timeoutMinutes} minutes. The job may still be processing. Check Netlify function logs for details.`,
        successor: { status: 'UNKNOWN', model: null, explanation: '' }
    };
}

// Helper: Update product in database
async function updateProduct(sapNumber, result) {
    try {
        const csvStore = getStore({
            name: 'eol-database',
            siteID: process.env.SITE_ID,
            token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_TOKEN
        });
        const csvContent = await csvStore.get('database.csv');

        if (!csvContent) {
            console.error('Database not found');
            return;
        }

        // Parse CSV using shared utility
        const data = parseCSV(csvContent);

        // Find product by SAP number
        const rowIndex = data.findIndex((row, i) => i > 0 && row[0] === sapNumber);

        if (rowIndex === -1) {
            console.error(`Product ${sapNumber} not found in database`);
            return;
        }

        const row = data[rowIndex];

        // Update columns
        row[5] = result.status || 'UNKNOWN'; // Status
        row[6] = result.explanation || ''; // Status Comment
        row[7] = result.successor?.model || ''; // Successor Model
        row[8] = result.successor?.explanation || ''; // Successor Comment
        row[11] = getGMT9DateTime(); // Information Date (GMT+9 to match manual checks)

        // Convert back to CSV using shared utility
        const updatedCsv = toCSV(data);

        // Save updated database
        await csvStore.set('database.csv', updatedCsv);

        console.log(`Database updated for ${sapNumber}`);

    } catch (error) {
        console.error('Error updating product:', error);
    }
}

// Main handler
exports.handler = async function(event, context) {
    console.log('='.repeat(60));
    console.log('Background EOL check started:', new Date().toISOString());
    console.log('='.repeat(60));

    try {
        // Parse the request body to get siteUrl
        const body = JSON.parse(event.body || '{}');
        const passedSiteUrl = body.siteUrl;

        // Use passed siteUrl or fall back to environment variables
        const siteUrl = passedSiteUrl || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL || process.env.URL || 'https://develop--syntegoneolchecker.netlify.app';
        console.log(`Site URL: ${siteUrl} (${passedSiteUrl ? 'passed from caller' : 'from environment'})`);

        const store = getStore({
            name: 'auto-check-state',
            siteID: process.env.SITE_ID,
            token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_TOKEN
        });

        // Get current state
        let state = await store.get('state', { type: 'json' });

        if (!state) {
            console.log('State not initialized');
            return { statusCode: 200, body: 'State not initialized' };
        }

        // Check if enabled
        if (!state.enabled) {
            console.log('Auto-check disabled, stopping');
            // Use set-auto-check-state to avoid race condition
            await fetch(`${siteUrl}/.netlify/functions/set-auto-check-state`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ isRunning: false })
            });
            return { statusCode: 200, body: 'Disabled' };
        }

        // Check if new day (reset counter at GMT+9 midnight)
        const currentDate = getGMT9Date();
        if (state.lastResetDate !== currentDate) {
            console.log(`New day detected (${currentDate}), resetting counter`);
            // Use set-auto-check-state to avoid race condition
            await fetch(`${siteUrl}/.netlify/functions/set-auto-check-state`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ dailyCounter: 0, lastResetDate: currentDate })
            });
            // Re-fetch state after update
            state = await store.get('state', { type: 'json' });
        }

        // Check if daily limit reached
        if (state.dailyCounter >= 20) {
            console.log('Daily limit reached (20 checks)');
            // Use set-auto-check-state to avoid race condition
            await fetch(`${siteUrl}/.netlify/functions/set-auto-check-state`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ isRunning: false })
            });
            return { statusCode: 200, body: 'Daily limit reached' };
        }

        console.log(`Current progress: ${state.dailyCounter}/20 checks today`);

        // Wake Render service (only on first check of the day)
        if (state.dailyCounter === 0) {
            const renderReady = await wakeRenderService();
            if (!renderReady) {
                console.warn('Render service not ready, will retry next time');
                // Use set-auto-check-state to avoid race condition
                await fetch(`${siteUrl}/.netlify/functions/set-auto-check-state`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ isRunning: false })
                });
                return { statusCode: 200, body: 'Render not ready' };
            }
        }

        // Wait for Groq tokens
        await checkGroqTokens(siteUrl);

        // Small delay before processing (replaces delay between checks)
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Find next product to check
        const product = await findNextProduct();
        if (!product) {
            console.log('No more products to check');
            // Use set-auto-check-state to avoid race condition
            await fetch(`${siteUrl}/.netlify/functions/set-auto-check-state`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ isRunning: false })
            });
            return { statusCode: 200, body: 'No products to check' };
        }

        // Re-check state RIGHT BEFORE starting EOL check (user may have disabled during prep)
        const preCheckState = await store.get('state', { type: 'json' });
        console.log(`Pre-check state: enabled=${preCheckState.enabled}, counter=${preCheckState.dailyCounter}, isRunning=${preCheckState.isRunning}`);

        if (!preCheckState.enabled) {
            console.log('🛑 Auto-check disabled before starting EOL check, stopping chain');
            // Use set-auto-check-state to avoid race condition
            await fetch(`${siteUrl}/.netlify/functions/set-auto-check-state`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ isRunning: false })
            });
            return { statusCode: 200, body: 'Disabled before check' };
        }

        console.log('✓ Slider still enabled, proceeding with EOL check');

        // Execute ONE EOL check
        const success = await executeEOLCheck(product, siteUrl);

        // Increment counter and update activity time (even if failed - count toward daily limit)
        // FIX #5: Keep isRunning=true during chain execution for accurate state tracking
        const newCounter = preCheckState.dailyCounter + 1;
        await fetch(`${siteUrl}/.netlify/functions/set-auto-check-state`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                dailyCounter: newCounter,
                lastActivityTime: new Date().toISOString(),
                isRunning: true  // Explicitly maintain running state during chain
            })
        });

        console.log(`Check ${success ? 'succeeded' : 'failed'}, counter now: ${newCounter}/20`);

        // Check if we should continue (re-fetch state to get latest enabled status)
        const freshState = await store.get('state', { type: 'json' });
        console.log(`Post-check state: enabled=${freshState.enabled}, counter=${freshState.dailyCounter}, isRunning=${freshState.isRunning}`);

        const shouldContinue = freshState.enabled && freshState.dailyCounter < 20;

        if (shouldContinue) {
            // Trigger next check by calling this function again
            console.log('✓ Slider still enabled, triggering next check...');
            const nextCheckUrl = `${siteUrl}/.netlify/functions/auto-eol-check-background`;

            try {
                // Fire and forget - don't wait for response
                fetch(nextCheckUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        triggeredBy: 'chain',
                        siteUrl: siteUrl
                    })
                }).catch(err => {
                    console.error('Failed to trigger next check:', err.message);
                });

                console.log('Next check triggered');
            } catch (error) {
                console.error('Error triggering next check:', error.message);
            }
        } else {
            // Chain complete
            const reason = !freshState.enabled ? 'slider disabled' : 'daily limit reached';
            console.log(`🛑 Chain stopped: ${reason} (enabled=${freshState.enabled}, counter=${freshState.dailyCounter}/20)`);
            // Use set-auto-check-state to avoid race condition
            await fetch(`${siteUrl}/.netlify/functions/set-auto-check-state`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ isRunning: false })
            });
        }

        return {
            statusCode: 202, // Accepted (background processing)
            body: JSON.stringify({
                message: 'Check completed',
                counter: newCounter,
                nextTriggered: shouldContinue
            })
        };

    } catch (error) {
        console.error('Background function error:', error);

        // Mark as not running on error
        try {
            // Determine siteUrl for error handling
            const body = JSON.parse(event.body || '{}');
            const passedSiteUrl = body.siteUrl;
            const errorSiteUrl = passedSiteUrl || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL || process.env.URL || 'https://develop--syntegoneolchecker.netlify.app';

            // Use set-auto-check-state to avoid race condition
            await fetch(`${errorSiteUrl}/.netlify/functions/set-auto-check-state`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ isRunning: false })
            });
        } catch (e) {
            console.error('Failed to update state on error:', e);
        }

        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};
