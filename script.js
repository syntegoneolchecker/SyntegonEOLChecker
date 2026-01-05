// Functions in this file are called from HTML onclick handlers in index.html
// ESLint's no-unused-vars is disabled for this file (see eslint.config.js)

// ============================================================================
// GLOBAL VARIABLES
// ============================================================================

let data = [['SAP Part Number', 'Legacy Part Number', 'Designation', 'Model', 'Manufacturer', 'Status', 'Status Comment', 'Successor Model', 'Successor Comment', 'Successor SAP Number', 'Stock', 'Information Date', 'Auto Check']];

// Sorting state
let originalData = null; // Stores the original order for reset
const currentSort = {
    column: null, // Column index being sorted (0-5 for sortable columns)
    direction: null // 'asc', 'desc', or null
};

// Manual Check EOL state
let isManualCheckRunning = false; // Track if manual Check EOL is in progress

// Countdown interval for Groq rate limit reset
let groqCountdownInterval = null;
let groqResetTimestamp = null;

// Auto-check monitoring interval
let _autoCheckMonitoringInterval = null;

// ============================================================================
// AUTHENTICATION CHECK
// ============================================================================

// Check authentication before allowing access to the app

try {
    const response = await fetch('/.netlify/functions/auth-check');
    const authData = await response.json();

if (authData.authenticated) {
    // Store user info for later use
    globalThis.currentUser = authData.user;

    // Authentication successful - show the page content
    document.body.classList.remove('auth-loading');
    document.body.classList.add('auth-verified');

    // Initialize the app - load data, credits, etc.
    // Don't let init errors trigger auth redirect
    try {
        await init();
    } catch (initError) {
        console.error('Initialization error:', initError);
        // Show error but don't redirect - user is authenticated
        showStatus('⚠️ Error loading data. Please refresh the page.', 'error', true);
    }
} else {
    // Not authenticated, redirect to login
    globalThis.location.href = '/auth.html';
}
} catch (error) {
    console.error('Authentication check failed:', error);
    // Redirect to login on error
    globalThis.location.href = '/auth.html';
}

// Helper function to logout
async function logout() {
    try {
        await fetch('/.netlify/functions/auth-logout', { method: 'POST' });
        localStorage.removeItem('auth_token');
        globalThis.location.href = '/auth.html';
    } catch (error) {
        console.error('Logout failed:', error);
        globalThis.location.href = '/auth.html';
    }
}

// ============================================================================
// INITIALIZATION
// ============================================================================

// Initialize the app
async function init() {
    await loadFromServer();
    await loadTavilyCredits();
    await loadGroqUsage();
    await checkRenderHealth();
    await loadAutoCheckState();
    startAutoCheckMonitoring(); // Start periodic monitoring
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function showStatus(message, type = 'success', _permanent = true) {
    const status = document.getElementById('status');
    status.textContent = message;
    status.className = type;
    // NEVER clear status automatically - always show latest information
    // Status will be updated by next call to showStatus()
}

// Format SAP Number to X-XXX-XXX-XXX format (10 digits)
function formatID(input) {
    // Remove all non-digit characters
    const digits = input.replaceAll(/\D/g, '');

    // Check if we have exactly 10 digits
    if (digits.length !== 10) {
        return null; // Invalid SAP Number
    }

    // Format as X-XXX-XXX-XXX
    return `${digits.slice(0, 1)}-${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7, 10)}`;
}

// Find row by SAP Part Number
function findRowBySAPNumber(sapNumber) {
    for (let i = 1; i < data.length; i++) {
        if (data[i][0] === sapNumber) {
            return i;
        }
    }
    return -1;
}

// Update row in originalData by SAP Part Number
function updateRowInOriginalData(row) {
    if (!originalData) return;

    const sapNumber = row[0];
    const originalIndex = originalData.findIndex(r => r[0] === sapNumber);
    if (originalIndex !== -1) {
        originalData[originalIndex] = [...row];
    }
}

// Check if Render service is healthy based on status text
function isRenderServiceHealthy() {
    const renderStatusElement = document.getElementById('render-status');
    const renderStatusText = renderStatusElement.textContent;
    return !renderStatusText.includes('Timeout') &&
           !renderStatusText.includes('Offline') &&
           !renderStatusText.includes('Error');
}

// Parse credits remaining from text
function parseCreditsRemaining(creditsText) {
    const match = new RegExp(/(\d{1,6})\/\d{1,6} remaining/).exec(creditsText);
    return match ? Number.parseInt(match[1]) : null;
}

// ============================================================================
// TABLE RENDERING
// ============================================================================

// Render table header cell
function renderTableHeader(columnContent, columnIndex, sortableColumns) {
    const isSortable = sortableColumns.includes(columnIndex);
    let sortIndicator = '';
    if (currentSort.column === columnIndex) {
        if (currentSort.direction === 'asc') {
            sortIndicator = ' ▲';
        } else if (currentSort.direction === 'desc') {
            sortIndicator = ' ▼';
        }
    }
    const clickHandler = isSortable ? ` onclick="sortTable(${columnIndex})" style="cursor: pointer; user-select: none;"` : '';
    return `<th${clickHandler}>${columnContent}${sortIndicator}</th>`;
}

// Render table data cell
function renderTableCell(cellContent) {
    return `<td>${cellContent}</td>`;
}

// Render table action buttons
function renderActionButtons(rowIndex) {
    return `<td><button class="check-eol" onclick="checkEOL(${rowIndex})">Check EOL</button><button class="delete" onclick="delRow(${rowIndex})">Delete</button></td>`;
}

// Update Check EOL button states after rendering
async function updateButtonStates() {
    try {
        const response = await fetch('/.netlify/functions/get-auto-check-state');
        const state = response.ok ? await response.json() : null;

        // Disable buttons if EITHER manual check OR auto-check is running
        const shouldDisable = isManualCheckRunning || (state?.isRunning);
        if (typeof updateCheckEOLButtons === 'function') {
            updateCheckEOLButtons(shouldDisable);
        }
    } catch (error) {
        // If state fetch fails, still respect manual check flag
        console.warn('Failed to fetch auto-check state:', error);
        if (isManualCheckRunning) {
            updateCheckEOLButtons(true);
        }
    }
}

function render() {
    const sortableColumns = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]; // All data columns are sortable

    const t = document.getElementById('table');
    t.innerHTML = data.map((r, i) =>
        `<tr id="row-${i}">${r.map((c, j) => {
            if (i === 0) {
                return renderTableHeader(c, j, sortableColumns);
            } else {
                return renderTableCell(c);
            }
        }).join('')}${i > 0 ? renderActionButtons(i) : '<th>Actions</th>'}</tr>`
    ).join('');

    // Update Check EOL buttons state after rendering
    updateButtonStates();
}

