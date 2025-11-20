let data = [['Model', 'Maker', 'EOL Status', 'EOL Comment', 'Successor Status', 'Successor Name', 'Successor Comment']];

// Initialize the app 
async function init() {
    await loadFromServer();
}

function showStatus(message, type = 'success', permanent = false) {
    const status = document.getElementById('status');
    status.textContent = message;
    status.className = type;
    if (!permanent) {
        setTimeout(() => {
            status.textContent = '';
            status.className = '';
        }, 3000);
    }
}

function render() {
    let t = document.getElementById('table');
    t.innerHTML = data.map((r, i) =>
        `<tr>${r.map((c, j) =>
            i == 0 ? `<th>${c}</th>` : `<td>${c}</td>`
        ).join('')}${i > 0 ? `<td><button class="delete" onclick="delRow(${i})">Delete</button></td>` : ''}</tr>`
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

async function downloadCSV() {
    try {
        const response = await fetch('/.netlify/functions/get-csv');

        if (!response.ok) {
            throw new Error(`Server error: ${response.status}`);
        }

        const result = await response.json();

        if (result.data) {
            // Convert data to CSV format
            const csv = result.data.map(r => r.map(c => `"${c}"`).join(',')).join('\n');
            const a = document.createElement('a');
            a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
            a.download = 'database.csv';
            a.click();
            showStatus('Database downloaded successfully!');
        } else {
            showStatus('No data available to download', 'error');
        }
    } catch (error) {
        console.error('Download failed:', error);
        showStatus('Error downloading database: ' + error.message, 'error');
    }
}

function loadCSV(e) {
    let f = e.target.files[0];
    if (!f) return;

    let r = new FileReader();
    r.onload = async function(ev) {
        let lines = ev.target.result.split('\n').filter(l => l.trim());
        data = lines.map(l => l.split(',').map(c => c.replace(/^"|"$/g, '')));
        render();
        showStatus('Importing CSV and saving to cloud storage...');
        await saveToServer();
    };
    r.readAsText(f);
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

// Initialize when page loads
document.addEventListener('DOMContentLoaded', init);
