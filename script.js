let data = [['SAP Number', 'Model', 'Maker', 'EOL Status', 'EOL Comment', 'Successor Status', 'Successor Name', 'Successor Comment', 'Last Check Date']];

// Auto-refresh interval for Groq rate limits
let groqRefreshInterval = null;

// Initialize the app
async function init() {
    await loadFromServer();
    await loadTavilyCredits();
    await loadGroqUsage();

    // Start auto-refresh for Groq rate limits (every 60 seconds)
    startGroqAutoRefresh();
}

// Start automatic refresh of Groq rate limits
function startGroqAutoRefresh() {
    // Clear any existing interval
    if (groqRefreshInterval) {
        clearInterval(groqRefreshInterval);
    }

    // Refresh every 60 seconds
    groqRefreshInterval = setInterval(async () => {
        // Only refresh if page is visible
        if (!document.hidden) {
            await loadGroqUsage();
        }
    }, 60000); // 60000ms = 60 seconds
}

// Stop automatic refresh when page is hidden (optional, for efficiency)
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        // Page is hidden, interval will skip updates
        console.log('Page hidden - pausing Groq auto-refresh');
    } else {
        // Page is visible again, refresh immediately
        console.log('Page visible - resuming Groq auto-refresh');
        loadGroqUsage();
    }
});

