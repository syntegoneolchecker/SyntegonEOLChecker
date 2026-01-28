// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

import { data, originalData } from './state.js';

/**
 * Show status message in the UI
 */
export function showStatus(message, type = 'success', _permanent = true) {
    const status = document.getElementById('status');
    status.textContent = message;
    status.className = type;
}

/**
 * Format SAP Number to X-XXX-XXX-XXX format (10 digits)
 */
export function formatID(input) {
    const digits = input.replaceAll(/\D/g, '');

    if (digits.length !== 10) {
        return null;
    }

    return `${digits.slice(0, 1)}-${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7, 10)}`;
}

/**
 * Find row by SAP Part Number
 */
export function findRowBySAPNumber(sapNumber) {
    for (let i = 1; i < data.length; i++) {
        if (data[i][0] === sapNumber) {
            return i;
        }
    }
    return -1;
}

/**
 * Update row in originalData by SAP Part Number
 */
export function updateRowInOriginalData(row) {
    if (!originalData) return;

    const sapNumber = row[0];
    const originalIndex = originalData.findIndex(r => r[0] === sapNumber);
    if (originalIndex !== -1) {
        originalData[originalIndex] = [...row];
    }
}

/**
 * Check if Render service is healthy based on status text
 */
export function isRenderServiceHealthy() {
    const renderStatusElement = document.getElementById('render-status');
    const renderStatusText = renderStatusElement.textContent;
    return !renderStatusText.includes('Timeout') &&
           !renderStatusText.includes('Offline') &&
           !renderStatusText.includes('Error');
}

/**
 * Parse credits remaining from text
 */
export function parseCreditsRemaining(creditsText) {
    const match = new RegExp(/(\d{1,6})\/\d{1,6} remaining/).exec(creditsText);
    return match ? Number.parseInt(match[1]) : null;
}

/**
 * Delay helper for async operations
 */
export function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Validate and format SAP Part Number
 */
export function validateAndFormatSAPNumber(idInput) {
    if (!idInput) {
        showStatus('Error: SAP Part Number is required', 'error');
        return null;
    }

    const formattedID = formatID(idInput);
    if (!formattedID) {
        showStatus('Error: SAP Part Number must be exactly 10 digits (e.g., 8-114-463-187 or 8114463187)', 'error');
        return null;
    }

    return formattedID;
}

/**
 * Collect all input field values
 */
export function collectInputFields(startIndex, endIndex) {
    const fields = [];
    for (let i = startIndex; i <= endIndex; i++) {
        const value = document.getElementById('c' + i).value;
        fields.push(value);
    }
    return fields;
}

/**
 * Clear all input fields
 */
export function clearInputFields(startIndex, endIndex) {
    for (let i = startIndex; i <= endIndex; i++) {
        document.getElementById('c' + i).value = '';
    }
}

/**
 * Build confirmation message for replacing entry
 */
export function buildConfirmationMessage(formattedID, existingRow) {
    return `An entry with SAP Part Number ${formattedID} already exists:\n\n` +
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
}
