// ============================================================================
// MAIN APPLICATION ENTRY POINT
// ============================================================================

import { setInitComplete } from './state.js';
import { loadFromServer } from './api.js';
import { render, sortTable } from './table.js';
import { loadSerpAPICredits, loadGroqUsage, checkRenderHealth } from './credits.js';
import { loadAutoCheckState, toggleAutoCheck, manualTriggerAutoCheck, startAutoCheckMonitoring } from './auto-check.js';
import { setControlsDisabled, setControlsDisabledForAutoCheck, toggleDeleteButtons, clearDatabase } from './ui.js';
import { addRow, delRow } from './row-management.js';
import { checkEOL } from './eol-check.js';
import { downloadExcel, loadExcel } from './excel.js';
import { manualSaveDatabase } from './api.js';
import { logout, checkAuthentication, setInitFunction } from './auth.js';

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize the app
 */
export async function init() {
    await loadFromServer();
    setControlsDisabled(true);
    let autoCheckRunning = false;
    try {
        await loadSerpAPICredits();
        await loadGroqUsage();
        await checkRenderHealth();
        autoCheckRunning = await loadAutoCheckState();
        startAutoCheckMonitoring();

        const deleteToggle = document.getElementById('delete-toggle');
        deleteToggle.checked = false;
        toggleDeleteButtons();
    } finally {
        setControlsDisabled(false);
        if (autoCheckRunning) {
            setControlsDisabledForAutoCheck(true);
        }
        setInitComplete(true);
    }
}

// ============================================================================
// EXPOSE FUNCTIONS TO GLOBAL SCOPE FOR HTML ONCLICK HANDLERS
// ============================================================================

globalThis.logout = logout;
globalThis.addRow = addRow;
globalThis.delRow = delRow;
globalThis.checkEOL = checkEOL;
globalThis.downloadExcel = downloadExcel;
globalThis.loadExcel = loadExcel;
globalThis.manualSaveDatabase = manualSaveDatabase;
globalThis.toggleDeleteButtons = toggleDeleteButtons;
globalThis.clearDatabase = clearDatabase;
globalThis.toggleAutoCheck = toggleAutoCheck;
globalThis.manualTriggerAutoCheck = manualTriggerAutoCheck;
globalThis.sortTable = sortTable;

// ============================================================================
// START APP
// ============================================================================

// Register init function with auth module (avoids circular dependency)
setInitFunction(init);

// Run authentication check on module load
checkAuthentication();
