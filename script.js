let data = [['SAP Part Number', 'Legacy Part Number', 'Designation', 'Model', 'Manufacturer', 'Status', 'Status Comment', 'Successor Model', 'Successor Comment', 'Successor SAP Number', 'Stock', 'Information Date', 'Auto Check']];

// Countdown interval for Groq rate limit reset
let groqCountdownInterval = null;
let groqResetTimestamp = null;

// Initialize the app
async function init() {
    await loadFromServer();
    await loadTavilyCredits();
    await loadGroqUsage();
    await checkRenderHealth();
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
    let t = document.getElementById('table');
    t.innerHTML = data.map((r, i) =>
        `<tr id="row-${i}">${r.map((c, j) =>
            i == 0 ? `<th>${c}</th>` : `<td>${c}</td>`
        ).join('')}${i > 0 ? `<td><button class="check-eol" onclick="checkEOL(${i})">Check EOL</button><button class="delete" onclick="delRow(${i})">Delete</button></td>` : '<th>Actions</th>'}</tr>`
    ).join('');
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

    try {
        // Show loading state
        const rowElement = document.getElementById(`row-${rowIndex}`);
        const checkButton = rowElement.querySelector('.check-eol');
        const originalButtonText = checkButton.textContent;
        checkButton.textContent = 'Waking Render...';
        checkButton.disabled = true;

        // Wake up Render scraping service (handles cold starts)
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

        // Re-enable button
        checkButton.textContent = originalButtonText;
        checkButton.disabled = false;

    } catch (error) {
        console.error('EOL check failed:', error);
        showStatus(`Error checking EOL: ${error.message}`, 'error');

        // Re-enable button
        const rowElement = document.getElementById(`row-${rowIndex}`);
        const checkButton = rowElement.querySelector('.check-eol');
        checkButton.textContent = 'Check EOL';
        checkButton.disabled = false;
    }
}

// Poll job status until complete
async function pollJobStatus(jobId, manufacturer, model, checkButton) {
    const maxAttempts = 90; // 90 attempts * 2s = 3 min max
    let attempts = 0;

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
                throw new Error(statusData.error || 'Job failed');
            }

            // Still processing - wait 2 seconds before next poll
            await new Promise(resolve => setTimeout(resolve, 2000));

        } catch (error) {
            console.error('Polling error:', error);
            throw error;
        }
    }

    throw new Error('Job timeout - processing took too long');
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

            // Find column index for SAP Part Number (accept old names for backward compatibility)
            const headers = importedData[0];
            console.log('Excel headers found:', headers);

            const idIndex = headers.findIndex(h => {
                const headerText = h && h.toString().toLowerCase().trim();
                return headerText === 'id' ||
                       headerText === 'sap number' ||
                       headerText === 'sap part number';
            });

            if (idIndex === -1) {
                console.error('SAP Part Number column not found. Headers:', headers);
                showStatus('Error: Excel file must contain "SAP Part Number", "SAP Number", or "ID" column. Found headers: ' + headers.join(', '), 'error');
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

                    if (headerName === 'sap part number' || headerName === 'sap number' || headerName === 'id') {
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
                    updatedEntries++;
                } else {
                    // Add new entry
                    data.push(newRow);
                    newEntries++;
                }
            }

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

            // Backward compatibility: Migrate old data structure to new 13-column structure
            const expectedColumns = 13; // New structure has 13 columns
            const firstColumn = data[0] && data[0][0] && data[0][0].toLowerCase().trim();

            // Check if this is old data that needs migration
            if (firstColumn === 'sap number' && data[0].length === 9) {
                // Old 9-column structure needs migration
                console.log('Migrating old 9-column structure to new 13-column structure');

                // Update header row
                const newHeader = [
                    'SAP Part Number',    // 0 - was 'SAP Number'
                    'Legacy Part Number', // 1 - NEW
                    'Designation',        // 2 - NEW
                    'Model',             // 3 - was index 1
                    'Manufacturer',      // 4 - was 'Maker' at index 2
                    'Status',            // 5 - was 'EOL Status' at index 3
                    'Status Comment',    // 6 - was 'EOL Comment' at index 4
                    'Successor Model',   // 7 - was 'Successor Name' at index 6
                    'Successor Comment', // 8 - was index 7
                    'Successor SAP Number', // 9 - NEW
                    'Stock',            // 10 - NEW
                    'Information Date', // 11 - was 'Last Check Date' at index 8
                    'Auto Check'        // 12 - NEW
                ];

                const migratedData = [newHeader];

                // Migrate each data row
                for (let i = 1; i < data.length; i++) {
                    const oldRow = data[i];
                    const newRow = [
                        oldRow[0] || '', // SAP Part Number (was SAP Number)
                        '',              // Legacy Part Number - NEW
                        '',              // Designation - NEW
                        oldRow[1] || '', // Model
                        oldRow[2] || '', // Manufacturer (was Maker)
                        oldRow[3] || '', // Status (was EOL Status)
                        oldRow[4] || '', // Status Comment (was EOL Comment)
                        oldRow[6] || '', // Successor Model (was Successor Name) - skip old index 5 (Successor Status)
                        oldRow[7] || '', // Successor Comment
                        '',              // Successor SAP Number - NEW
                        '',              // Stock - NEW
                        oldRow[8] || '', // Information Date (was Last Check Date)
                        ''               // Auto Check - NEW
                    ];
                    migratedData.push(newRow);
                }

                data = migratedData;
            } else if (firstColumn === 'id') {
                // Very old data with "ID" column
                data[0][0] = 'SAP Part Number';
            }

            // Ensure all rows have the expected number of columns
            for (let i = 0; i < data.length; i++) {
                while (data[i].length < expectedColumns) {
                    data[i].push(''); // Add empty string for missing columns
                }
            }

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
    if (toggle.checked) {
        document.body.classList.add('show-delete-buttons');
    } else {
        document.body.classList.remove('show-delete-buttons');
    }
}

// Initialize when page loads
document.addEventListener('DOMContentLoaded', init);