// ============================================================================
// SORTING FUNCTIONALITY
// ============================================================================

// Compare values for sorting (handles date columns specially)
function compareValues(aVal, bVal, columnIndex, direction) {
    // Special handling for Information Date column (column 11)
    if (columnIndex === 11) {
        const aDate = aVal ? new Date(aVal) : new Date(0);
        const bDate = bVal ? new Date(bVal) : new Date(0);
        return direction === 'asc' ? aDate - bDate : bDate - aDate;
    }

    // Default lexicographical sorting
    const aLower = (aVal || '').toString().toLowerCase();
    const bLower = (bVal || '').toString().toLowerCase();
    return direction === 'asc' ? aLower.localeCompare(bLower) : bLower.localeCompare(aLower);
}

// Determine next sort state
function getNextSortState(columnIndex) {
    if (currentSort.column === columnIndex) {
        // Same column clicked - cycle through states: null → asc → desc → null
        if (currentSort.direction === null) {
            return 'asc';
        } else if (currentSort.direction === 'asc') {
            return 'desc';
        } else {
            return null; // Reset
        }
    } else {
        // Different column clicked - start fresh with ascending
        return 'asc';
    }
}

// Three-state sorting: null → asc → desc → null
function sortTable(columnIndex) {
    // Save original order on first sort (if not already saved)
    if (originalData === null) {
        originalData = structuredClone(data);
    }

    // Determine next sort state
    const nextDirection = getNextSortState(columnIndex);

    // Handle reset to original order
    if (nextDirection === null) {
        currentSort.direction = null;
        currentSort.column = null;
        data = structuredClone(originalData);
        render();
        return;
    }

    // Update sort state
    currentSort.column = columnIndex;
    currentSort.direction = nextDirection;

    // Perform the sort (exclude header row at index 0)
    const header = data[0];
    const rows = data.slice(1);

    rows.sort((a, b) => compareValues(a[columnIndex], b[columnIndex], columnIndex, currentSort.direction));

    // Rebuild data array with header + sorted rows
    data = [header, ...rows];
    render();
}

// ============================================================================
// ROW MANAGEMENT (ADD/DELETE)
// ============================================================================

// Validate and format SAP Part Number
function validateAndFormatSAPNumber(idInput) {
    if (!idInput) {
        showStatus('Error: SAP Part Number is required', 'error');
        return null;
    }

    const formattedID = formatID(idInput);
    if (!formattedID) {
        showStatus('Error: SAP Part Number must be exactly 10 digits (e.g., 8-114-463-187 or 8114463187)', 'error');
        return null;
    }

    return formattedID;
}

// Collect all input field values
function collectInputFields(startIndex, endIndex) {
    const fields = [];
    for (let i = startIndex; i <= endIndex; i++) {
        const value = document.getElementById('c' + i).value;
        fields.push(value);
    }
    return fields;
}

// Clear all input fields
function clearInputFields(startIndex, endIndex) {
    for (let i = startIndex; i <= endIndex; i++) {
        document.getElementById('c' + i).value = '';
    }
}

// Build confirmation message for replacing entry
function buildConfirmationMessage(formattedID, existingRow) {
    return `An entry with SAP Part Number ${formattedID} already exists:\n\n` +
        `SAP Part Number: ${existingRow[0]}\n` +
        `Legacy Part Number: ${existingRow[1]}\n` +
        `Designation: ${existingRow[2]}\n` +
        `Model: ${existingRow[3]}\n` +
        `Manufacturer: ${existingRow[4]}\n` +
        `Status: ${existingRow[5]}\n` +
        `Status Comment: ${existingRow[6]}\n` +
        `Successor Model: ${existingRow[7]}\n` +
        `Successor Comment: ${existingRow[8]}\n` +
        `Successor SAP Number: ${existingRow[9]}\n` +
        `Stock: ${existingRow[10]}\n` +
        `Information Date: ${existingRow[11]}\n` +
        `Auto Check: ${existingRow[12]}\n\n` +
        `Do you want to replace this entry with the new data?`;
}

// Add new entry
async function addNewEntry(formattedID, row) {
    data.push(row);
    if (originalData) originalData.push(row);
    render();
    showStatus(`✓ New entry ${formattedID} added successfully`);
    await saveToServer();
    clearInputFields(1, 13);
}

// Replace existing entry
async function replaceExistingEntry(existingIndex, formattedID, row) {
    data[existingIndex] = row;
    if (originalData) originalData[existingIndex] = row;
    render();
    showStatus(`✓ Entry ${formattedID} replaced successfully`);
    await saveToServer();
    clearInputFields(1, 13);
}

