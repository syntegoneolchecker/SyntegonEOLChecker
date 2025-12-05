// Background function for automatic EOL checking (chains itself)
// Checks ONE product and triggers next check if counter < 20
const { getStore } = require('@netlify/blobs');

// Helper: Get current date in GMT+9 timezone
function getGMT9Date() {
    const now = new Date();
    const gmt9Time = new Date(now.getTime() + (9 * 60 * 60 * 1000));
    return gmt9Time.toISOString().split('T')[0];
}

// Helper: Wake up Render scraping service
async function wakeRenderService() {
    console.log('Waking up Render scraping service...');
    const startTime = Date.now();

    try {
        const response = await fetch('https://eolscrapingservice.onrender.com/health', {
            signal: AbortSignal.timeout(65000) // 65s timeout
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

        // Parse CSV (same as get-csv.js)
        const lines = csvContent.split('\n').filter(line => line.trim());
        const data = lines.map(line => {
            const cells = [];
            let current = '';
            let inQuotes = false;

            for (let i = 0; i < line.length; i++) {
                const char = line[i];
                const nextChar = line[i + 1];

                if (char === '"' && !inQuotes) {
                    inQuotes = true;
                } else if (char === '"' && inQuotes && nextChar === '"') {
                    current += '"';
                    i++;
                } else if (char === '"' && inQuotes) {
                    inQuotes = false;
                } else if (char === ',' && !inQuotes) {
                    cells.push(current.trim());
                    current = '';
                } else {
                    current += char;
                }
            }
            cells.push(current.trim());
            return cells;
        });

        if (data.length <= 1) {
            console.log('No products in database (only headers)');
            return null;
        }

        const rows = data.slice(1); // Skip header

        // Priority 1: Products with empty Information Date (column 11)
        const unchecked = rows.filter(row => !row[11] || row[11].trim() === '');
        if (unchecked.length > 0) {
            console.log(`Found ${unchecked.length} unchecked products, selecting first`);
            return unchecked[0];
        }

        // Priority 2: Product with oldest Information Date
        const checked = rows.filter(row => row[11] && row[11].trim() !== '');
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

        console.log(`Found ${checked.length} checked products, selecting oldest: ${checked[0][11]}`);
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

// Helper: Poll job status
async function pollJobStatus(jobId, manufacturer, model, siteUrl) {
    const maxAttempts = 60;
    let attempts = 0;

    while (attempts < maxAttempts) {
        attempts++;

        try {
            const statusUrl = `${siteUrl}/.netlify/functions/job-status/${jobId}`;
            const statusResponse = await fetch(statusUrl);

            if (!statusResponse.ok) {
                console.error(`Status check failed: ${statusResponse.status}`);
                await new Promise(resolve => setTimeout(resolve, 2000));
                continue;
            }

            const statusData = await statusResponse.json();

            if (statusData.status === 'complete') {
                console.log(`Job complete after ${attempts} attempts`);
                return statusData.result;
            }

            if (statusData.status === 'error') {
                console.error(`Job failed: ${statusData.error}`);
                return null;
            }

            // Still processing
            await new Promise(resolve => setTimeout(resolve, 2000));

        } catch (error) {
            console.error(`Polling error (attempt ${attempts}):`, error.message);
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }

    // Timeout
    console.warn(`Job ${jobId} timed out after ${maxAttempts} attempts`);
    return {
        status: 'UNKNOWN',
        explanation: `EOL check timed out after ${maxAttempts} polling attempts (2 minutes).`,
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

        // Parse CSV
        const lines = csvContent.split('\n').filter(line => line.trim());
        const data = lines.map(line => {
            const cells = [];
            let current = '';
            let inQuotes = false;

            for (let i = 0; i < line.length; i++) {
                const char = line[i];
                const nextChar = line[i + 1];

                if (char === '"' && !inQuotes) {
                    inQuotes = true;
                } else if (char === '"' && inQuotes && nextChar === '"') {
                    current += '"';
                    i++;
                } else if (char === '"' && inQuotes) {
                    inQuotes = false;
                } else if (char === ',' && !inQuotes) {
                    cells.push(current.trim());
                    current = '';
                } else {
                    current += char;
                }
            }
            cells.push(current.trim());
            return cells;
        });

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
        row[11] = new Date().toLocaleString(); // Information Date

        // Convert back to CSV
        const updatedCsv = data.map(row =>
            row.map(cell => `"${cell}"`).join(',')
        ).join('\n');

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
            state.isRunning = false;
            await store.setJSON('state', state);
            return { statusCode: 200, body: 'Disabled' };
        }

        // Check if new day (reset counter at GMT+9 midnight)
        const currentDate = getGMT9Date();
        if (state.lastResetDate !== currentDate) {
            console.log(`New day detected (${currentDate}), resetting counter`);
            state.dailyCounter = 0;
            state.lastResetDate = currentDate;
            await store.setJSON('state', state);
        }

        // Check if daily limit reached
        if (state.dailyCounter >= 20) {
            console.log('Daily limit reached (20 checks)');
            state.isRunning = false;
            await store.setJSON('state', state);
            return { statusCode: 200, body: 'Daily limit reached' };
        }

        console.log(`Current progress: ${state.dailyCounter}/20 checks today`);

        // Wake Render service
        const renderReady = await wakeRenderService();
        if (!renderReady) {
            console.warn('Render service not ready, will retry next time');
            state.isRunning = false;
            await store.setJSON('state', state);
            return { statusCode: 200, body: 'Render not ready' };
        }

        // Wait for Groq tokens
        await checkGroqTokens(siteUrl);

        // Process products in a loop (stay within 15-min limit)
        const startTime = Date.now();
        const MAX_RUNTIME = 13 * 60 * 1000; // 13 minutes (leave 2 min buffer)
        let checksPerformed = 0;

        console.log('Starting processing loop...');

        while (state.dailyCounter < 20 && state.enabled) {
            // Check runtime limit
            const elapsed = Date.now() - startTime;
            if (elapsed > MAX_RUNTIME) {
                console.log(`Runtime limit reached (${Math.round(elapsed / 1000)}s), stopping loop`);
                break;
            }

            // Find next product
            const product = await findNextProduct();
            if (!product) {
                console.log('No more products to check');
                break;
            }

            // Execute EOL check
            const success = await executeEOLCheck(product, siteUrl);

            // Increment counter (even if failed - count toward daily limit)
            state.dailyCounter++;
            checksPerformed++;
            await store.setJSON('state', state);

            console.log(`Check ${checksPerformed} ${success ? 'succeeded' : 'failed'}, counter now: ${state.dailyCounter}/20`);

            // Small delay between checks
            if (state.dailyCounter < 20 && state.enabled) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }

        // Mark as not running when done
        state.isRunning = false;
        await store.setJSON('state', state);

        console.log(`Batch complete: ${checksPerformed} checks performed, counter: ${state.dailyCounter}/20`);

        return {
            statusCode: 202, // Accepted (background processing)
            body: JSON.stringify({
                message: 'Batch completed',
                checksPerformed: checksPerformed,
                totalCounter: state.dailyCounter
            })
        };

    } catch (error) {
        console.error('Background function error:', error);

        // Mark as not running on error
        try {
            const store = getStore({
                name: 'auto-check-state',
                siteID: process.env.SITE_ID,
                token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_TOKEN
            });
            let state = await store.get('state', { type: 'json' });
            if (state) {
                state.isRunning = false;
                await store.setJSON('state', state);
            }
        } catch (e) {
            console.error('Failed to update state on error:', e);
        }

        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};
