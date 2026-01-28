// ============================================================================
// AUTHENTICATION
// ============================================================================

import { setCurrentUser } from './state.js';
import { showStatus } from './utils.js';

// init function will be set by main.js to avoid circular dependency
let initFunction = null;

export function setInitFunction(fn) {
    initFunction = fn;
}

/**
 * Check authentication status and initialize app
 */
export async function checkAuthentication() {
    try {
        const response = await fetch('/.netlify/functions/auth-check');
        const authData = await response.json();

        if (authData.authenticated) {
            setCurrentUser(authData.user);
            globalThis.currentUser = authData.user;

            document.body.classList.remove('auth-loading');
            document.body.classList.add('auth-verified');

            try {
                if (initFunction) {
                    await initFunction();
                }
            } catch (initError) {
                console.error('Initialization error:', initError);
                showStatus('⚠️ Error loading data. Please refresh the page.', 'error', true);
            }
        } else {
            globalThis.location.href = '/auth.html';
        }
    } catch (error) {
        console.error('Authentication check failed:', error);
        globalThis.location.href = '/auth.html';
    }
}

/**
 * Logout helper
 */
export async function logout() {
    try {
        await fetch('/.netlify/functions/auth-logout', { method: 'POST' });
        localStorage.removeItem('auth_token');
        globalThis.location.href = '/auth.html';
    } catch (error) {
        console.error('Logout failed:', error);
        globalThis.location.href = '/auth.html';
    }
}