async function addRow() {
    const idInput = document.getElementById('c1').value.trim();
    const formattedID = validateAndFormatSAPNumber(idInput);
    if (!formattedID) return;

    // Build row with all fields
    const row = [formattedID, ...collectInputFields(2, 13)];

    // Find existing entry by ID
    const existingIndex = findRowBySAPNumber(formattedID);

    if (existingIndex === -1) {
        // New entry - add it
        await addNewEntry(formattedID, row);
    } else {
        // Entry exists - ask for confirmation
        const existingRow = data[existingIndex];
        const confirmMessage = buildConfirmationMessage(formattedID, existingRow);

        if (confirm(confirmMessage)) {
            await replaceExistingEntry(existingIndex, formattedID, row);
        } else {
            showStatus(`Entry replacement cancelled`, 'info');
        }
    }
}

async function delRow(i) {
    // If we have originalData, find and remove the matching row from it
    if (originalData) {
        const rowToDelete = data[i];
        const sapNumber = rowToDelete[0]; // SAP Part Number is unique identifier

        // Find and remove from originalData
        const originalIndex = originalData.findIndex(row => row[0] === sapNumber);
        if (originalIndex !== -1) {
            originalData.splice(originalIndex, 1);
        }
    }

    data.splice(i, 1);
    render();
    await saveToServer();
}

// ============================================================================
// EOL CHECKING FUNCTIONALITY
// ============================================================================

// Validate EOL inputs
function validateEOLInputs(model, manufacturer) {
    if (!model || !manufacturer) {
        showStatus('Error: Model and Manufacturer are required for EOL check', 'error');
        return false;
    }
    return true;
}

// Wake up Render service and validate it's healthy
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

// Initialize EOL job
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

// Update row with EOL results
async function updateRowWithEOLResults(rowIndex, result) {
    const row = data[rowIndex];

    // Update columns with results
    row[5] = result.status || 'UNKNOWN';
    row[6] = result.explanation || '';
    row[7] = result.successor?.model || '';
    row[8] = result.successor?.explanation || '';
    row[11] = new Date().toLocaleString();

    // Update originalData if it exists
    updateRowInOriginalData(row);

    // Re-render and save
    render();
    await saveToServer();

    // Refresh credits and rate limits
    await loadTavilyCredits();
    if (result.rateLimits) {
        updateGroqRateLimits(result.rateLimits);
    }
}

async function checkEOL(rowIndex) {
    const row = data[rowIndex];
    const model = row[3];
    const manufacturer = row[4];

    if (!validateEOLInputs(model, manufacturer)) return;

    // Disable all Check EOL buttons
    disableAllCheckEOLButtons();

    try {
        const rowElement = document.getElementById(`row-${rowIndex}`);
        const checkButton = rowElement.querySelector('.check-eol');

        // Wake up Render service
        if (!await wakeRenderService(checkButton)) {
            enableAllCheckEOLButtons();
            return;
        }

        // Initialize job
        checkButton.textContent = 'Initializing...';
        showStatus(`Initializing EOL check for ${manufacturer} ${model}...`, 'info', false);

        const jobId = await initializeEOLJob(model, manufacturer);

        // Update button and poll for results
        checkButton.textContent = 'Processing...';
        const result = await pollJobStatus(jobId, manufacturer, model, checkButton);

        // Update row with results
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

// Update job progress display
function updateJobProgress(statusData, manufacturer, model, checkButton) {
    const progress = `${statusData.completedUrls || 0}/${statusData.urlCount || 0}`;
    if (checkButton) {
        checkButton.textContent = `Processing (${progress})`;
    }
    showStatus(`Checking ${manufacturer} ${model}... (${progress} pages)`, 'info', false);
}

// Check if we should trigger fetch-url
function shouldTriggerFetch(statusData, fetchTriggered) {
    return statusData.status === 'urls_ready' &&
           !fetchTriggered &&
           statusData.urls &&
           statusData.urls.length > 0 &&
           statusData.urls[0].status === 'pending'; // Only trigger if URL is still pending
}

// Build fetch-url payload
function buildFetchPayload(jobId, firstUrl) {
    const payload = {
        jobId,
        urlIndex: firstUrl.index,
        url: firstUrl.url,
        title: firstUrl.title,
        snippet: firstUrl.snippet,
        scrapingMethod: firstUrl.scrapingMethod
    };

    // Add optional fields
    if (firstUrl.model) payload.model = firstUrl.model;
    if (firstUrl.jpUrl) payload.jpUrl = firstUrl.jpUrl;
    if (firstUrl.usUrl) payload.usUrl = firstUrl.usUrl;

    return payload;
}

// Trigger fetch-url (fire-and-forget with retry)
async function triggerFetchUrl(jobId, firstUrl, attempts) {
    console.log(`✓ URLs ready, triggering fetch-url (attempt ${attempts})`);

    const payload = buildFetchPayload(jobId, firstUrl);
    const maxRetries = 2;

    // Fire-and-forget with retry logic
    for (let retry = 0; retry <= maxRetries; retry++) {
        try {
            const response = await fetch('/.netlify/functions/fetch-url', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(120000) // 120s timeout (scraping can take time)
            });

            if (response.ok) {
                console.log(`✓ fetch-url triggered successfully for ${firstUrl.url}`);
                return;
            }

            console.warn(`⚠️  fetch-url returned ${response.status} (retry ${retry}/${maxRetries})`);

        } catch (err) {
            // If timeout occurred, the function is likely still running server-side
            // Do NOT retry to avoid duplicate executions
            if (err.name === 'TimeoutError' || err.name === 'AbortError') {
                console.log(`⏱️  fetch-url request timed out after 60s - function likely still running server-side, NOT retrying to avoid duplicates`);
                return; // Exit without retrying
            }

            console.error(`Failed to trigger fetch-url (retry ${retry}/${maxRetries}): ${err.message}`);
        }

        if (retry < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, 1000 * (retry + 1)));
        }
    }

    console.error(`❌ fetch-url failed after ${maxRetries + 1} attempts for ${firstUrl.url}`);
}

