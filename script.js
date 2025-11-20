let data = [['Model', 'Maker', 'EOL Status', 'EOL Comment', 'Successor Status', 'Successor Name', 'Successor Comment']];

// Initialize the app
async function init() {
    await loadFromServer();
}

function showStatus(message, type = 'success') {
    const status = document.getElementById('status');
    status.textContent = message;
    status.className = type;
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
    data.push(row);
    render();
    await saveToServer();
}

async function delRow(i) {
    data.splice(i, 1);
    render();
    await saveToServer();
}

async function downloadCSV() {
    try {
        // Try to fetch from Netlify function first
        const response = await fetch('/.netlify/functions/get-csv');
        const result = await response.json();

        if (response.ok && result.data) {
            // Convert data to CSV format
            const csv = result.data.map(r => r.map(c => `"${c}"`).join(',')).join('\n');
            const a = document.createElement('a');
            a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
            a.download = 'database.csv';
            a.click();
            showStatus('Database downloaded successfully!');
            return;
        }
    } catch (error) {
        console.log('Netlify function unavailable, trying direct download:', error);
    }

    // Fallback: try direct link to static file
    try {
        const response = await fetch('/database.csv');
        if (response.ok) {
            const text = await response.text();
            const a = document.createElement('a');
            a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(text);
            a.download = 'database.csv';
            a.click();
            showStatus('Database downloaded successfully!');
            return;
        }
    } catch (error) {
        console.log('Static file download failed:', error);
    }

    showStatus('Error downloading database.csv', 'error');
}

function loadCSV(e) {
    let f = e.target.files[0];
    if (!f) return;

    let r = new FileReader();
    r.onload = async function(ev) {
        let lines = ev.target.result.split('\n').filter(l => l.trim());
        data = lines.map(l => l.split(',').map(c => c.replace(/^"|"$/g, '')));
        render();
        showStatus('Importing CSV and replacing database.csv...');
        await saveToServer();
    };
    r.readAsText(f);
}

// Netlify Functions integration
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
            showStatus('Changes saved to database.csv successfully!');
        } else {
            showStatus('Error saving to database.csv: ' + result.error, 'error');
        }
    } catch (error) {
        showStatus('Network error: ' + error.message, 'error');
    }
}

async function loadFromServer() {
    try {
        // Try Netlify function first
        const response = await fetch('/.netlify/functions/get-csv');
        const result = await response.json();

        if (response.ok && result.data) {
            data = result.data;
            render();
            showStatus('✓ Database loaded successfully - all changes will be saved automatically');
            return;
        }
    } catch (error) {
        console.log('Netlify function unavailable, trying direct file access:', error);
    }

    // Fallback: try loading database.csv as a static file
    try {
        const response = await fetch('/database.csv');
        if (response.ok) {
            const text = await response.text();
            const lines = text.split('\n').filter(l => l.trim());
            data = lines.map(line => {
                // Simple CSV parser for quoted fields
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
                        i++; // Skip next quote
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
            render();
            showStatus('⚠️ WARNING: Static file mode - Changes will NOT be saved! Netlify functions are unavailable.', 'error', true);
            return;
        }
    } catch (error) {
        console.log('Static file access failed:', error);
    }

    // If both methods fail
    showStatus('Error loading database.csv - using default headers', 'error');
    render();
}

// Initialize when page loads
document.addEventListener('DOMContentLoaded', init);
