let data = [['Model', 'Maker', 'EOL Status', 'EOL Comment', 'Successor Status', 'Successor Name', 'Successor Comment']];

// Initialize the app
async function init() {
    await loadFromServer();
    await loadGroqUsage();
}

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

function render() {
    let t = document.getElementById('table');
    t.innerHTML = data.map((r, i) =>
        `<tr id="row-${i}">${r.map((c, j) =>
            i == 0 ? `<th>${c}</th>` : `<td>${c}</td>`
        ).join('')}${i > 0 ? `<td><button class="check-eol" onclick="checkEOL(${i})">Check EOL</button><button class="delete" onclick="delRow(${i})">Delete</button></td>` : '<th>Actions</th>'}</tr>`
    ).join('');
}

async function addRow() {
    let row = [];
    for (let i = 1; i <= 7; i++) {
        let v = document.getElementById('c' + i).value;
        row.push(v);
        document.getElementById('c' + i).value = '';
    }

    // Check if entry with same Model (index 0) and Maker (index 1) already exists
    const model = row[0].trim();
    const maker = row[1].trim();

    // Find existing entry (skip header row at index 0)
    let existingIndex = -1;
    for (let i = 1; i < data.length; i++) {
        if (data[i][0].trim() === model && data[i][1].trim() === maker) {
            existingIndex = i;
            break;
        }
    }

    if (existingIndex !== -1) {
        // Update existing entry
        data[existingIndex] = row;
        render();
        showStatus(`Updated existing entry for "${model}" (${maker})`);
        await saveToServer();
    } else {
        // Add new entry
        data.push(row);
        render();
        showStatus(`Added new entry for "${model}" (${maker})`);
        await saveToServer();
    }
}

async function delRow(i) {
    data.splice(i, 1);
    render();
    await saveToServer();
}

