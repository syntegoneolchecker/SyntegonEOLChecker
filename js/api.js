// ============================================================================
// SERVER INTEGRATION (NETLIFY BLOBS)
// ============================================================================

import { state, setData, setOriginalData, resetSortState } from './state.js';
import { showStatus, delay } from './utils.js';
import { render } from './table.js';

/**
 * Save data to server
 */
export async function saveToServer() {
    try {
        const response = await fetch('/.netlify/functions/save-csv', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ data: state.data })
        });

        const result = await response.json();

        if (response.ok) {
            showStatus('Changes saved to cloud storage successfully!');
        } else {
            showStatus('Error saving changes: ' + result.error, 'error');
        }
    } catch (error) {
        showStatus('Network error - unable to save: ' + error.message, 'error');
    }
}

/**
 * Manual save database
 */
export async function manualSaveDatabase() {
    showStatus('Saving database...');
    await saveToServer();
}

/**
 * Load data from server with retry logic
 */
export async function loadFromServer() {
    const maxRetries = 3;

    for (let retry = 0; retry <= maxRetries; retry++) {
        const isLastAttempt = retry === maxRetries;
        const success = await attemptLoad(retry, maxRetries);

        if (success) return;
        if (isLastAttempt) {
            handleFinalFailure();
            return;
        }

        await waitForRetry(retry);
    }
}

async function attemptLoad(retry, maxRetries) {
    try {
        await handleRetryStatus(retry, maxRetries);
        const result = await fetchData();

        if (isValidData(result)) {
            processSuccessfulLoad(result, retry);
            return true;
        }
    } catch (error) {
        handleLoadError(error, retry, maxRetries);
    }
    return false;
}

async function handleRetryStatus(retry, maxRetries) {
    if (retry === 0) return;

    const statusMessage = `Retrying... (attempt ${retry + 1} of ${maxRetries + 1})`;
    showStatus(statusMessage, 'info');
    console.log(`Database load retry ${retry}/${maxRetries}`);
}

async function fetchData() {
    const response = await fetch('/.netlify/functions/get-csv');

    if (!response.ok) {
        throw new Error(`Server returned ${response.status}`);
    }

    return response.json();
}

function isValidData(result) {
    return result.data && Array.isArray(result.data);
}

function processSuccessfulLoad(result, retry) {
    setData(result.data);
    setOriginalData(null);
    resetSortState();
    render();

    const successMessage = retry > 0
        ? `Database loaded successfully after ${retry + 1} attempts`
        : 'Database loaded successfully from cloud storage';

    showStatus(successMessage);
}

function handleLoadError(error, retry, maxRetries) {
    console.error(`Load error (attempt ${retry + 1}/${maxRetries + 1}):`, error);
}

function handleFinalFailure() {
    showStatus('⚠️ Unable to connect to cloud storage. Please check your connection.', 'error', true);
    render();
}

async function waitForRetry(retry) {
    const waitTime = 1000 * Math.pow(2, retry);
    console.log(`Waiting ${waitTime}ms before retry...`);
    await delay(waitTime);
}
