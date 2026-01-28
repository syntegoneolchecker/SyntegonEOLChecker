// ============================================================================
// EXCEL IMPORT/EXPORT
// ============================================================================

import {
    state, setOriginalData, resetSortState
} from './state.js';
import { showStatus, formatID, findRowBySAPNumber } from './utils.js';
import { render } from './table.js';
import { saveToServer } from './api.js';

/**
 * Download database as Excel file
 */
export async function downloadExcel() {
    try {
        const response = await fetch('/.netlify/functions/get-csv');

        if (!response.ok) {
            throw new Error(`Server error: ${response.status}`);
        }

        const result = await response.json();

        if (result.data) {
            const wb = XLSX.utils.book_new();
            const ws = XLSX.utils.aoa_to_sheet(result.data);
            XLSX.utils.book_append_sheet(wb, ws, 'EOL Database');
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

/**
 * Validate Excel headers
 */
function validateExcelHeaders(headers) {
    const idIndex = headers.findIndex(h => {
        const headerText = h?.toString().toLowerCase().trim();
        return headerText === 'sap part number';
    });

    if (idIndex === -1) {
        console.error('SAP Part Number column not found. Headers:', headers);
        showStatus('Error: Excel file must contain "SAP Part Number" column. Found headers: ' + headers.join(', '), 'error');
        return null;
    }

    console.log('SAP Part Number column found at index:', idIndex);
    return idIndex;
}

/**
 * Build row from Excel data
 */
function buildRowFromExcel(importedRow, headers, idIndex) {
    const idInput = (importedRow[idIndex] || '').toString().trim();

    if (!idInput) {
        return { skip: true, reason: 'no SAP Number' };
    }

    const formattedID = formatID(idInput);
    if (!formattedID) {
        return { skip: true, reason: `invalid format: "${idInput}"` };
    }

    const newRow = [];
    const ourHeaders = state.data[0];

    for (const element of ourHeaders) {
        const headerName = element.toLowerCase().trim();

        if (headerName === 'sap part number') {
            newRow.push(formattedID);
        } else {
            const importColIndex = headers.findIndex(h => h?.toString().toLowerCase().trim() === headerName);

            if (importColIndex !== -1 && importedRow[importColIndex] !== undefined) {
                newRow.push(importedRow[importColIndex].toString());
            } else {
                newRow.push('');
            }
        }
    }

    return { skip: false, formattedID, newRow };
}

/**
 * Process single Excel row
 */
function processExcelRow(importedRow, headers, idIndex, stats) {
    const result = buildRowFromExcel(importedRow, headers, idIndex);

    if (result.skip) {
        stats.skippedEntries++;
        return;
    }

    const { formattedID, newRow } = result;
    const existingIndex = findRowBySAPNumber(formattedID);

    if (existingIndex === -1) {
        state.data.push(newRow);
        if (state.originalData) state.originalData.push(newRow);
        stats.newEntries++;
    } else {
        state.data[existingIndex] = newRow;
        if (state.originalData) state.originalData[existingIndex] = newRow;
        stats.updatedEntries++;
    }
}

/**
 * Show import summary
 */
function showImportSummary(stats) {
    let statusMsg = `✓ Imported: ${stats.newEntries} new entries, ${stats.updatedEntries} updated entries`;
    if (stats.skippedEntries > 0) {
        statusMsg += `, ${stats.skippedEntries} skipped (invalid/missing SAP Number)`;
    }
    console.log('Import completed:', stats);
    showStatus(statusMsg);
}

/**
 * Parse Excel file
 */
async function parseExcelFile(fileData) {
    const workbook = XLSX.read(fileData, { type: 'array' });
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const importedData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

    if (importedData.length === 0) {
        throw new Error('Excel file is empty');
    }

    return importedData;
}

/**
 * Process all Excel rows
 */
function processAllExcelRows(importedData, idIndex) {
    const stats = { newEntries: 0, updatedEntries: 0, skippedEntries: 0 };
    const headers = importedData[0];

    for (let i = 1; i < importedData.length; i++) {
        const importedRow = importedData[i];
        if (!importedRow || importedRow.length === 0) continue;
        processExcelRow(importedRow, headers, idIndex, stats);
    }

    return stats;
}

/**
 * Load Excel file
 */
export async function loadExcel(e) {
    const f = e.target.files[0];
    if (!f) return;

    try {
        const arrayBuffer = await f.arrayBuffer();
        const importedData = await parseExcelFile(arrayBuffer);

        const headers = importedData[0];
        console.log('Excel headers found:', headers);

        const idIndex = validateExcelHeaders(headers);
        if (idIndex === null) return;

        const stats = processAllExcelRows(importedData, idIndex);

        setOriginalData(null);
        resetSortState();

        render();
        await saveToServer();

        showImportSummary(stats);

    } catch (error) {
        console.error('Excel import failed:', error);
        showStatus('Error importing Excel file: ' + error.message, 'error');
    }
}