// Check if all URLs are complete
function areAllUrlsComplete(statusData) {
    return statusData.urls &&
           statusData.urls.length > 0 &&
           statusData.urls.every(u => u.status === 'complete');
}

// Check if we should trigger analyze-job
function shouldTriggerAnalyze(statusData, analyzeTriggered) {
    return areAllUrlsComplete(statusData) &&
           !analyzeTriggered &&
           statusData.status !== 'analyzing' &&
           statusData.status !== 'complete';
}

// Trigger analyze-job (fire-and-forget with retry)
async function triggerAnalyzeJob(jobId, attempts) {
    console.log(`✓ All URLs scraped, triggering analyze-job (attempt ${attempts})`);

    const maxRetries = 2;

    // Fire-and-forget with retry logic
    for (let retry = 0; retry <= maxRetries; retry++) {
        try {
            const response = await fetch('/.netlify/functions/analyze-job', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jobId }),
                signal: AbortSignal.timeout(120000) // 120s timeout (analysis can take time)
            });

            if (response.ok) {
                console.log(`✓ analyze-job triggered successfully`);
                return;
            }

            console.warn(`⚠️  analyze-job returned ${response.status} (retry ${retry}/${maxRetries})`);

        } catch (err) {
            // If timeout occurred, the function is likely still running server-side
            // Do NOT retry to avoid duplicate executions
            if (err.name === 'TimeoutError' || err.name === 'AbortError') {
                console.log(`⏱️  analyze-job request timed out after 60s - function likely still running server-side, NOT retrying to avoid duplicates`);
                return; // Exit without retrying
            }

            console.error(`Failed to trigger analyze-job (retry ${retry}/${maxRetries}): ${err.message}`);
        }

        if (retry < maxRetries) {
            await new Promise(resolve => setTimeout(resolve, 1000 * (retry + 1)));
        }
    }

    console.error(`❌ analyze-job failed after ${maxRetries + 1} attempts`);
}

// Handle daily limit error
function handleDailyLimitError(statusData) {
    if (statusData.isDailyLimit && statusData.retrySeconds) {
        console.log(`Daily limit hit, starting countdown for ${statusData.retrySeconds}s`);
        startGroqCountdown(statusData.retrySeconds);
    }
}

// Get job status with error handling
async function getJobStatus(jobId) {
    const statusResponse = await fetch(`/.netlify/functions/job-status/${jobId}`);

    if (!statusResponse.ok) {
        throw new Error(`Status check failed: ${statusResponse.status}`);
    }

    return await statusResponse.json();
}

// Create timeout result
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

// Poll job status until complete
async function pollJobStatus(jobId, manufacturer, model, checkButton) {
    const maxAttempts = 60; // 60 attempts * 2s = 2 min max
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

            // Log trigger flags
            console.log(`Trigger flags: fetchTriggered=${fetchTriggered}, analyzeTriggered=${analyzeTriggered}`);

            // Update progress display
            updateJobProgress(statusData, manufacturer, model, checkButton);

            // Check if job is complete
            if (statusData.status === 'complete') {
                console.log('Job complete, returning result');
                return statusData.result;
            }

            // Check for errors
            if (statusData.status === 'error') {
                console.log('Job error detected');
                handleDailyLimitError(statusData);
                throw new Error(statusData.error || 'Job failed');
            }

            // Trigger fetch-url if URLs are ready
            const shouldFetch = shouldTriggerFetch(statusData, fetchTriggered);
            console.log(`shouldTriggerFetch=${shouldFetch} (status=${statusData.status}, fetchTriggered=${fetchTriggered}, hasUrls=${statusData.urls && statusData.urls.length > 0})`);

            if (shouldFetch) {
                console.log(`Triggering fetch-url for URL index 0:`, statusData.urls[0].url);
                await triggerFetchUrl(jobId, statusData.urls[0], attempts);
                fetchTriggered = true;
                console.log(`fetch-url triggered, setting fetchTriggered=true`);
            }

            // Trigger analyze-job if all scraping is complete
            const shouldAnalyze = shouldTriggerAnalyze(statusData, analyzeTriggered);
            console.log(`shouldTriggerAnalyze=${shouldAnalyze} (allUrlsComplete=${areAllUrlsComplete(statusData)}, analyzeTriggered=${analyzeTriggered}, status=${statusData.status})`);

            if (shouldAnalyze) {
                console.log(`Triggering analyze-job`);
                await triggerAnalyzeJob(jobId, attempts);
                analyzeTriggered = true;
                console.log(`analyze-job triggered, setting analyzeTriggered=true`);
            }

            // Wait before next poll
            await new Promise(resolve => setTimeout(resolve, 2000));

        } catch (error) {
            console.error('Polling error:', error);
            throw error;
        }
    }

    // Timeout reached
    return createTimeoutResult(maxAttempts);
}

// ============================================================================
// EXCEL IMPORT/EXPORT
// ============================================================================

async function downloadExcel() {
    try {
        const response = await fetch('/.netlify/functions/get-csv');

        if (!response.ok) {
            throw new Error(`Server error: ${response.status}`);
        }

        const result = await response.json();

        if (result.data) {
            // Create a new workbook
            const wb = XLSX.utils.book_new();

            // Convert data array to worksheet
            const ws = XLSX.utils.aoa_to_sheet(result.data);

            // Add worksheet to workbook
            XLSX.utils.book_append_sheet(wb, ws, 'EOL Database');

            // Generate Excel file and trigger download
            XLSX.writeFile(wb, 'eol-database.xlsx');

            showStatus('Database downloaded successfully!');
        } else {
            showStatus('No data available to download', 'error');
        }
    } catch (error) {
        console.error('Download failed:', error);
        showStatus('Error downloading database: ' + error.message, 'error');
    }
}

