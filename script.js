let data = [['Col1', 'Col2', 'Col3', 'Col4', 'Col5', 'Col6', 'Col7']];

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
}

function delRow(i) {
    data.splice(i, 1);
    render();
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
    };
    r.readAsText(f);
}

// Initial render
render();
