// ============================================================================
// GLOBAL STATE MANAGEMENT
// ============================================================================

// Database state
export let data = [['SAP Part Number', 'Legacy Part Number', 'Designation', 'Model', 'Manufacturer', 'Status', 'Status Comment', 'Successor Model', 'Successor Comment', 'Successor SAP Number', 'Stock', 'Information Date', 'Auto Check']];

// Sorting state
export let originalData = null;
export const currentSort = {
    column: null,
    direction: null
};

// Manual Check EOL state
export let isManualCheckRunning = false;

// Countdown interval for Groq rate limit reset
export let groqCountdownInterval = null;
export let groqResetTimestamp = null;

// Auto-check monitoring interval
export let _autoCheckMonitoringInterval = null;
// Timestamp of last user toggle action
export let _lastToggleTime = 0;
// Grace period in ms to skip syncs after user toggle
export const _toggleSyncGracePeriod = 15000;

// Init completion flag
export let initComplete = false;

// User info
export let currentUser = {};

// State setters (for modules that need to modify state)
export function setData(newData) {
    data = newData;
}

export function setOriginalData(newOriginalData) {
    originalData = newOriginalData;
}

export function setIsManualCheckRunning(value) {
    isManualCheckRunning = value;
}

export function setGroqCountdownInterval(interval) {
    groqCountdownInterval = interval;
}

export function setGroqResetTimestamp(timestamp) {
    groqResetTimestamp = timestamp;
}

export function setAutoCheckMonitoringInterval(interval) {
    _autoCheckMonitoringInterval = interval;
}

export function setLastToggleTime(time) {
    _lastToggleTime = time;
}

export function setInitComplete(value) {
    initComplete = value;
}

export function setCurrentUser(user) {
    currentUser = user;
}

// Reset sorting state
export function resetSortState() {
    currentSort.column = null;
    currentSort.direction = null;
}
