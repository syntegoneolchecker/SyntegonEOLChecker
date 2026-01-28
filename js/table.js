// ============================================================================
// TABLE RENDERING AND SORTING
// ============================================================================

import {
    state, setData, setOriginalData
} from './state.js';

// ============================================================================
// TABLE RENDERING
// ============================================================================

/**
 * Render table header cell
 */
function renderTableHeader(columnContent, columnIndex, sortableColumns) {
    const isSortable = sortableColumns.includes(columnIndex);
    let sortIndicator = '';
    if (state.currentSort.column === columnIndex) {
        if (state.currentSort.direction === 'asc') {
            sortIndicator = ' ▲';
        } else if (state.currentSort.direction === 'desc') {
            sortIndicator = ' ▼';
        }
    }
    const clickHandler = isSortable ? ` onclick="sortTable(${columnIndex})" style="cursor: pointer; user-select: none;"` : '';
    return `<th${clickHandler}>${columnContent}${sortIndicator}</th>`;
}

/**
 * Render table data cell
 */
function renderTableCell(cellContent) {
    return `<td>${cellContent}</td>`;
}

/**
 * Render table action buttons
 */
function renderActionButtons(rowIndex) {
    const disabled = state.isManualCheckRunning ? 'disabled' : '';
    return `<td><button id="check-eol-button" class="check-eol" onclick="checkEOL(${rowIndex})" ${disabled}>Check EOL</button><button class="delete" onclick="delRow(${rowIndex})">Delete</button></td>`;
}

/**
 * Update Check EOL button states after rendering
 */
async function updateButtonStates() {
    try {
        const response = await fetch('/.netlify/functions/get-auto-check-state');
        const autoCheckState = response.ok ? await response.json() : null;

        const shouldDisable = state.isManualCheckRunning || (autoCheckState?.isRunning) || !state.initComplete;
        if (typeof updateCheckEOLButtons === 'function') {
            updateCheckEOLButtons(shouldDisable);
        }
    } catch (error) {
        console.warn('Failed to fetch auto-check state:', error);
        if (state.isManualCheckRunning) {
            updateCheckEOLButtons(true);
        }
    }
}

/**
 * Update Check EOL buttons
 */
export function updateCheckEOLButtons(isRunning) {
    const checkButtons = document.querySelectorAll('.check-eol');
    checkButtons.forEach(button => {
        button.disabled = isRunning;
    });
}

/**
 * Render the table
 */
export function render() {
    const sortableColumns = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

    const t = document.getElementById('table');
    t.innerHTML = state.data.map((r, i) =>
        `<tr id="row-${i}">${r.map((c, j) => {
            if (i === 0) {
                return renderTableHeader(c, j, sortableColumns);
            } else {
                return renderTableCell(c);
            }
        }).join('')}${i > 0 ? renderActionButtons(i) : '<th>Actions</th>'}</tr>`
    ).join('');

    updateButtonStates();
}

// ============================================================================
// SORTING FUNCTIONALITY
// ============================================================================

/**
 * Compare values for sorting
 */
function compareValues(aVal, bVal, columnIndex, direction) {
    if (columnIndex === 11) {
        const aDate = aVal ? new Date(aVal) : new Date(0);
        const bDate = bVal ? new Date(bVal) : new Date(0);
        return direction === 'asc' ? aDate - bDate : bDate - aDate;
    }

    const aLower = (aVal || '').toString().toLowerCase();
    const bLower = (bVal || '').toString().toLowerCase();
    return direction === 'asc' ? aLower.localeCompare(bLower) : bLower.localeCompare(aLower);
}

/**
 * Determine next sort state
 */
function getNextSortState(columnIndex) {
    if (state.currentSort.column === columnIndex) {
        if (state.currentSort.direction === null) {
            return 'asc';
        } else if (state.currentSort.direction === 'asc') {
            return 'desc';
        } else {
            return null;
        }
    } else {
        return 'asc';
    }
}

/**
 * Sort table by column
 */
export function sortTable(columnIndex) {
    if (state.originalData === null) {
        setOriginalData(structuredClone(state.data));
    }

    const nextDirection = getNextSortState(columnIndex);

    if (nextDirection === null) {
        state.currentSort.direction = null;
        state.currentSort.column = null;
        setData(structuredClone(state.originalData));
        render();
        return;
    }

    state.currentSort.column = columnIndex;
    state.currentSort.direction = nextDirection;

    const header = state.data[0];
    const rows = state.data.slice(1);

    rows.sort((a, b) => compareValues(a[columnIndex], b[columnIndex], columnIndex, state.currentSort.direction));

    setData([header, ...rows]);
    render();
}
