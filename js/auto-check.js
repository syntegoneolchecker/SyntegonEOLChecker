// ============================================================================
// AUTO-CHECK FUNCTIONALITY
// ============================================================================

import {
    isManualCheckRunning, _lastToggleTime, _toggleSyncGracePeriod,
    setLastToggleTime, setAutoCheckMonitoringInterval
} from './state.js';
import { showStatus, parseCreditsRemaining } from './utils.js';
import { updateCheckEOLButtons } from './table.js';
import { setControlsDisabledForAutoCheck, toggleDeleteButtons } from './ui.js';

/**
 * Load auto-check state and update UI
 */
export async function loadAutoCheckState() {
    try {
        const response = await fetch('/.netlify/functions/get-auto-check-state');

        if (!response.ok) {
            console.error('Failed to load auto-check state');
            return false;
        }

        const state = await response.json();
        console.log('Auto-check state loaded:', state);

        const toggle = document.getElementById('auto-check-toggle');
        if (toggle) {
            toggle.checked = state.enabled;
        }

        if (!isManualCheckRunning) {
            updateCheckEOLButtons(state.isRunning);
        }

        if (state.isRunning) {
            showStatus('Background EOL check is running, controls are disabled', 'info');
        }

        return state.isRunning;

    } catch (error) {
        console.error('Error loading auto-check state:', error);
        return false;
    }
}

/**
 * Toggle auto-check enabled/disabled
 */
export async function toggleAutoCheck() {
    const toggle = document.getElementById('auto-check-toggle');
    const enabled = toggle.checked;

    setLastToggleTime(Date.now());

    try {
        const response = await fetch('/.netlify/functions/set-auto-check-state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: enabled })
        });

        if (!response.ok) {
            throw new Error('Failed to update state');
        }

        const result = await response.json();
        console.log('Auto-check toggled:', result.data.state);

        showStatus(`Auto EOL Check ${enabled ? 'enabled' : 'disabled'}`, 'success');

    } catch (error) {
        console.error('Error toggling auto-check:', error);
        showStatus('Error updating auto-check state: ' + error.message, 'error');
        toggle.checked = !enabled;
        setLastToggleTime(0);
    }
}

/**
 * Set auto-check state
 */
export async function setAutoCheckState(stateUpdate) {
    const response = await fetch('/.netlify/functions/set-auto-check-state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(stateUpdate)
    });

    if (!response.ok) {
        throw new Error(`Failed to set state: ${response.statusText}`);
    }

    const newState = await response.json();
    setControlsDisabledForAutoCheck(newState.isRunning);

    return await newState;
}

/**
 * Manual trigger for testing
 */
export async function manualTriggerAutoCheck() {
    const button = document.getElementById('manual-trigger-btn');
    const originalText = button.textContent;

    try {
        button.textContent = 'Triggering...';
        button.disabled = true;

        showStatus('Resetting daily counter and triggering auto-check...', 'info');

        await setAutoCheckState({ dailyCounter: 0 });
        console.log('Daily counter reset to 0');

        showStatus('Counter reset. Triggering auto-check...', 'info');

        await setAutoCheckState({ isRunning: true });
        setControlsDisabledForAutoCheck(true);

        const siteUrl = globalThis.location.origin;
        const response = await fetch('/.netlify/functions/auto-eol-check-background', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                triggeredBy: 'manual',
                siteUrl: siteUrl
            })
        });

        if (response.status === 202) {
            showStatus('Auto-check triggered successfully! Counter reset to 0. Check console for progress.', 'success');
        } else {
            const data = await response.json();
            showStatus('Trigger response: ' + (data.message || data.body || 'Unknown'), 'info');
        }

    } catch (error) {
        console.error('Error triggering auto-check:', error);
        showStatus('Error triggering auto-check: ' + error.message, 'error');
    } finally {
        button.textContent = originalText;
    }
}

// ============================================================================
// AUTO-CHECK MONITORING
// ============================================================================

/**
 * Sync auto-check toggle with server state
 */
function syncAutoCheckToggle(serverEnabled) {
    const timeSinceToggle = Date.now() - _lastToggleTime;
    if (timeSinceToggle < _toggleSyncGracePeriod) {
        return;
    }

    const toggle = document.getElementById('auto-check-toggle');
    if (toggle && toggle.checked !== serverEnabled) {
        toggle.checked = serverEnabled;
    }
}

/**
 * Calculate minutes since last activity
 */
function calculateMinutesSinceActivity(lastActivityTime) {
    if (!lastActivityTime) return 999;

    const lastActivity = new Date(lastActivityTime);
    const now = new Date();
    return (now - lastActivity) / 1000 / 60;
}

/**
 * Detect and recover from stuck isRunning state
 */
async function detectAndRecoverStuckState(state) {
    if (!state.isRunning) return state;

    const minutesSinceActivity = calculateMinutesSinceActivity(state.lastActivityTime);

    if (minutesSinceActivity > 5) {
        console.warn(`Detected stuck isRunning state (no activity for ${minutesSinceActivity.toFixed(1)} min), resetting...`);

        await setAutoCheckState({ isRunning: false });

        state.isRunning = false;
        showStatus('Auto-check recovered from stuck state', 'info');
    }

    return state;
}

/**
 * Auto-disable auto-check if credits are too low
 */
async function autoDisableOnLowCredits(state) {
    if (!state.enabled) return;

    const creditsElement = document.getElementById('credits-remaining');
    if (!creditsElement) return;

    const remaining = parseCreditsRemaining(creditsElement.textContent);
    if (remaining === null || remaining > 50) return;

    console.log('Auto-disabling auto-check due to low searches:', remaining);

    await setAutoCheckState({ enabled: false });

    const toggle = document.getElementById('auto-check-toggle');
    if (toggle) toggle.checked = false;

    showStatus('Auto EOL Check disabled - SerpAPI searches too low (≤50)', 'info');
}

/**
 * Monitor auto-check state periodically
 */
export function startAutoCheckMonitoring() {
    setAutoCheckMonitoringInterval(setInterval(async () => {
        try {
            const response = await fetch('/.netlify/functions/get-auto-check-state');
            if (!response.ok) return;

            let state = await response.json();

            syncAutoCheckToggle(state.enabled);

            state = await detectAndRecoverStuckState(state);

            if (!isManualCheckRunning) {
                updateCheckEOLButtons(state.isRunning);
                setControlsDisabledForAutoCheck(state.isRunning);
            }

            await autoDisableOnLowCredits(state);

        } catch (error) {
            console.error('Auto-check monitoring error:', error);
        }
    }, 10000));
}
