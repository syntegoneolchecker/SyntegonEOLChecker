// ============================================================================
// ROW MANAGEMENT (ADD/DELETE)
// ============================================================================

import { state } from './state.js';
import {
    showStatus, validateAndFormatSAPNumber, collectInputFields,
    clearInputFields, buildConfirmationMessage, findRowBySAPNumber
} from './utils.js';
import { render } from './table.js';
import { saveToServer } from './api.js';

/**
 * Add new entry
 */
async function addNewEntry(formattedID, row) {
    state.data.push(row);
    if (state.originalData) state.originalData.push(row);
    render();
    showStatus(`✓ New entry ${formattedID} added successfully`);
    await saveToServer();
    clearInputFields(1, 13);
}

/**
 * Replace existing entry
 */
async function replaceExistingEntry(existingIndex, formattedID, row) {
    state.data[existingIndex] = row;
    if (state.originalData) state.originalData[existingIndex] = row;
    render();
    showStatus(`✓ Entry ${formattedID} replaced successfully`);
    await saveToServer();
    clearInputFields(1, 13);
}

/**
 * Add a row to the table
 */
export async function addRow() {
    const idInput = document.getElementById('c1').value.trim();
    const formattedID = validateAndFormatSAPNumber(idInput);
    if (!formattedID) return;

    const row = [formattedID, ...collectInputFields(2, 13)];

    const existingIndex = findRowBySAPNumber(formattedID);

    if (existingIndex === -1) {
        await addNewEntry(formattedID, row);
    } else {
        const existingRow = state.data[existingIndex];
        const confirmMessage = buildConfirmationMessage(formattedID, existingRow);

        if (confirm(confirmMessage)) {
            await replaceExistingEntry(existingIndex, formattedID, row);
        } else {
            showStatus(`Entry replacement cancelled`, 'info');
        }
    }
}

/**
 * Delete a row from the table
 */
export async function delRow(i) {
    if (state.originalData) {
        const rowToDelete = state.data[i];
        const sapNumber = rowToDelete[0];

        const originalIndex = state.originalData.findIndex(row => row[0] === sapNumber);
        if (originalIndex !== -1) {
            state.originalData.splice(originalIndex, 1);
        }
    }

    state.data.splice(i, 1);
    render();
    await saveToServer();
}
