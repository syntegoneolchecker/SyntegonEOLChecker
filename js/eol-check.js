// ============================================================================
// EOL CHECKING FUNCTIONALITY
// ============================================================================

import { state, setIsManualCheckRunning } from './state.js';
import { showStatus, isRenderServiceHealthy, updateRowInOriginalData, delay } from './utils.js';
import { render } from './table.js';
import { saveToServer } from './api.js';
import { loadSerpAPICredits, updateGroqRateLimits, checkRenderHealth, startGroqCountdown } from './credits.js';
import { toggleDeleteButtons } from './ui.js';

// ============================================================================
// EOL CHECK FLOW
// ============================================================================

/**
 * Validate EOL inputs
 */
function validateEOLInputs(model, manufacturer) {
    if (!model || !manufacturer) {
        showStatus('Error: Model and Manufacturer are required for EOL check', 'error');
        return false;
    }
    return true;
}

/**
 * Wake up Render service and validate it's healthy
 */
async function wakeRenderService(checkButton) {
    checkButton.textContent = 'Waking Render...';
    showStatus(`Waking up scraping service...`, 'info', false);
    await checkRenderHealth();

    if (!isRenderServiceHealthy()) {
        const renderStatusElement = document.getElementById('render-status');
        const renderStatusText = renderStatusElement.textContent;
        showStatus(`Error: Render Scraping Service is not available (${renderStatusText}). Please reload the page and try again.`, 'error');
        return false;
    }

    return true;
}

/**
 * Initialize EOL job
 */
async function initializeEOLJob(model, manufacturer) {
    const initResponse = await fetch('/.netlify/functions/initialize-job', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, maker: manufacturer })
    });

    if (!initResponse.ok) {
        const errorData = await initResponse.json();
        throw new Error(errorData.error || `HTTP error! status: ${initResponse.status}`);
    }

    const initData = await initResponse.json();
    console.log('Job initialized:', initData);

    if (!initData.jobId) {
        throw new Error('No job ID received');
    }

    return initData.jobId;
}

/**
 * Update row with EOL results
 */
async function updateRowWithEOLResults(rowIndex, result) {
    const row = state.data[rowIndex];

    row[5] = result.status || 'UNKNOWN';
    row[6] = result.explanation || '';
    row[7] = result.successor?.model || '';
    row[8] = result.successor?.explanation || '';
    row[11] = new Date().toLocaleString();

    updateRowInOriginalData(row);

    render();
    await saveToServer();

    await loadSerpAPICredits();
    if (result.rateLimits) {
        updateGroqRateLimits(result.rateLimits);
    }
}

/**
 * Disable all Check EOL buttons
 */
export function disableAllCheckEOLButtons() {
    setIsManualCheckRunning(true);

    const toggle = document.getElementById('delete-toggle');
    if (toggle.checked) {
        toggle.checked = false;
        toggleDeleteButtons();
    }

    document.querySelectorAll('button, input[type="checkbox"]').forEach(button => {
        if (button.id === 'check-eol-button' || button.id === 'manual-trigger-btn' || button.id === 'delete-toggle') {
            button.disabled = true;
        }
    });
    console.log('Check EOL buttons, manual trigger button and delete toggle disabled (manual check in progress)');
}

/**
 * Enable all Check EOL buttons
 */
export function enableAllCheckEOLButtons() {
    setIsManualCheckRunning(false);
    document.querySelectorAll('button, input[type="checkbox"]').forEach(button => {
        if (button.id === 'check-eol-button') {
            button.disabled = false;
            button.textContent = 'Check EOL';
        } else if (button.id === 'manual-trigger-btn' || button.id === 'delete-toggle') {
            button.disabled = false;
        }
    });
    console.log('Check EOL buttons, manual trigger button and delete toggle re-enabled (manual check complete)');
}

/**
 * Main EOL check function
 */
