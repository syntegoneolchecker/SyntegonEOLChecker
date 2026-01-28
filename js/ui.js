// ============================================================================
// UI UTILITIES
// ============================================================================

import {
    setData, setOriginalData, resetSortState
} from './state.js';
import { showStatus } from './utils.js';
import { render } from './table.js';

/**
 * Toggle delete buttons visibility
 */
export function toggleDeleteButtons() {
    const toggle = document.getElementById('delete-toggle');
    const clearDbButton = document.getElementById('clear-database-btn');

    if (toggle.checked) {
        document.body.classList.add('show-delete-buttons');
        clearDbButton.style.display = 'block';
    } else {
        document.body.classList.remove('show-delete-buttons');
        clearDbButton.style.display = 'none';
    }
}

/**
 * Clear entire database with confirmation
 */
export async function clearDatabase() {
    const confirmed = confirm(
        '⚠️ WARNING: Clear Entire Database?\n\n' +
        'This will permanently delete ALL entries from the database.\n' +
        'This action CANNOT be undone.\n\n' +
        'Are you sure you want to continue?'
    );

    if (!confirmed) {
        showStatus('Database clear cancelled', 'info');
        return;
    }

    try {
        showStatus('Clearing database...', 'info');

        const response = await fetch('/.netlify/functions/reset-database', {
            method: 'POST'
        });

        if (!response.ok) {
            throw new Error(`Failed to clear database: ${response.status}`);
        }

        const result = await response.json();
        console.log('Database cleared:', result);

        setData([['SAP Part Number', 'Legacy Part Number', 'Designation', 'Model', 'Manufacturer', 'Status', 'Status Comment', 'Successor Model', 'Successor Comment', 'Successor SAP Number', 'Stock', 'Information Date', 'Auto Check']]);

        setOriginalData(null);
        resetSortState();

        render();
        showStatus('✓ Database cleared successfully', 'success');

    } catch (error) {
        console.error('Clear database error:', error);
        showStatus('Error clearing database: ' + error.message, 'error');
    }
}

/**
 * Disable/enable all controls during init
 */
export function setControlsDisabled(disabled) {
    document.querySelectorAll('button, input[type="checkbox"]').forEach(el => {
        el.disabled = disabled;
    });
}

/**
 * Disable/enable controls based on auto-check running state
 */
export function setControlsDisabledForAutoCheck(disabled) {
    const toggle = document.getElementById('delete-toggle');
    if (toggle.checked) {
        toggle.checked = false;
        toggleDeleteButtons();
    }
    document.querySelectorAll('button, input[type="checkbox"]').forEach(el => {
        if (el.id === 'auto-check-toggle' || el.id === 'logout-button' || el.id === 'view-logs-button') return;
        el.disabled = disabled;
    });
}