// Validate Excel headers
function validateExcelHeaders(headers) {
    const idIndex = headers.findIndex(h => {
        const headerText = h?.toString().toLowerCase().trim();
        return headerText === 'sap part number';
    });

    if (idIndex === -1) {
        console.error('SAP Part Number column not found. Headers:', headers);
        showStatus('Error: Excel file must contain "SAP Part Number" column. Found headers: ' + headers.join(', '), 'error');
        return null;
    }

    console.log('SAP Part Number column found at index:', idIndex);
    return idIndex;
}

// Build row from Excel data
function buildRowFromExcel(importedRow, headers, idIndex) {
    const idInput = (importedRow[idIndex] || '').toString().trim();

    // Skip rows without SAP Number
    if (!idInput) {
        return { skip: true, reason: 'no SAP Number' };
    }

    // Format and validate SAP Number
    const formattedID = formatID(idInput);
    if (!formattedID) {
        return { skip: true, reason: `invalid format: "${idInput}"` };
    }

    // Build complete row with all columns
    const newRow = [];
    const ourHeaders = data[0];

    for (const element of ourHeaders) {
        const headerName = element.toLowerCase().trim();

        if (headerName === 'sap part number') {
            newRow.push(formattedID);
        } else {
            const importColIndex = headers.findIndex(h => h && h.toString().toLowerCase().trim() === headerName);

            if (importColIndex !== -1 && importedRow[importColIndex] !== undefined) {
                newRow.push(importedRow[importColIndex].toString());
            } else {
                newRow.push('');
            }
        }
    }

    return { skip: false, formattedID, newRow };
}

// Process single Excel row
function processExcelRow(importedRow, headers, idIndex, stats) {
    const result = buildRowFromExcel(importedRow, headers, idIndex);

    if (result.skip) {
        stats.skippedEntries++;
        return;
    }

    const { formattedID, newRow } = result;

    // Find existing entry with same ID
    const existingIndex = findRowBySAPNumber(formattedID);

    if (existingIndex === -1) {
        // Add new entry
        data.push(newRow);
        if (originalData) originalData.push(newRow);
        stats.newEntries++;
    } else {
        // Update existing entry
        data[existingIndex] = newRow;
        if (originalData) originalData[existingIndex] = newRow;
        stats.updatedEntries++;
    }
}

// Show import summary
function showImportSummary(stats) {
    let statusMsg = `✓ Imported: ${stats.newEntries} new entries, ${stats.updatedEntries} updated entries`;
    if (stats.skippedEntries > 0) {
        statusMsg += `, ${stats.skippedEntries} skipped (invalid/missing SAP Number)`;
    }
    console.log('Import completed:', stats);
    showStatus(statusMsg);
}

// Parse Excel file
async function parseExcelFile(fileData) {
    // Parse Excel file using ArrayBuffer instead of binary string
    const workbook = XLSX.read(fileData, { type: 'array' }); // Change 'binary' to 'array'

    // Get first worksheet
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];

    // Convert to array of arrays
    const importedData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

    if (importedData.length === 0) {
        throw new Error('Excel file is empty');
    }

    return importedData;
}

// Process all Excel rows
function processAllExcelRows(importedData, idIndex) {
    const stats = { newEntries: 0, updatedEntries: 0, skippedEntries: 0 };
    const headers = importedData[0];

    // Process each row (skip header)
    for (let i = 1; i < importedData.length; i++) {
        const importedRow = importedData[i];

        // Skip empty rows
        if (!importedRow || importedRow.length === 0) continue;

        processExcelRow(importedRow, headers, idIndex, stats);
    }

    return stats;
}

async function loadExcel(e) {
    const f = e.target.files[0];
    if (!f) return;

    try {
        // Get ArrayBuffer directly from the file (modern API)
        const arrayBuffer = await f.arrayBuffer();
        const importedData = await parseExcelFile(arrayBuffer);

        const headers = importedData[0];
        console.log('Excel headers found:', headers);

        // Validate headers
        const idIndex = validateExcelHeaders(headers);
        if (idIndex === null) return;

        // Process all rows
        const stats = processAllExcelRows(importedData, idIndex);

        // Reset sorting state after import
        originalData = null;
        currentSort.column = null;
        currentSort.direction = null;

        render();
        await saveToServer();

        // Show import summary
        showImportSummary(stats);

    } catch (error) {
        console.error('Excel import failed:', error);
        showStatus('Error importing Excel file: ' + error.message, 'error');
    }
}

// ============================================================================
// SERVER INTEGRATION (NETLIFY BLOBS)
// ============================================================================

