let data = [['SAP Part Number', 'Legacy Part Number', 'Designation', 'Model', 'Manufacturer', 'Status', 'Status Comment', 'Successor Model', 'Successor Comment', 'Successor SAP Number', 'Stock', 'Information Date', 'Auto Check']];

// Sorting state
let originalData = null; // Stores the original order for reset
let currentSort = {
    column: null, // Column index being sorted (0-5 for sortable columns)
    direction: null // 'asc', 'desc', or null
};

// Manual Check EOL state
let isManualCheckRunning = false; // Track if manual Check EOL is in progress

// Countdown interval for Groq rate limit reset
let groqCountdownInterval = null;
let groqResetTimestamp = null;

// Initialize the app
async function init() {
    await loadFromServer();
    await loadTavilyCredits();
    await loadGroqUsage();
    await checkRenderHealth();
    await loadAutoCheckState();
    startAutoCheckMonitoring(); // Start periodic monitoring
}

function showStatus(message, type = 'success', permanent = true) {
    const status = document.getElementById('status');
    status.textContent = message;
    status.className = type;
    // NEVER clear status automatically - always show latest information
    // Status will be updated by next call to showStatus()
}

// Format SAP Number to X-XXX-XXX-XXX format (10 digits)
function formatID(input) {
    // Remove all non-digit characters
    const digits = input.replace(/\D/g, '');

    // Check if we have exactly 10 digits
    if (digits.length !== 10) {
        return null; // Invalid SAP Number
    }

    // Format as X-XXX-XXX-XXX
    return `${digits.slice(0, 1)}-${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7, 10)}`;
}

function render() {
    const sortableColumns = [0, 1, 2, 3, 4, 5]; // SAP Part Number, Legacy Part Number, Designation, Model, Manufacturer, Status

    let t = document.getElementById('table');
    t.innerHTML = data.map((r, i) =>
        `<tr id="row-${i}">${r.map((c, j) => {
            if (i == 0) {
                // Header row
                const isSortable = sortableColumns.includes(j);
                const sortIndicator = (currentSort.column === j)
                    ? (currentSort.direction === 'asc' ? ' ▲' : currentSort.direction === 'desc' ? ' ▼' : '')
                    : '';
                const clickHandler = isSortable ? ` onclick="sortTable(${j})" style="cursor: pointer; user-select: none;"` : '';
                return `<th${clickHandler}>${c}${sortIndicator}</th>`;
            } else {
                return `<td>${c}</td>`;
            }
        }).join('')}${i > 0 ? `<td><button class="check-eol" onclick="checkEOL(${i})">Check EOL</button><button class="delete" onclick="delRow(${i})">Delete</button></td>` : '<th>Actions</th>'}</tr>`
    ).join('');

    // Update Check EOL buttons state after rendering
    // Check if auto-check OR manual check is running
    if (isManualCheckRunning) {
        // Manual check in progress - hide all buttons immediately
        updateCheckEOLButtons(true);
    } else {
        // Check if auto-check state needs to disable buttons
        fetch('/.netlify/functions/get-auto-check-state')
            .then(r => r.ok ? r.json() : null)
            .then(state => {
                if (state && typeof updateCheckEOLButtons === 'function') {
                    updateCheckEOLButtons(state.isRunning);
                }
            })
            .catch(() => {}); // Silently fail if state service not available
    }
}

// Three-state sorting: null → asc → desc → null
function sortTable(columnIndex) {
    // Save original order on first sort (if not already saved)
    if (originalData === null) {
        originalData = JSON.parse(JSON.stringify(data));
    }

    // Determine next sort state
    if (currentSort.column === columnIndex) {
        // Same column clicked - cycle through states
        if (currentSort.direction === null) {
            currentSort.direction = 'asc';
        } else if (currentSort.direction === 'asc') {
            currentSort.direction = 'desc';
        } else {
            // Reset to original order
            currentSort.direction = null;
            currentSort.column = null;
            data = JSON.parse(JSON.stringify(originalData));
            render();
            return;
        }
    } else {
        // Different column clicked - start fresh with ascending
        currentSort.column = columnIndex;
        currentSort.direction = 'asc';
    }

    // Perform the sort (exclude header row at index 0)
    const header = data[0];
    const rows = data.slice(1);

    rows.sort((a, b) => {
        const aVal = (a[columnIndex] || '').toString().toLowerCase();
        const bVal = (b[columnIndex] || '').toString().toLowerCase();

        if (currentSort.direction === 'asc') {
            return aVal.localeCompare(bVal);
        } else {
            return bVal.localeCompare(aVal);
        }
    });

    // Rebuild data array with header + sorted rows
    data = [header, ...rows];
    render();
}

