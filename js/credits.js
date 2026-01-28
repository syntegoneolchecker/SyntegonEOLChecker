// ============================================================================
// CREDITS AND USAGE MONITORING
// ============================================================================

import {
    state, setGroqCountdownInterval, setGroqResetTimestamp
} from './state.js';
import { showStatus } from './utils.js';

/**
 * Load SerpAPI credits
 */
export async function loadSerpAPICredits() {
    try {
        const response = await fetch('/.netlify/functions/get-serpapi-usage');

        if (!response.ok) {
            throw new Error(`Failed to fetch SerpAPI usage: ${response.status}`);
        }

        const result = await response.json();

        const creditsElement = document.getElementById('credits-remaining');
        const remaining = result.remaining;
        const limit = result.limit;

        creditsElement.textContent = `${remaining}/${limit} remaining`;

        creditsElement.classList.remove('credits-high', 'credits-medium', 'credits-low');

        const percentRemaining = (remaining / limit) * 100;

        if (percentRemaining > 50) {
            creditsElement.classList.add('credits-high');
        } else if (percentRemaining > 20) {
            creditsElement.classList.add('credits-medium');
        } else {
            creditsElement.classList.add('credits-low');
        }

    } catch (error) {
        console.error('Failed to load SerpAPI usage:', error);
        const creditsElement = document.getElementById('credits-remaining');
        creditsElement.textContent = 'Error loading usage';
        creditsElement.classList.remove('credits-high', 'credits-medium', 'credits-low');
    }
}

/**
 * Load Groq usage
 */
export async function loadGroqUsage() {
    try {
        const response = await fetch('/.netlify/functions/get-groq-usage');

        if (!response.ok) {
            throw new Error(`Failed to fetch Groq usage: ${response.status}`);
        }

        const result = await response.json();
        updateGroqRateLimits(result);

    } catch (error) {
        console.error('Failed to load Groq usage:', error);
        const groqElement = document.getElementById('groq-remaining');
        groqElement.textContent = 'Error loading';
        groqElement.classList.remove('credits-high', 'credits-medium', 'credits-low');
    }
}

/**
 * Update Groq rate limits display
 */
export function updateGroqRateLimits(rateLimits) {
    const groqElement = document.getElementById('groq-remaining');

    if (!rateLimits?.remainingTokens || !rateLimits.limitTokens) {
        groqElement.textContent = 'N/A';
    } else {
        const remaining = Number.parseInt(rateLimits.remainingTokens);
        const limit = Number.parseInt(rateLimits.limitTokens);

        const remainingFormatted = remaining.toLocaleString();
        const limitFormatted = limit.toLocaleString();

        groqElement.textContent = `${remainingFormatted}/${limitFormatted} TPM`;

        groqElement.classList.remove('credits-high', 'credits-medium', 'credits-low');

        const percentRemaining = (remaining / limit) * 100;

        if (percentRemaining > 50) {
            groqElement.classList.add('credits-high');
        } else if (percentRemaining > 20) {
            groqElement.classList.add('credits-medium');
        } else {
            groqElement.classList.add('credits-low');
        }
    }

    if (rateLimits?.resetSeconds !== null && rateLimits.resetSeconds !== undefined) {
        startGroqCountdown(rateLimits.resetSeconds);
    } else {
        const countdownElement = document.getElementById('groq-reset-countdown');
        countdownElement.textContent = 'N/A';
    }
}

/**
 * Start Groq countdown timer
 */
export function startGroqCountdown(resetSeconds) {
    if (state.groqCountdownInterval) {
        clearInterval(state.groqCountdownInterval);
    }

    setGroqResetTimestamp(Date.now() + (resetSeconds * 1000));
    updateCountdownDisplay();

    setGroqCountdownInterval(setInterval(() => {
        updateCountdownDisplay();
    }, 1000));
}

/**
 * Update countdown display
 */