async function saveToServer() {
    try {
        const response = await fetch('/.netlify/functions/save-csv', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ data: data })
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

async function manualSaveDatabase() {
    showStatus('Saving database...');
    await saveToServer();
}

async function loadFromServer() {
    try {
        const response = await fetch('/.netlify/functions/get-csv');

        if (!response.ok) {
            throw new Error(`Server returned ${response.status}`);
        }

        const result = await response.json();

        if (result.data && Array.isArray(result.data)) {
            data = result.data;
            // Reset sorting state when loading new data
            originalData = null;
            currentSort.column = null;
            currentSort.direction = null;
            render();
            showStatus('✓ Database loaded successfully from cloud storage');
            return;
        }
    } catch (error) {
        console.error('Load error:', error);
        showStatus('⚠️ Unable to connect to cloud storage. Please check your connection.', 'error', true);
        // Keep default headers for display
        render();
    }
}

// ============================================================================
// CREDITS AND USAGE MONITORING
// ============================================================================

async function loadTavilyCredits() {
    try {
        const response = await fetch('/.netlify/functions/get-tavily-usage');

        if (!response.ok) {
            throw new Error(`Failed to fetch Tavily credits: ${response.status}`);
        }

        const result = await response.json();

        // Update the display
        const creditsElement = document.getElementById('credits-remaining');
        const remaining = result.remaining;
        const limit = result.limit;

        creditsElement.textContent = `${remaining}/${limit} remaining`;

        // Apply color coding based on remaining credits
        creditsElement.classList.remove('credits-high', 'credits-medium', 'credits-low');

        if (remaining > 500) {
            creditsElement.classList.add('credits-high');
        } else if (remaining > 100) {
            creditsElement.classList.add('credits-medium');
        } else {
            creditsElement.classList.add('credits-low');
        }

    } catch (error) {
        console.error('Failed to load Tavily credits:', error);
        const creditsElement = document.getElementById('credits-remaining');
        creditsElement.textContent = 'Error loading credits';
        creditsElement.classList.remove('credits-high', 'credits-medium', 'credits-low');
    }
}

async function loadGroqUsage() {
    try {
        const response = await fetch('/.netlify/functions/get-groq-usage');

        if (!response.ok) {
            throw new Error(`Failed to fetch Groq usage: ${response.status}`);
        }

        const result = await response.json();

        // Update the display using the same function we use after EOL checks
        updateGroqRateLimits(result);

    } catch (error) {
        console.error('Failed to load Groq usage:', error);
        const groqElement = document.getElementById('groq-remaining');
        groqElement.textContent = 'Error loading';
        groqElement.classList.remove('credits-high', 'credits-medium', 'credits-low');
    }
}

function updateGroqRateLimits(rateLimits) {
    // Update per-minute limits
    const groqElement = document.getElementById('groq-remaining');

    if (!rateLimits?.remainingTokens || !rateLimits.limitTokens) {
        groqElement.textContent = 'N/A';
    } else {
        const remaining = Number.parseInt(rateLimits.remainingTokens);
        const limit = Number.parseInt(rateLimits.limitTokens);

        // Format with comma separators for readability
        const remainingFormatted = remaining.toLocaleString();
        const limitFormatted = limit.toLocaleString();

        groqElement.textContent = `${remainingFormatted}/${limitFormatted} TPM`;

        // Apply color coding based on percentage remaining
        groqElement.classList.remove('credits-high', 'credits-medium', 'credits-low');

        const percentRemaining = (remaining / limit) * 100;

        if (percentRemaining > 50) {
            groqElement.classList.add('credits-high');
        } else if (percentRemaining > 20) {
            groqElement.classList.add('credits-medium');
        } else {
            groqElement.classList.add('credits-low');
        }
    }

    // Update countdown timer
    if (rateLimits?.resetSeconds !== null && rateLimits.resetSeconds !== undefined) {
        startGroqCountdown(rateLimits.resetSeconds);
    } else {
        const countdownElement = document.getElementById('groq-reset-countdown');
        countdownElement.textContent = 'N/A';
    }
}

function startGroqCountdown(resetSeconds) {
    // Clear any existing countdown
    if (groqCountdownInterval) {
        clearInterval(groqCountdownInterval);
    }

    // Calculate reset timestamp
    groqResetTimestamp = Date.now() + (resetSeconds * 1000);

    // Update countdown display immediately
    updateCountdownDisplay();

    // Start countdown interval (update every second)
    groqCountdownInterval = setInterval(() => {
        updateCountdownDisplay();
    }, 1000);
}

function updateCountdownDisplay() {
    const countdownElement = document.getElementById('groq-reset-countdown');

    if (!groqResetTimestamp) {
        countdownElement.textContent = 'N/A';
        return;
    }

    const now = Date.now();
    const timeLeft = Math.max(0, groqResetTimestamp - now);

    if (timeLeft <= 0) {
        // Countdown reached 0 - refresh rate limits
        countdownElement.textContent = 'Refreshing...';
        if (groqCountdownInterval) {
            clearInterval(groqCountdownInterval);
            groqCountdownInterval = null;
        }
        // Automatically refresh the rate limits
        loadGroqUsage();
        return;
    }

    // Format time as seconds with 1 decimal place
    const secondsLeft = (timeLeft / 1000).toFixed(1);
    countdownElement.textContent = `${secondsLeft}s`;
}

// ============================================================================
// RENDER SERVICE HEALTH CHECK
// ============================================================================

// Helper: Attempt a single health check
async function attemptHealthCheck(renderServiceUrl, timeoutMs) {
    const startTime = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(`${renderServiceUrl}/health`, {
            signal: controller.signal
        });

        clearTimeout(timeout);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        if (response.ok) {
            const data = await response.json();
            return { success: true, elapsed, data };
        } else {
            return { success: false, error: `HTTP ${response.status}`, elapsed };
        }
    } catch (error) {
        clearTimeout(timeout);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        return {
            success: false,
            error: error.name === 'AbortError' ? 'Timeout' : error.message,
            elapsed
        };
    }
}

// Helper: Update render status UI
function updateRenderStatus(element, elapsed, data) {
    if (elapsed > 10) {
        // Cold start detected (took >10s)
        element.textContent = `Ready (cold start: ${elapsed}s)`;
        element.classList.add('credits-medium');
    } else {
        // Already warm
        element.textContent = `Ready (${elapsed}s)`;
        element.classList.add('credits-high');
    }
    console.log(`Render health check: OK in ${elapsed}s`, data);
}

