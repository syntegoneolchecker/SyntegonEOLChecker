// ============================================================================
// GLOBAL STATE MANAGEMENT
// ============================================================================

// All mutable state in a single const object
// Properties can be modified, but the object reference cannot be reassigned
export const state = {
    // Database state
    data: [['SAP Part Number', 'Legacy Part Number', 'Designation', 'Model', 'Manufacturer', 'Status', 'Status Comment', 'Successor Model', 'Successor Comment', 'Successor SAP Number', 'Stock', 'Information Date', 'Auto Check']],
    originalData: null,

    // Sorting state
    currentSort: {
        column: null,
        direction: null
    },

    // Manual Check EOL state
    isManualCheckRunning: false,

    // Countdown interval for Groq rate limit reset
    groqCountdownInterval: null,
    groqResetTimestamp: null,

    // Auto-check monitoring interval
    autoCheckMonitoringInterval: null,
    // Timestamp of last user toggle action
    lastToggleTime: 0,
    // Grace period in ms to skip syncs after user toggle
    toggleSyncGracePeriod: 15000,

    // Init completion flag
    initComplete: false,

    // User info
    currentUser: {}
};

// State setters (for modules that need to modify state)
export function setData(newData) {
    state.data = newData;
}

export function setOriginalData(newOriginalData) {
    state.originalData = newOriginalData;
}

export function setIsManualCheckRunning(value) {
    state.isManualCheckRunning = value;
}

export function setGroqCountdownInterval(interval) {
    state.groqCountdownInterval = interval;
}

export function setGroqResetTimestamp(timestamp) {
    state.groqResetTimestamp = timestamp;
}

export function setAutoCheckMonitoringInterval(interval) {
    state.autoCheckMonitoringInterval = interval;
}

export function setLastToggleTime(time) {
    state.lastToggleTime = time;
}

export function setInitComplete(value) {
    state.initComplete = value;
}

export function setCurrentUser(user) {
    state.currentUser = user;
}

// Reset sorting state
export function resetSortState() {
    state.currentSort.column = null;
    state.currentSort.direction = null;
}