function updateCountdownDisplay() {
    const countdownElement = document.getElementById('groq-reset-countdown');

    if (!state.groqResetTimestamp) {
        countdownElement.textContent = 'N/A';
        return;
    }

    const now = Date.now();
    const timeLeft = Math.max(0, state.groqResetTimestamp - now);

    if (timeLeft <= 0) {
        countdownElement.textContent = 'Refreshing...';
        if (state.groqCountdownInterval) {
            clearInterval(state.groqCountdownInterval);
            setGroqCountdownInterval(null);
        }
        loadGroqUsage();
        return;
    }

    const secondsLeft = (timeLeft / 1000).toFixed(1);
    countdownElement.textContent = `${secondsLeft}s`;
}

// ============================================================================
// RENDER SERVICE HEALTH CHECK
// ============================================================================

/**
 * Attempt a single health check
 */
async function attemptHealthCheck(renderServiceUrl, timeoutMs) {
    const startTime = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(`${renderServiceUrl}/health`, {
            signal: controller.signal
        });

        clearTimeout(timeout);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

        if (response.ok) {
            const data = await response.json();
            return { success: true, elapsed, data };
        } else {
            return { success: false, error: `HTTP ${response.status}`, elapsed };
        }
    } catch (error) {
        clearTimeout(timeout);
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        return {
            success: false,
            error: error.name === 'AbortError' ? 'Timeout' : error.message,
            elapsed
        };
    }
}

/**
 * Update render status UI
 */
function updateRenderStatus(element, elapsed, data) {
    if (elapsed > 10) {
        element.textContent = `Ready (cold start: ${elapsed}s)`;
        element.classList.add('credits-medium');
    } else {
        element.textContent = `Ready (${elapsed}s)`;
        element.classList.add('credits-high');
    }
    console.log(`Render health check: OK in ${elapsed}s`, data);
}

/**
 * Check Render scraping service health
 */
export async function checkRenderHealth() {
    showStatus('Waiting for response from Render health check...');
    const renderStatusElement = document.getElementById('render-status');
    const renderServiceUrl = 'https://eolscrapingservice.onrender.com';

    try {
        renderStatusElement.textContent = 'Checking...';
        renderStatusElement.classList.remove('credits-high', 'credits-medium', 'credits-low');

        const overallStartTime = Date.now();

        console.log('Render health check: Attempt 1/2...');
        const firstAttempt = await attemptHealthCheck(renderServiceUrl, 60000);

        if (firstAttempt.success) {
            updateRenderStatus(renderStatusElement, firstAttempt.elapsed, firstAttempt.data);
            showStatus('Render health check returned healthy.');
            return;
        }

        console.warn(`Render health check: Attempt 1 failed after ${firstAttempt.elapsed}s (${firstAttempt.error})`);

        renderStatusElement.textContent = 'Waking service, retrying...';
        renderStatusElement.classList.add('credits-medium');

        console.log('Render health check: Waiting 30s before retry...');
        await new Promise(resolve => setTimeout(resolve, 30000));

        console.log('Render health check: Attempt 2/2...');
        renderStatusElement.textContent = 'Retrying...';
        const secondAttempt = await attemptHealthCheck(renderServiceUrl, 60000);

        const totalElapsed = ((Date.now() - overallStartTime) / 1000).toFixed(1);

        if (secondAttempt.success) {
            console.log(`Render health check: OK after retry (total: ${totalElapsed}s)`);
            renderStatusElement.textContent = `Ready after retry (${totalElapsed}s total)`;
            renderStatusElement.classList.remove('credits-medium');
            renderStatusElement.classList.add('credits-medium');
            showStatus('Render health check returned healthy.');
            return;
        }

        showStatus('Render health check returned no response, please reload the page.', 'error');
        console.error(`Render health check: Failed after 2 attempts (total: ${totalElapsed}s)`);
        renderStatusElement.textContent = `Offline after ${totalElapsed}s (${secondAttempt.error})`;
        renderStatusElement.classList.remove('credits-medium');
        renderStatusElement.classList.add('credits-low');

    } catch (error) {
        console.error('Render health check error:', error);
        renderStatusElement.textContent = `Error: ${error.message}`;
        renderStatusElement.classList.add('credits-low');
    }
}