// Check Render scraping service health with retry logic
async function checkRenderHealth() {
    const renderStatusElement = document.getElementById('render-status');
    const renderServiceUrl = 'https://eolscrapingservice.onrender.com';

    try {
        renderStatusElement.textContent = 'Checking...';
        renderStatusElement.classList.remove('credits-high', 'credits-medium', 'credits-low');

        const overallStartTime = Date.now();

        // First attempt (60s timeout)
        console.log('Render health check: Attempt 1/2...');
        const firstAttempt = await attemptHealthCheck(renderServiceUrl, 60000);

        if (firstAttempt.success) {
            // Success on first attempt
            updateRenderStatus(renderStatusElement, firstAttempt.elapsed, firstAttempt.data);
            return;
        }

        // First attempt failed
        console.warn(`Render health check: Attempt 1 failed after ${firstAttempt.elapsed}s (${firstAttempt.error})`);

        // Show retry status
        renderStatusElement.textContent = 'Waking service, retrying...';
        renderStatusElement.classList.add('credits-medium');

        // Wait 30 seconds for Render to finish waking
        console.log('Render health check: Waiting 30s before retry...');
        await new Promise(resolve => setTimeout(resolve, 30000));

        // Second attempt (60s timeout)
        console.log('Render health check: Attempt 2/2...');
        renderStatusElement.textContent = 'Retrying...';
        const secondAttempt = await attemptHealthCheck(renderServiceUrl, 60000);

        const totalElapsed = ((Date.now() - overallStartTime) / 1000).toFixed(1);

        if (secondAttempt.success) {
            // Success on second attempt
            console.log(`Render health check: OK after retry (total: ${totalElapsed}s)`);
            renderStatusElement.textContent = `Ready after retry (${totalElapsed}s total)`;
            renderStatusElement.classList.remove('credits-medium');
            renderStatusElement.classList.add('credits-medium');
            return;
        }

        // Both attempts failed
        console.error(`Render health check: Failed after 2 attempts (total: ${totalElapsed}s)`);
        renderStatusElement.textContent = `Offline after ${totalElapsed}s (${secondAttempt.error})`;
        renderStatusElement.classList.remove('credits-medium');
        renderStatusElement.classList.add('credits-low');

    } catch (error) {
        console.error('Render health check error:', error);
        renderStatusElement.textContent = `Error: ${error.message}`;
        renderStatusElement.classList.add('credits-low');
    }
}

// ============================================================================
// DELETE FUNCTIONALITY
// ============================================================================

// Toggle delete buttons visibility
function toggleDeleteButtons() {
    const toggle = document.getElementById('delete-toggle');
    const clearDbButton = document.getElementById('clear-database-btn');

    if (toggle.checked) {
        document.body.classList.add('show-delete-buttons');
        clearDbButton.style.display = 'block';
    } else {
        document.body.classList.remove('show-delete-buttons');
        clearDbButton.style.display = 'none';
    }
}

// Clear entire database with confirmation
async function clearDatabase() {
    // Show confirmation dialog
    const confirmed = confirm(
        '⚠️ WARNING: Clear Entire Database?\n\n' +
        'This will permanently delete ALL entries from the database.\n' +
        'This action CANNOT be undone.\n\n' +
        'Are you sure you want to continue?'
    );

    if (!confirmed) {
        showStatus('Database clear cancelled', 'info');
        return;
    }

    try {
        showStatus('Clearing database...', 'info');

        const response = await fetch('/.netlify/functions/reset-database', {
            method: 'POST'
        });

        if (!response.ok) {
            throw new Error(`Failed to clear database: ${response.status}`);
        }

        const result = await response.json();
        console.log('Database cleared:', result);

        // Reset data to empty state with headers only
        data = [['SAP Part Number', 'Legacy Part Number', 'Designation', 'Model', 'Manufacturer', 'Status', 'Status Comment', 'Successor Model', 'Successor Comment', 'Successor SAP Number', 'Stock', 'Information Date', 'Auto Check']];

        // Reset sorting state
        originalData = null;
        currentSort.column = null;
        currentSort.direction = null;

        render();
        showStatus('✓ Database cleared successfully', 'success');

    } catch (error) {
        console.error('Clear database error:', error);
        showStatus('Error clearing database: ' + error.message, 'error');
    }
}

// ============================================================================
// AUTO-CHECK FUNCTIONALITY
// ============================================================================

// Load auto-check state and update UI
async function loadAutoCheckState() {
    try {
        const response = await fetch('/.netlify/functions/get-auto-check-state');

        if (!response.ok) {
            console.error('Failed to load auto-check state');
            return;
        }

        const state = await response.json();
        console.log('Auto-check state loaded:', state);

        // Update toggle
        const toggle = document.getElementById('auto-check-toggle');
        if (toggle) {
            toggle.checked = state.enabled;
        }

        // Update Check EOL buttons state
        // BUT: Don't override manual check state
        if (!isManualCheckRunning) {
            updateCheckEOLButtons(state.isRunning);
        }

    } catch (error) {
        console.error('Error loading auto-check state:', error);
    }
}

// Toggle auto-check enabled/disabled
async function toggleAutoCheck() {
    const toggle = document.getElementById('auto-check-toggle');
    const enabled = toggle.checked;

    try {
        const response = await fetch('/.netlify/functions/set-auto-check-state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: enabled })
        });

        if (!response.ok) {
            throw new Error('Failed to update state');
        }

        const result = await response.json();
        console.log('Auto-check toggled:', result.state);

        showStatus(`Auto EOL Check ${enabled ? 'enabled' : 'disabled'}`, 'success');

    } catch (error) {
        console.error('Error toggling auto-check:', error);
        showStatus('Error updating auto-check state: ' + error.message, 'error');
        // Revert toggle on error
        toggle.checked = !enabled;
    }
}

