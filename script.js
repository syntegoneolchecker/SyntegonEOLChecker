let data = [['Col1', 'Col2', 'Col3', 'Col4', 'Col5', 'Col6', 'Col7']];

// Initialize the app
async function init() {
    await loadFromServer();
}

function showStatus(message, type = 'success') {
    const status = document.getElementById('status');
    status.textContent = message;
    status.className = type;
    setTimeout(() => {
        status.textContent = '';
        status.className = '';
    }, 3000);
}

function render() {
    let t = document.getElementById('table');
    t.innerHTML = data.map((r, i) =>
        `<tr>${r.map((c, j) =>
            i == 0 ? `<th>${c}</th>` : `<td>${c}</td>`
        ).join('')}${i > 0 ? `<td><button class="delete" onclick="delRow(${i})">Delete</button></td>` : ''}</tr>`
    ).join('');
}

function addRow() {
    let row = [];
    for (let i = 1; i <= 7; i++) {
        let v = document.getElementById('c' + i).value;
        row.push(v);
        document.getElementById('c' + i).value = '';
    }
    data.push(row);
    render();
    showStatus('Row added locally - remember to save to server!');
}

function delRow(i) {
    data.splice(i, 1);
    render();
    showStatus('Row deleted locally - remember to save to server!');
}

function downloadCSV() {
    let csv = data.map(r => r.map(c => `"${c}"`).join(',')).join('\n');
    let a = document.createElement('a');
    a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
    a.download = 'database.csv';
    a.click();
}

function loadCSV(e) {
    let f = e.target.files[0];
    if (!f) return;
    
    let r = new FileReader();
    r.onload = function(ev) {
        let lines = ev.target.result.split('\n').filter(l => l.trim());
        data = lines.map(l => l.split(',').map(c => c.replace(/^"|"$/g, '')));
        render();
        showStatus('CSV loaded locally - remember to save to server!');
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
            showStatus('Data saved to server successfully!');
        } else {
            showStatus('Error saving to server: ' + result.error, 'error');
        }
    } catch (error) {
        showStatus('Network error: ' + error.message, 'error');
    }
}

async function loadFromServer() {
    try {
        const response = await fetch('/.netlify/functions/get-csv');
        const result = await response.json();
        
        if (response.ok && result.data) {
            data = result.data;
            render();
            showStatus('Data loaded from server successfully!');
        } else {
            // Fallback to local storage or default data
            const saved = localStorage.getItem('csvData');
            if (saved) {
                data = JSON.parse(saved);
                render();
                showStatus('Loaded from local storage (server unavailable)');
            } else {
                showStatus('Using default data - server unavailable', 'error');
            }
        }
    } catch (error) {
        // Fallback to local storage
        const saved = localStorage.getItem('csvData');
        if (saved) {
            data = JSON.parse(saved);
            render();
            showStatus('Loaded from local storage (server error)');
        } else {
            showStatus('Server unavailable - using default data', 'error');
        }
    }
}

// Save to local storage as backup when changes are made
function autoSaveLocal() {
    localStorage.setItem('csvData', JSON.stringify(data));
}

// Initialize when page loads
document.addEventListener('DOMContentLoaded', init);
