// Callback handling utilities
const { isValidCallbackUrl } = require('./validation');
const { getShutdownState } = require('./memory');

/**
 * Send callback unconditionally (with retry logic and response validation)
 * @param {string} callbackUrl - URL to send callback to
 * @param {Object} payload - Callback payload
 * @param {number} maxRetries - Maximum retry attempts (default: 3)
 * @returns {Promise<void>}
 */
async function sendCallback(callbackUrl, payload, maxRetries = 3) {
    if (!callbackUrl) return;

    // SSRF Protection: Validate callback URL before making HTTP request
    // This provides defense-in-depth even though validation happens at endpoint level
    const callbackValidation = isValidCallbackUrl(callbackUrl);
    if (!callbackValidation.valid) {
        console.error(`SSRF protection: Blocked unsafe callback URL in sendCallback: ${callbackUrl} - ${callbackValidation.reason}`);
        throw new Error(`Invalid callback URL: ${callbackValidation.reason}`);
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`Sending callback (attempt ${attempt}/${maxRetries}): ${callbackUrl}`);
            // NOSONAR javascript:S5144 - SSRF: Callback URLs use whitelist validation via ALLOWED_ORIGINS.
            // Only trusted backend domains (configured in environment) are permitted for callbacks.
            // Defense-in-depth: validation at endpoint level + immediate pre-fetch validation above.
            const response = await fetch(callbackUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            // CRITICAL FIX: Validate response status
            if (!response.ok) {
                const errorText = await response.text().catch(() => 'Could not read response body');
                console.error(`Callback returned HTTP ${response.status} on attempt ${attempt}/${maxRetries}:`, errorText);

                if (attempt < maxRetries) {
                    // Adaptive retry delay: If we're about to restart (shutting down), use longer delay
                    // This gives the callback endpoint time to complete any in-flight operations
                    const baseBackoffMs = 1000 * Math.pow(2, attempt); // 2s, 4s, 8s
                    const backoffMs = getShutdownState() ? baseBackoffMs + 3000 : baseBackoffMs; // Add 3s during shutdown

                    console.log(`Retrying callback in ${backoffMs}ms${getShutdownState() ? ' (restart pending)' : ''}...`);
                    await new Promise(resolve => setTimeout(resolve, backoffMs));
                    continue; // Try again
                } else {
                    throw new Error(`Callback failed with HTTP ${response.status}: ${errorText}`);
                }
            }

            // Success!
            console.log(`✓ Callback successful (HTTP ${response.status})`);
            return;
        } catch (callbackError) {
            console.error(`Callback attempt ${attempt} failed:`, callbackError.message);
            if (attempt === maxRetries) {
                console.error(`❌ All ${maxRetries} callback attempts failed - callback lost`);
                throw callbackError; // Propagate error so scraping endpoint can handle it
            } else {
                // Wait before retry (exponential backoff)
                const baseBackoffMs = 1000 * Math.pow(2, attempt); // 2s, 4s, 8s
                const backoffMs = getShutdownState() ? baseBackoffMs + 3000 : baseBackoffMs; // Add 3s during shutdown

                console.log(`Retrying callback in ${backoffMs}ms${getShutdownState() ? ' (restart pending)' : ''}...`);
                await new Promise(resolve => setTimeout(resolve, backoffMs));
            }
        }
    }
}

module.exports = {
    sendCallback
};