async function checkEOL(rowIndex) {
    const row = data[rowIndex];
    const model = row[0]; // Model is column 0
    const maker = row[1]; // Maker is column 1

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
        // Columns: Model, Maker, EOL Status, EOL Comment, Successor Status, Successor Name, Successor Comment

        // Column 2: EOL Status (DISCONTINUED, ACTIVE, or UNKNOWN)
        row[2] = result.status || 'UNKNOWN';

        // Column 3: EOL Comment
        row[3] = result.explanation || '';

        // Column 4: Successor Status
        if (result.successor?.status === 'FOUND') {
            row[4] = 'YES';
        } else {
            row[4] = 'UNKNOWN';
        }

        // Column 5: Successor Name
        row[5] = result.successor?.model || '';

        // Column 6: Successor Comment
        row[6] = result.successor?.explanation || '';

        // Re-render the table
        render();

        // Save to server
        await saveToServer();

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

            // Find column indices for Model and Maker
            const headers = importedData[0];
            const modelIndex = headers.findIndex(h => h && h.toString().toLowerCase().trim() === 'model');
            const makerIndex = headers.findIndex(h => h && h.toString().toLowerCase().trim() === 'maker');

            if (modelIndex === -1 || makerIndex === -1) {
                showStatus('Error: Excel file must contain "Model" and "Maker" columns', 'error');
                return;
            }

            // Track statistics
            let newEntries = 0;
            let updatedEntries = 0;

            // Process each row from the imported file (skip header)
            for (let i = 1; i < importedData.length; i++) {
                const importedRow = importedData[i];

                // Skip empty rows
                if (!importedRow || importedRow.length === 0) continue;

                const model = (importedRow[modelIndex] || '').toString().trim();
                const maker = (importedRow[makerIndex] || '').toString().trim();

                // Skip rows without Model or Maker
                if (!model || !maker) continue;

                // Build a complete row with all 7 columns
                const newRow = [];
                const ourHeaders = data[0]; // Our standard headers

                for (let j = 0; j < ourHeaders.length; j++) {
                    const headerName = ourHeaders[j].toLowerCase().trim();
                    const importColIndex = headers.findIndex(h => h && h.toString().toLowerCase().trim() === headerName);

                    if (importColIndex !== -1 && importedRow[importColIndex] !== undefined) {
                        newRow.push(importedRow[importColIndex].toString());
                    } else {
                        newRow.push(''); // Fill missing columns with empty string
                    }
                }

                // Find existing entry with same Model and Maker
                let existingIndex = -1;
                for (let k = 1; k < data.length; k++) {
                    if (data[k][0].trim() === model && data[k][1].trim() === maker) {
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
            showStatus(`Imported: ${newEntries} new entries, ${updatedEntries} updated entries`);
            await saveToServer();

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


async function loadGroqUsage() {
    try {
        const response = await fetch('/.netlify/functions/get-groq-usage');

        if (!response.ok) {
            throw new Error(`Failed to fetch Groq usage: ${response.status}`);
        }

        const result = await response.json();

        // Update both displays using the same function we use after EOL checks
        updateGroqRateLimits(result);

    } catch (error) {
        console.error('Failed to load Groq usage:', error);
        const groqTPMElement = document.getElementById('groq-tpm');
        const groqRPDElement = document.getElementById('groq-rpd');
        groqTPMElement.textContent = 'Error loading';
        groqRPDElement.textContent = 'Error loading';
        groqTPMElement.classList.remove('credits-high', 'credits-medium', 'credits-low');
        groqRPDElement.classList.remove('credits-high', 'credits-medium', 'credits-low');
    }
}

function updateGroqRateLimits(rateLimits) {
    const groqTPMElement = document.getElementById('groq-tpm');
    const groqRPDElement = document.getElementById('groq-rpd');

    // Update TPM (Tokens Per Minute) display
    if (!rateLimits || !rateLimits.remainingTokens || !rateLimits.limitTokens) {
        groqTPMElement.textContent = 'N/A';
    } else {
        const remainingTokens = parseInt(rateLimits.remainingTokens);
        const limitTokens = parseInt(rateLimits.limitTokens);

        // Format with comma separators for readability
        const remainingFormatted = remainingTokens.toLocaleString();
        const limitFormatted = limitTokens.toLocaleString();

        groqTPMElement.textContent = `${remainingFormatted}/${limitFormatted}`;

        // Apply color coding based on percentage remaining
        groqTPMElement.classList.remove('credits-high', 'credits-medium', 'credits-low');

        const percentRemaining = (remainingTokens / limitTokens) * 100;

        if (percentRemaining > 50) {
            groqTPMElement.classList.add('credits-high');
        } else if (percentRemaining > 20) {
            groqTPMElement.classList.add('credits-medium');
        } else {
            groqTPMElement.classList.add('credits-low');
        }
    }

    // Update RPD (Requests Per Day) display
    if (!rateLimits || !rateLimits.remainingRequests || !rateLimits.limitRequests) {
        groqRPDElement.textContent = 'N/A';
    } else {
        const remainingRequests = parseInt(rateLimits.remainingRequests);
        const limitRequests = parseInt(rateLimits.limitRequests);

        // Format with comma separators for readability
        const remainingFormatted = remainingRequests.toLocaleString();
        const limitFormatted = limitRequests.toLocaleString();

        groqRPDElement.textContent = `${remainingFormatted}/${limitFormatted}`;

        // Apply color coding based on percentage remaining
        groqRPDElement.classList.remove('credits-high', 'credits-medium', 'credits-low');

        const percentRemaining = (remainingRequests / limitRequests) * 100;

        if (percentRemaining > 50) {
            groqRPDElement.classList.add('credits-high');
        } else if (percentRemaining > 20) {
            groqRPDElement.classList.add('credits-medium');
        } else {
            groqRPDElement.classList.add('credits-low');
        }
    }
}

// Initialize when page loads
document.addEventListener('DOMContentLoaded', init);