// Set auto-check state
async function setAutoCheckState(stateUpdate) {
    const response = await fetch('/.netlify/functions/set-auto-check-state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(stateUpdate)
    });

    if (!response.ok) {
        throw new Error(`Failed to set state: ${response.statusText}`);
    }

    return await response.json();
}

// Manual trigger for testing
async function manualTriggerAutoCheck() {
    const button = document.getElementById('manual-trigger-btn');
    const originalText = button.textContent;

    try {
        button.textContent = 'Triggering...';
        button.disabled = true;

        showStatus('Resetting daily counter and triggering auto-check...', 'info');

        // Reset the daily counter to 0
        await setAutoCheckState({ dailyCounter: 0 });
        console.log('Daily counter reset to 0');

        showStatus('Counter reset. Triggering auto-check...', 'info');

        // Set isRunning = true before triggering
        await setAutoCheckState({ isRunning: true });

        // Trigger the background function
        const siteUrl = globalThis.location.origin;
        const response = await fetch('/.netlify/functions/auto-eol-check-background', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                triggeredBy: 'manual',
                siteUrl: siteUrl
            })
        });

        if (response.status === 202) {
            showStatus('Auto-check triggered successfully! Counter reset to 0. Check console for progress.', 'success');
        } else {
            const data = await response.json();
            showStatus('Trigger response: ' + (data.message || data.body || 'Unknown'), 'info');
        }

    } catch (error) {
        console.error('Error triggering auto-check:', error);
        showStatus('Error triggering auto-check: ' + error.message, 'error');
    } finally {
        button.textContent = originalText;
        button.disabled = false;
    }
}

// Update Check EOL buttons (hide/show based on auto-check running state)
function updateCheckEOLButtons(isRunning) {
    const checkButtons = document.querySelectorAll('.check-eol');
    checkButtons.forEach(button => {
        button.style.display = isRunning ? 'none' : '';
    });
}

// Disable all Check EOL buttons (for manual check - prevent parallel execution)
function disableAllCheckEOLButtons() {
    isManualCheckRunning = true;
    const checkButtons = document.querySelectorAll('.check-eol');
    checkButtons.forEach(button => {
        button.style.display = 'none';
    });
    console.log('All Check EOL buttons disabled (manual check in progress)');
}

// Enable all Check EOL buttons (after manual check completes)
function enableAllCheckEOLButtons() {
    isManualCheckRunning = false;
    const checkButtons = document.querySelectorAll('.check-eol');
    checkButtons.forEach(button => {
        button.style.display = '';
        button.textContent = 'Check EOL';
    });
    console.log('All Check EOL buttons re-enabled (manual check complete)');
}

// ============================================================================
// AUTO-CHECK MONITORING
// ============================================================================

// Sync auto-check toggle with server state
function syncAutoCheckToggle(serverEnabled) {
    const toggle = document.getElementById('auto-check-toggle');
    if (toggle && toggle.checked !== serverEnabled) {
        console.log(`Syncing toggle with server state: ${serverEnabled}`);
        toggle.checked = serverEnabled;
    }
}

// Calculate minutes since last activity
function calculateMinutesSinceActivity(lastActivityTime) {
    if (!lastActivityTime) return 999;

    const lastActivity = new Date(lastActivityTime);
    const now = new Date();
    return (now - lastActivity) / 1000 / 60;
}

// Detect and recover from stuck isRunning state
async function detectAndRecoverStuckState(state) {
    if (!state.isRunning) return state;

    const minutesSinceActivity = calculateMinutesSinceActivity(state.lastActivityTime);

    if (minutesSinceActivity > 5) {
        console.warn(`Detected stuck isRunning state (no activity for ${minutesSinceActivity.toFixed(1)} min), resetting...`);

        // Reset isRunning to false
        await setAutoCheckState({ isRunning: false });

        // Update local state
        state.isRunning = false;
        showStatus('Auto-check recovered from stuck state', 'info');
    }

    return state;
}

// Auto-disable auto-check if credits are too low
async function autoDisableOnLowCredits(state) {
    if (!state.enabled) return;

    const creditsElement = document.getElementById('credits-remaining');
    if (!creditsElement) return;

    const remaining = parseCreditsRemaining(creditsElement.textContent);
    if (remaining === null || remaining > 50) return;

    console.log('Auto-disabling auto-check due to low credits:', remaining);

    // Disable auto-check
    await setAutoCheckState({ enabled: false });

    // Update toggle
    const toggle = document.getElementById('auto-check-toggle');
    if (toggle) toggle.checked = false;

    showStatus('Auto EOL Check disabled - Tavily credits too low (≤50)', 'info');
}

// Monitor auto-check state periodically
function startAutoCheckMonitoring() {
    // Check every 10 seconds
    _autoCheckMonitoringInterval = setInterval(async () => {
        try {
            const response = await fetch('/.netlify/functions/get-auto-check-state');
            if (!response.ok) return;

            let state = await response.json();

            // Sync toggle with server state
            syncAutoCheckToggle(state.enabled);

            // Detect and recover from stuck state
            state = await detectAndRecoverStuckState(state);

            // Update buttons based on isRunning (don't override manual check state)
            if (!isManualCheckRunning) {
                updateCheckEOLButtons(state.isRunning);
            }

            // Auto-disable if credits too low
            await autoDisableOnLowCredits(state);

        } catch (error) {
            console.error('Auto-check monitoring error:', error);
        }
    }, 10000); // Every 10 seconds
}

// ============================================================================
// INITIALIZE APP
// ============================================================================

// Initialize when page loads
document.addEventListener('DOMContentLoaded', init);