export async function checkEOL(rowIndex) {
    const row = state.data[rowIndex];
    const model = row[3];
    const manufacturer = row[4];

    if (!validateEOLInputs(model, manufacturer)) return;

    disableAllCheckEOLButtons();

    try {
        const rowElement = document.getElementById(`row-${rowIndex}`);
        const checkButton = rowElement.querySelector('.check-eol');

        if (!await wakeRenderService(checkButton)) {
            enableAllCheckEOLButtons();
            return;
        }

        checkButton.textContent = 'Initializing...';
        showStatus(`Initializing EOL check for ${manufacturer} ${model}...`, 'info', false);

        const jobId = await initializeEOLJob(model, manufacturer);

        checkButton.textContent = 'Processing...';
        const result = await pollJobStatus(jobId, manufacturer, model, checkButton);

        await updateRowWithEOLResults(rowIndex, result);

        showStatus(`✓ EOL check completed for ${manufacturer} ${model}`, 'success');
        enableAllCheckEOLButtons();

    } catch (error) {
        console.error('EOL check failed:', error);
        showStatus(`Error checking EOL: ${error.message}`, 'error');
        enableAllCheckEOLButtons();
    }
}

// ============================================================================
// JOB POLLING FUNCTIONALITY
// ============================================================================

/**
 * Update job progress display
 */
function updateJobProgress(statusData, manufacturer, model, checkButton) {
    const progress = `${statusData.completedUrls || 0}/${statusData.urlCount || 0}`;
    if (checkButton) {
        checkButton.textContent = `Processing (${progress})`;
    }
    showStatus(`Checking ${manufacturer} ${model}... (${progress} pages)`, 'info', false);
}

/**
 * Check if we should trigger fetch-url
 */
function shouldTriggerFetch(statusData, fetchTriggered) {
    return statusData.status === 'urls_ready' &&
           !fetchTriggered &&
           statusData.urls &&
           statusData.urls.length > 0 &&
           statusData.urls[0].status === 'pending';
}

/**
 * Build fetch-url payload
 */
function buildFetchPayload(jobId, firstUrl) {
    const payload = {
        jobId,
        urlIndex: firstUrl.index,
        url: firstUrl.url,
        title: firstUrl.title,
        snippet: firstUrl.snippet,
        scrapingMethod: firstUrl.scrapingMethod
    };

    if (firstUrl.model) payload.model = firstUrl.model;
    if (firstUrl.jpUrl) payload.jpUrl = firstUrl.jpUrl;
    if (firstUrl.usUrl) payload.usUrl = firstUrl.usUrl;

    return payload;
}

/**
 * Trigger fetch-url with retry
 */
async function triggerFetchUrl(jobId, firstUrl, attempts) {
    console.log(`✓ URLs ready, triggering fetch-url (attempt ${attempts})`);

    const payload = buildFetchPayload(jobId, firstUrl);
    const maxRetries = 2;

    for (let retry = 0; retry <= maxRetries; retry++) {
        try {
            const response = await fetch('/.netlify/functions/fetch-url', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(120000)
            });

            if (response.ok) {
                console.log(`✓ fetch-url triggered successfully for ${firstUrl.url}`);
                return;
            }

            console.warn(`⚠️  fetch-url returned ${response.status} (retry ${retry}/${maxRetries})`);

        } catch (err) {
            if (err.name === 'TimeoutError' || err.name === 'AbortError') {
                console.log(`⏱️  fetch-url request timed out - function likely still running server-side, NOT retrying`);
                return;
            }

            console.error(`Failed to trigger fetch-url (retry ${retry}/${maxRetries}): ${err.message}`);
        }

        if (retry < maxRetries) {
            await delay(1000 * (retry + 1));
        }
    }

    console.error(`❌ fetch-url failed after ${maxRetries + 1} attempts for ${firstUrl.url}`);
}

/**
 * Check if all URLs are complete
 */
function areAllUrlsComplete(statusData) {
    return statusData.urls &&
           statusData.urls.length > 0 &&
           statusData.urls.every(u => u.status === 'complete');
}

/**
 * Check if we should trigger analyze-job
 */
function shouldTriggerAnalyze(statusData, analyzeTriggered) {
    return areAllUrlsComplete(statusData) &&
           !analyzeTriggered &&
           statusData.status !== 'analyzing' &&
           statusData.status !== 'complete';
}

/**
 * Trigger analyze-job with retry
 */