function showStatus(message, type = 'success', permanent = true) {
    const status = document.getElementById('status');
    status.textContent = message;
    status.className = type;
    if (!permanent) {
        setTimeout(() => {
            status.textContent = '';
            status.className = '';
        }, 300000);
    }
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

    // Validate SAP Number is provided
    if (!idInput) {
        showStatus('Error: SAP Number is required', 'error');
        return;
    }

    // Format the SAP Number
    const formattedID = formatID(idInput);
    if (!formattedID) {
        showStatus('Error: SAP Number must be exactly 10 digits (e.g., 8-114-463-187 or 8114463187)', 'error');
        return;
    }

    // Read all fields
    let row = [formattedID]; // Start with formatted ID
    for (let i = 2; i <= 9; i++) {
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
        const confirmMessage = `An entry with SAP Number ${formattedID} already exists:\n\n` +
            `SAP Number: ${existingRow[0]}\n` +
            `Model: ${existingRow[1]}\n` +
            `Maker: ${existingRow[2]}\n` +
            `EOL Status: ${existingRow[3]}\n` +
            `EOL Comment: ${existingRow[4]}\n` +
            `Successor Status: ${existingRow[5]}\n` +
            `Successor Name: ${existingRow[6]}\n` +
            `Successor Comment: ${existingRow[7]}\n` +
            `Last Check Date: ${existingRow[8]}\n\n` +
            `Do you want to replace this entry with the new data?`;

        if (confirm(confirmMessage)) {
            // User confirmed - replace the entry
            data[existingIndex] = row;
            render();
            showStatus(`✓ Entry ${formattedID} replaced successfully`);
            await saveToServer();

            // Clear input fields
            for (let i = 1; i <= 9; i++) {
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
        for (let i = 1; i <= 9; i++) {
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
    const model = row[1]; // Model is column 1 (after ID)
    const maker = row[2]; // Maker is column 2 (after ID)

    if (!model || !maker) {
        showStatus('Error: Model and Maker are required for EOL check', 'error');
        return;
    }

    try {
        // Show loading state
        const rowElement = document.getElementById(`row-${rowIndex}`);
        const checkButton = rowElement.querySelector('.check-eol');
        const originalButtonText = checkButton.textContent;
        checkButton.textContent = 'Checking...';
        checkButton.disabled = true;

        showStatus(`Checking EOL status for ${maker} ${model}...`, 'info', false);

        // Call the Netlify function
        const response = await fetch('/.netlify/functions/check-eol', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ model, maker })
        });

        const result = await response.json();

        // Handle rate limiting (429)
        if (response.status === 429 && result.rateLimited) {
            showStatus('Rate limit exceeded. Please wait a moment and try again.', 'error');
            checkButton.textContent = originalButtonText;
            checkButton.disabled = false;
            return;
        }

        if (!response.ok) {
            throw new Error(result.error || `Server error: ${response.status}`);
        }

        // Update the row with results
        // Columns: SAP Number, Model, Maker, EOL Status, EOL Comment, Successor Status, Successor Name, Successor Comment, Last Check Date

        // Column 3: EOL Status (DISCONTINUED, ACTIVE, or UNKNOWN)
        row[3] = result.status || 'UNKNOWN';

        // Column 4: EOL Comment
        row[4] = result.explanation || '';

        // Column 5: Successor Status
        if (result.successor?.status === 'FOUND') {
            row[5] = 'YES';
        } else {
            row[5] = 'UNKNOWN';
        }

        // Column 6: Successor Name
        row[6] = result.successor?.model || '';

        // Column 7: Successor Comment
        row[7] = result.successor?.explanation || '';

        // Column 8: Last Check Date
        row[8] = new Date().toLocaleString();

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

        showStatus(`✓ EOL check completed for ${maker} ${model}`, 'success');

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

            // Find column index for SAP Number
            const headers = importedData[0];
            console.log('Excel headers found:', headers);

            const idIndex = headers.findIndex(h => {
                const headerText = h && h.toString().toLowerCase().trim();
                return headerText === 'id' || headerText === 'sap number';
            });

            if (idIndex === -1) {
                console.error('SAP Number/ID column not found. Headers:', headers);
                showStatus('Error: Excel file must contain "SAP Number" or "ID" column. Found headers: ' + headers.join(', '), 'error');
                return;
            }

            console.log('SAP Number column found at index:', idIndex);

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

                    if (headerName === 'sap number' || headerName === 'id') {
                        // Use formatted SAP Number
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

            // Backward compatibility: Add "SAP Number" column and update structure
            const expectedColumns = 9; // SAP Number, Model, Maker, EOL Status, EOL Comment, Successor Status, Successor Name, Successor Comment, Last Check Date

            // Check if we need to add SAP Number column (old data won't have it or may have "ID")
            const firstColumn = data[0] && data[0][0] && data[0][0].toLowerCase().trim();
            const hasSAPColumn = firstColumn === 'sap number';
            const hasIDColumn = firstColumn === 'id';

            if (!hasSAPColumn) {
                if (hasIDColumn) {
                    // Rename "ID" to "SAP Number"
                    data[0][0] = 'SAP Number';
                } else {
                    // Old data format - add SAP Number column as first column
                    data[0] = ['SAP Number', 'Model', 'Maker', 'EOL Status', 'EOL Comment', 'Successor Status', 'Successor Name', 'Successor Comment', 'Last Check Date'];

                    // Add empty SAP Number to all existing data rows
                    for (let i = 1; i < data.length; i++) {
                        data[i].unshift(''); // Add empty SAP Number at the beginning
                    }
                }
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
        const groqDayElement = document.getElementById('groq-remaining-day');
        groqElement.textContent = 'Error loading';
        groqDayElement.textContent = 'Error loading';
        groqElement.classList.remove('credits-high', 'credits-medium', 'credits-low');
        groqDayElement.classList.remove('credits-high', 'credits-medium', 'credits-low');
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

    // Update requests per day
    const groqDayElement = document.getElementById('groq-remaining-day');

    if (!rateLimits || !rateLimits.remainingRequests || !rateLimits.limitRequests ||
        rateLimits.remainingRequests === 'N/A' || rateLimits.limitRequests === 'N/A') {
        groqDayElement.textContent = 'N/A';
        groqDayElement.classList.remove('credits-high', 'credits-medium', 'credits-low');
    } else {
        const remainingDay = parseInt(rateLimits.remainingRequests);
        const limitDay = parseInt(rateLimits.limitRequests);

        // Format with comma separators for readability
        const remainingDayFormatted = remainingDay.toLocaleString();
        const limitDayFormatted = limitDay.toLocaleString();

        groqDayElement.textContent = `${remainingDayFormatted}/${limitDayFormatted} RPD`;

        // Apply color coding based on percentage remaining
        groqDayElement.classList.remove('credits-high', 'credits-medium', 'credits-low');

        const percentRemainingDay = (remainingDay / limitDay) * 100;

        if (percentRemainingDay > 50) {
            groqDayElement.classList.add('credits-high');
        } else if (percentRemainingDay > 20) {
            groqDayElement.classList.add('credits-medium');
        } else {
            groqDayElement.classList.add('credits-low');
        }
    }
}

// Initialize when page loads
document.addEventListener('DOMContentLoaded', init);
