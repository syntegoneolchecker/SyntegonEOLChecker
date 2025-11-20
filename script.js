let data = [['Model', 'Maker', 'EOL Status', 'EOL Comment', 'Successor Status', 'Successor Name', 'Successor Comment']];

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
    r.onload = async function(ev) {
        let lines = ev.target.result.split('\n').filter(l => l.trim());
        data = lines.map(l => l.split(',').map(c => c.replace(/^"|"$/g, '')));
        render();
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
        const response = await fetch('/.netlify/functions/get-csv');
        const result = await response.json();
        
        if (response.ok && result.data) {
            data = result.data;
            render();
            showStatus('Database loaded from database.csv successfully!');
        } else {
            showStatus('Error loading database.csv - using default headers', 'error');
            render();
        }
    } catch (error) {
        showStatus('Error loading database.csv: ' + error.message, 'error');
        render();
    }
}

// Initialize when page loads
document.addEventListener('DOMContentLoaded', init);