async function triggerAnalyzeJob(jobId, attempts) {
    console.log(`✓ All URLs scraped, triggering analyze-job (attempt ${attempts})`);

    const maxRetries = 2;

    for (let retry = 0; retry <= maxRetries; retry++) {
        try {
            const response = await fetch('/.netlify/functions/analyze-job', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jobId }),
                signal: AbortSignal.timeout(120000)
            });

            if (response.ok) {
                console.log(`✓ analyze-job triggered successfully`);
                return;
            }

            console.warn(`⚠️  analyze-job returned ${response.status} (retry ${retry}/${maxRetries})`);

        } catch (err) {
            if (err.name === 'TimeoutError' || err.name === 'AbortError') {
                console.log(`⏱️  analyze-job request timed out - function likely still running server-side, NOT retrying`);
                return;
            }

            console.error(`Failed to trigger analyze-job (retry ${retry}/${maxRetries}): ${err.message}`);
        }

        if (retry < maxRetries) {
            await delay(1000 * (retry + 1));
        }
    }

    console.error(`❌ analyze-job failed after ${maxRetries + 1} attempts`);
}

/**
 * Handle daily limit error
 */
function handleDailyLimitError(statusData) {
    if (statusData.isDailyLimit && statusData.retrySeconds) {
        console.log(`Daily limit hit, starting countdown for ${statusData.retrySeconds}s`);
        startGroqCountdown(statusData.retrySeconds);
    }
}

/**
 * Get job status
 */
async function getJobStatus(jobId) {
    const statusResponse = await fetch(`/.netlify/functions/job-status/${jobId}`);

    if (!statusResponse.ok) {
        throw new Error(`Status check failed: ${statusResponse.status}`);
    }

    return await statusResponse.json();
}

/**
 * Create timeout result
 */
function createTimeoutResult(maxAttempts) {
    console.warn(`Job timed out after ${maxAttempts} attempts (2 minutes)`);
    return {
        status: 'UNKNOWN',
        explanation: `EOL check timed out after ${maxAttempts} polling attempts (2 minutes). Please try again later.`,
        successor: {
            status: 'UNKNOWN',
            model: null,
            explanation: ''
        }
    };
}

/**
 * Poll job status until complete
 */
export async function pollJobStatus(jobId, manufacturer, model, checkButton) {
    const maxAttempts = 60;
    let attempts = 0;
    let fetchTriggered = false;
    let analyzeTriggered = false;

    while (attempts < maxAttempts) {
        attempts++;

        try {
            console.log(`Polling job status (attempt ${attempts})...`);
            const statusData = await getJobStatus(jobId);
            console.log(`Job status received:`, JSON.stringify({
                status: statusData.status,
                urlCount: statusData.urlCount,
                completedUrls: statusData.completedUrls,
                urlsLength: statusData.urls?.length,
                firstUrlStatus: statusData.urls?.[0]?.status
            }));

            console.log(`Trigger flags: fetchTriggered=${fetchTriggered}, analyzeTriggered=${analyzeTriggered}`);

            updateJobProgress(statusData, manufacturer, model, checkButton);

            if (statusData.status === 'complete') {
                console.log('Job complete, returning result');
                return statusData.result;
            }

            if (statusData.status === 'error') {
                console.log('Job error detected');
                handleDailyLimitError(statusData);
                throw new Error(statusData.error || 'Job failed');
            }

            const shouldFetch = shouldTriggerFetch(statusData, fetchTriggered);
            console.log(`shouldTriggerFetch=${shouldFetch}`);

            if (shouldFetch) {
                console.log(`Triggering fetch-url for URL index 0:`, statusData.urls[0].url);
                await triggerFetchUrl(jobId, statusData.urls[0], attempts);
                fetchTriggered = true;
                console.log(`fetch-url triggered, setting fetchTriggered=true`);
            }

            const shouldAnalyze = shouldTriggerAnalyze(statusData, analyzeTriggered);
            console.log(`shouldTriggerAnalyze=${shouldAnalyze}`);

            if (shouldAnalyze) {
                console.log(`Triggering analyze-job`);
                await triggerAnalyzeJob(jobId, attempts);
                analyzeTriggered = true;
                console.log(`analyze-job triggered, setting analyzeTriggered=true`);
            }

            await delay(2000);

        } catch (error) {
            console.error('Polling error:', error);
            throw error;
        }
    }

    return createTimeoutResult(maxAttempts);
}