async function addRow() {
    // Get ID from first field
    const idInput = document.getElementById('c1').value.trim();

    // Validate SAP Part Number is provided
    if (!idInput) {
        showStatus('Error: SAP Part Number is required', 'error');
        return;
    }

    // Format the SAP Part Number
    const formattedID = formatID(idInput);
    if (!formattedID) {
        showStatus('Error: SAP Part Number must be exactly 10 digits (e.g., 8-114-463-187 or 8114463187)', 'error');
        return;
    }

    // Read all 13 fields (13 columns total)
    let row = [formattedID]; // Start with formatted SAP Part Number
    for (let i = 2; i <= 13; i++) {
        let v = document.getElementById('c' + i).value;
        row.push(v);
    }

    // Find existing entry by ID (skip header row at index 0)
    let existingIndex = -1;
    for (let i = 1; i < data.length; i++) {
        if (data[i][0] === formattedID) {
            existingIndex = i;
            break;
        }
    }

    if (existingIndex !== -1) {
        // Entry exists - ask for confirmation
        const existingRow = data[existingIndex];
        const confirmMessage = `An entry with SAP Part Number ${formattedID} already exists:\n\n` +
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

        if (confirm(confirmMessage)) {
            // User confirmed - replace the entry
            data[existingIndex] = row;
            if (originalData) originalData[existingIndex] = row;
            render();
            showStatus(`✓ Entry ${formattedID} replaced successfully`);
            await saveToServer();

            // Clear input fields
            for (let i = 1; i <= 13; i++) {
                document.getElementById('c' + i).value = '';
            }
        } else {
            // User cancelled
            showStatus(`Entry replacement cancelled`, 'info');
        }
    } else {
        // New entry - add it
        data.push(row);
        if (originalData) originalData.push(row);
        render();
        showStatus(`✓ New entry ${formattedID} added successfully`);
        await saveToServer();

        // Clear input fields
        for (let i = 1; i <= 13; i++) {
            document.getElementById('c' + i).value = '';
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

async function checkEOL(rowIndex) {
    const row = data[rowIndex];
    const model = row[3]; // Model is column 3
    const manufacturer = row[4]; // Manufacturer is column 4

    if (!model || !manufacturer) {
        showStatus('Error: Model and Manufacturer are required for EOL check', 'error');
        return;
    }

    // DISABLE ALL CHECK EOL BUTTONS (prevent parallel execution)
    disableAllCheckEOLButtons();

    try {
        // Show loading state
        const rowElement = document.getElementById(`row-${rowIndex}`);
        const checkButton = rowElement.querySelector('.check-eol');
        const originalButtonText = checkButton.textContent;
        checkButton.textContent = 'Waking Render...';

        // Wake up Render scraping service (handles cold starts and post-restart downtime)
        showStatus(`Waking up scraping service...`, 'info', false);
        await checkRenderHealth();

        checkButton.textContent = 'Initializing...';
        showStatus(`Initializing EOL check for ${manufacturer} ${model}...`, 'info', false);

        // Step 1: Initialize job (search and queue URLs)
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

        const jobId = initData.jobId;

        if (!jobId) {
            throw new Error('No job ID received');
        }

        // Update button to show processing state
        checkButton.textContent = 'Processing...';

        // Step 2: Poll for job status
        const result = await pollJobStatus(jobId, manufacturer, model, checkButton);

        // Update the row with results
        // New columns: SAP Part Number, Legacy Part Number, Designation, Model, Manufacturer,
        //              Status, Status Comment, Successor Model, Successor Comment,
        //              Successor SAP Number, Stock, Information Date, Auto Check

        // Column 5: Status (DISCONTINUED, ACTIVE, or UNKNOWN)
        row[5] = result.status || 'UNKNOWN';

        // Column 6: Status Comment
        row[6] = result.explanation || '';

        // Column 7: Successor Model
        row[7] = result.successor?.model || '';

        // Column 8: Successor Comment
        row[8] = result.successor?.explanation || '';

        // Column 11: Information Date
        row[11] = new Date().toLocaleString();

        // Update originalData if it exists (find by SAP Part Number)
        if (originalData) {
            const sapNumber = row[0];
            const originalIndex = originalData.findIndex(r => r[0] === sapNumber);
            if (originalIndex !== -1) {
                originalData[originalIndex] = [...row]; // Copy the updated row
            }
        }

        // Re-render the table
        render();

        // Save to server
        await saveToServer();

        // Refresh Tavily credits
        await loadTavilyCredits();

        // Update Groq rate limit display
        if (result.rateLimits) {
            updateGroqRateLimits(result.rateLimits);
        }

        showStatus(`✓ EOL check completed for ${manufacturer} ${model}`, 'success');

        // RE-ENABLE ALL CHECK EOL BUTTONS
        enableAllCheckEOLButtons();

    } catch (error) {
        console.error('EOL check failed:', error);
        showStatus(`Error checking EOL: ${error.message}`, 'error');

        // RE-ENABLE ALL CHECK EOL BUTTONS (even on error)
        enableAllCheckEOLButtons();
    }
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

            const statusResponse = await fetch(`/.netlify/functions/job-status/${jobId}`);

            if (!statusResponse.ok) {
                throw new Error(`Status check failed: ${statusResponse.status}`);
            }

            const statusData = await statusResponse.json();
            console.log('Job status:', statusData);

            // Update button text with progress
            if (checkButton) {
                const progress = `${statusData.completedUrls || 0}/${statusData.urlCount || 0}`;
                checkButton.textContent = `Processing (${progress})`;
            }

            // Update status message with progress
            showStatus(`Checking ${manufacturer} ${model}... (${statusData.completedUrls || 0}/${statusData.urlCount || 0} pages)`, 'info', false);

            if (statusData.status === 'complete') {
                // Job complete!
                console.log('Job complete:', statusData);
                return statusData.result;
            }

            if (statusData.status === 'error') {
                // Check if this is a daily limit error with countdown info
                if (statusData.isDailyLimit && statusData.retrySeconds) {
                    console.log(`Daily limit hit, starting countdown for ${statusData.retrySeconds}s`);
                    startGroqCountdown(statusData.retrySeconds);
                }
                throw new Error(statusData.error || 'Job failed');
            }

            // STEP 1: If URLs are ready, trigger fetch-url
            if (statusData.status === 'urls_ready' && !fetchTriggered) {
                console.log(`✓ URLs ready, triggering fetch-url (attempt ${attempts})`);

                // Trigger fetch-url for the first URL
                if (statusData.urls && statusData.urls.length > 0) {
                    const firstUrl = statusData.urls[0];
                    try {
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
                        fetch('/.netlify/functions/fetch-url', {
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
            const allUrlsComplete = statusData.urls && statusData.urls.length > 0 &&
                                     statusData.urls.every(u => u.status === 'complete');

            if (allUrlsComplete && !analyzeTriggered && statusData.status !== 'analyzing' && statusData.status !== 'complete') {
                console.log(`✓ All URLs scraped, triggering analyze-job (attempt ${attempts})`);

                try {
                    // Call analyze-job (fire-and-forget)
                    fetch('/.netlify/functions/analyze-job', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ jobId })
                    }).catch(err => {
                        console.error(`Failed to trigger analyze-job: ${err.message}`);
                    });

                    console.log(`✓ analyze-job triggered`);
                    analyzeTriggered = true;
                } catch (error) {
                    console.error(`Error triggering analyze-job: ${error.message}`);
                }
            }

            // Still processing - wait 2 seconds before next poll
            await new Promise(resolve => setTimeout(resolve, 2000));

        } catch (error) {
            console.error('Polling error:', error);
            throw error;
        }
    }

    // Timeout reached - return UNKNOWN result
    console.warn(`Job ${jobId} timed out after ${maxAttempts} attempts (2 minutes)`);
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

function loadExcel(e) {
    let f = e.target.files[0];
    if (!f) return;

    let r = new FileReader();
    r.onload = async function(ev) {
        try {
            // Parse Excel file
            const workbook = XLSX.read(ev.target.result, { type: 'binary' });

            // Get first worksheet
            const sheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[sheetName];

            // Convert to array of arrays
            const importedData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

            if (importedData.length === 0) {
                showStatus('Error: Excel file is empty', 'error');
                return;
            }

            // Find column index for SAP Part Number
            const headers = importedData[0];
            console.log('Excel headers found:', headers);

            const idIndex = headers.findIndex(h => {
                const headerText = h && h.toString().toLowerCase().trim();
                return headerText === 'sap part number';
            });

            if (idIndex === -1) {
                console.error('SAP Part Number column not found. Headers:', headers);
                showStatus('Error: Excel file must contain "SAP Part Number" column. Found headers: ' + headers.join(', '), 'error');
                return;
            }

            console.log('SAP Part Number column found at index:', idIndex);

            // Track statistics
            let newEntries = 0;
            let updatedEntries = 0;
            let skippedEntries = 0;

            // Process each row from the imported file (skip header)
            for (let i = 1; i < importedData.length; i++) {
                const importedRow = importedData[i];

                // Skip empty rows
                if (!importedRow || importedRow.length === 0) continue;

                const idInput = (importedRow[idIndex] || '').toString().trim();

                // Skip rows without SAP Number
                if (!idInput) {
                    console.log(`Row ${i}: Skipped - no SAP Number`);
                    skippedEntries++;
                    continue;
                }

                // Format the SAP Number
                const formattedID = formatID(idInput);
                if (!formattedID) {
                    console.warn(`Row ${i}: Invalid SAP Number format: "${idInput}" (must be exactly 10 digits)`);
                    skippedEntries++;
                    continue; // Skip invalid SAP Numbers
                }

                console.log(`Row ${i}: Processing SAP Number ${formattedID}`);

                // Build a complete row with all columns
                const newRow = [];
                const ourHeaders = data[0]; // Our standard headers

                for (let j = 0; j < ourHeaders.length; j++) {
                    const headerName = ourHeaders[j].toLowerCase().trim();

                    if (headerName === 'sap part number') {
                        // Use formatted SAP Part Number
                        newRow.push(formattedID);
                    } else {
                        const importColIndex = headers.findIndex(h => h && h.toString().toLowerCase().trim() === headerName);

                        if (importColIndex !== -1 && importedRow[importColIndex] !== undefined) {
                            newRow.push(importedRow[importColIndex].toString());
                        } else {
                            newRow.push(''); // Fill missing columns with empty string
                        }
                    }
                }

                // Find existing entry with same ID
                let existingIndex = -1;
                for (let k = 1; k < data.length; k++) {
                    if (data[k][0] === formattedID) {
                        existingIndex = k;
                        break;
                    }
                }

                if (existingIndex !== -1) {
                    // Update existing entry
                    data[existingIndex] = newRow;
                    if (originalData) originalData[existingIndex] = newRow;
                    updatedEntries++;
                } else {
                    // Add new entry
                    data.push(newRow);
                    if (originalData) originalData.push(newRow);
                    newEntries++;
                }
            }

            // Reset sorting state after import (data has changed)
            originalData = null;
            currentSort.column = null;
            currentSort.direction = null;

            render();

            // Save to server first
            await saveToServer();

            // Then show import summary (so it doesn't get overwritten)
            let statusMsg = `✓ Imported: ${newEntries} new entries, ${updatedEntries} updated entries`;
            if (skippedEntries > 0) {
                statusMsg += `, ${skippedEntries} skipped (invalid/missing SAP Number)`;
            }
            console.log('Import completed:', { newEntries, updatedEntries, skippedEntries });
            showStatus(statusMsg);

        } catch (error) {
            console.error('Excel import failed:', error);
            showStatus('Error importing Excel file: ' + error.message, 'error');
        }
    };
    r.readAsBinaryString(f);
}

// Netlify Functions integration with Netlify Blobs
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

    if (!rateLimits || !rateLimits.remainingTokens || !rateLimits.limitTokens) {
        groqElement.textContent = 'N/A';
    } else {
        const remaining = parseInt(rateLimits.remainingTokens);
        const limit = parseInt(rateLimits.limitTokens);

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
    if (rateLimits && rateLimits.resetSeconds !== null && rateLimits.resetSeconds !== undefined) {
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

// Check Render scraping service health
async function checkRenderHealth() {
    const renderStatusElement = document.getElementById('render-status');
    const renderServiceUrl = 'https://eolscrapingservice.onrender.com';

    try {
        renderStatusElement.textContent = 'Checking...';
        renderStatusElement.classList.remove('credits-high', 'credits-medium', 'credits-low');

        const startTime = Date.now();

        // Call health endpoint with timeout
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 60000); // 60s timeout for cold start

        const response = await fetch(`${renderServiceUrl}/health`, {
            signal: controller.signal
        });

        clearTimeout(timeout);

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        if (response.ok) {
            const data = await response.json();

            if (elapsed > 10) {
                // Cold start detected (took >10s)
                renderStatusElement.textContent = `Ready (cold start: ${elapsed}s)`;
                renderStatusElement.classList.add('credits-medium');
            } else {
                // Already warm
                renderStatusElement.textContent = `Ready (${elapsed}s)`;
                renderStatusElement.classList.add('credits-high');
            }

            console.log(`Render health check: OK in ${elapsed}s`, data);
        } else {
            renderStatusElement.textContent = `Error (HTTP ${response.status})`;
            renderStatusElement.classList.add('credits-low');
        }

    } catch (error) {
        console.error('Render health check failed:', error);

        if (error.name === 'AbortError') {
            renderStatusElement.textContent = 'Timeout (>60s)';
        } else {
            renderStatusElement.textContent = `Offline (${error.message})`;
        }

        renderStatusElement.classList.add('credits-low');
    }
}

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

// Manual trigger for testing
async function manualTriggerAutoCheck() {
    const button = document.getElementById('manual-trigger-btn');
    const originalText = button.textContent;

    try {
        button.textContent = 'Triggering...';
        button.disabled = true;

        showStatus('Resetting daily counter and triggering auto-check...', 'info');

        // Reset the daily counter to 0 for testing purposes
        const resetResponse = await fetch('/.netlify/functions/set-auto-check-state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dailyCounter: 0 })
        });

        if (!resetResponse.ok) {
            throw new Error('Failed to reset counter: ' + resetResponse.statusText);
        }

        console.log('Daily counter reset to 0');
        showStatus('Counter reset. Triggering auto-check...', 'info');

        // Set isRunning = true before triggering
        const runningResponse = await fetch('/.netlify/functions/set-auto-check-state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ isRunning: true })
        });

        if (!runningResponse.ok) {
            throw new Error('Failed to set running state: ' + runningResponse.statusText);
        }

        // Pass the current site URL to the background function
        const siteUrl = window.location.origin;

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
        if (isRunning) {
            button.style.display = 'none';
        } else {
            button.style.display = '';
        }
    });
}

// Disable all Check EOL buttons (for manual check - prevent parallel execution)
function disableAllCheckEOLButtons() {
    isManualCheckRunning = true; // Set global flag
    const checkButtons = document.querySelectorAll('.check-eol');
    checkButtons.forEach(button => {
        button.style.display = 'none';
    });
    console.log('All Check EOL buttons disabled (manual check in progress)');
}

// Enable all Check EOL buttons (after manual check completes)
function enableAllCheckEOLButtons() {
    isManualCheckRunning = false; // Clear global flag
    const checkButtons = document.querySelectorAll('.check-eol');
    checkButtons.forEach(button => {
        button.style.display = '';
    });
    console.log('All Check EOL buttons re-enabled (manual check complete)');
}

// Monitor auto-check state periodically
let autoCheckMonitoringInterval = null;

function startAutoCheckMonitoring() {
    // Check every 10 seconds
    autoCheckMonitoringInterval = setInterval(async () => {
        try {
            const response = await fetch('/.netlify/functions/get-auto-check-state');
            if (response.ok) {
                const state = await response.json();

                // Update toggle to match server state (fixes slider jumping back on reload)
                const toggle = document.getElementById('auto-check-toggle');
                if (toggle && toggle.checked !== state.enabled) {
                    console.log(`Syncing toggle with server state: ${state.enabled}`);
                    toggle.checked = state.enabled;
                }

                // Detect stuck isRunning state (isRunning=true but no activity for >5 minutes)
                if (state.isRunning) {
                    const lastActivity = state.lastActivityTime ? new Date(state.lastActivityTime) : null;
                    const now = new Date();
                    const minutesSinceActivity = lastActivity ? (now - lastActivity) / 1000 / 60 : 999;

                    if (minutesSinceActivity > 5) {
                        console.warn(`Detected stuck isRunning state (no activity for ${minutesSinceActivity.toFixed(1)} min), resetting...`);

                        // Reset isRunning to false
                        await fetch('/.netlify/functions/set-auto-check-state', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ isRunning: false })
                        });

                        // Update local state
                        state.isRunning = false;
                        showStatus('Auto-check recovered from stuck state', 'info');
                    }
                }

                // Update buttons based on isRunning
                // BUT: Don't override manual check state
                if (!isManualCheckRunning) {
                    updateCheckEOLButtons(state.isRunning);
                }

                // Auto-disable if credits too low
                const creditsElement = document.getElementById('credits-remaining');
                if (creditsElement) {
                    const creditsText = creditsElement.textContent;
                    const match = creditsText.match(/(\d+)\/\d+ remaining/);
                    if (match) {
                        const remaining = parseInt(match[1]);
                        if (remaining <= 50 && state.enabled) {
                            console.log('Auto-disabling auto-check due to low credits:', remaining);

                            // Disable auto-check
                            await fetch('/.netlify/functions/set-auto-check-state', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ enabled: false })
                            });

                            // Update toggle
                            if (toggle) toggle.checked = false;

                            showStatus('Auto EOL Check disabled - Tavily credits too low (≤50)', 'info');
                        }
                    }
                }
            }
        } catch (error) {
            console.error('Auto-check monitoring error:', error);
        }
    }, 10000); // Every 10 seconds
}

// Initialize when page loads
document.addEventListener('DOMContentLoaded', init);
