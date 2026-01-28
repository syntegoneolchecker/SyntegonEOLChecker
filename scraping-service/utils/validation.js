// URL validation and SSRF protection utilities

/**
 * Validates that a URL is safe for scraping (blocks private IPs, localhost, etc.)
 * Allows any public website - needed for dynamic search results
 * @param {string} url - The URL to validate
 * @returns {{valid: boolean, reason?: string}} Validation result
 */
function isSafePublicUrl(url) {
    try {
        const parsedUrl = new URL(url);

        // SSRF Protection: Only allow HTTP/HTTPS protocols
        // Block file://, ftp://, data://, etc.
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
            return { valid: false, reason: 'Only HTTP/HTTPS protocols are allowed' };
        }

        const hostname = parsedUrl.hostname.toLowerCase();

        // SSRF Protection: Block localhost
        if (hostname === 'localhost' ||
            hostname === '127.0.0.1' ||
            hostname === '0.0.0.0' ||
            hostname === '::1' ||
            hostname === '[::1]') {
            return { valid: false, reason: 'Cannot scrape localhost addresses' };
        }

        // SSRF Protection: Block private IP ranges (RFC 1918)
        if (hostname.startsWith("10.") ||                              // 10.0.0.0/8
            /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||     // 172.16.0.0/12
            hostname.startsWith("192.168.")) {                        // 192.168.0.0/16
            return { valid: false, reason: 'Cannot scrape private IP addresses' };
        }

        // SSRF Protection: Block link-local addresses (AWS EC2 metadata, etc.)
        // This prevents attackers from accessing cloud provider metadata APIs
        if (hostname.startsWith("169.254.")) {                        // 169.254.0.0/16
            return { valid: false, reason: 'Cannot scrape link-local addresses (cloud metadata blocked)' };
        }

        // SSRF Protection: Block other reserved/special IP ranges
        if (hostname.startsWith("0.") ||                               // 0.0.0.0/8 (current network)
            /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./.test(hostname) || // 100.64.0.0/10 (CGNAT)
            hostname.startsWith("127.") ||                             // 127.0.0.0/8 (loopback)
            hostname.startsWith("224.") ||                             // 224.0.0.0/4 (multicast)
            hostname.startsWith("240.")) {                             // 240.0.0.0/4 (reserved)
            return { valid: false, reason: 'Cannot scrape reserved IP ranges' };
        }

        // SSRF Protection: Block IPv6 private/local addresses
        if (hostname.startsWith('fc') || hostname.startsWith('fd') || // Unique local (fc00::/7)
            hostname.startsWith('fe80:') ||                           // Link-local
            hostname.startsWith('[fc') || hostname.startsWith('[fd') ||
            hostname.startsWith('[fe80:')) {
            return { valid: false, reason: 'Cannot scrape private IPv6 addresses' };
        }

        // URL is safe for public scraping
        return { valid: true };
    } catch (error) {
        return { valid: false, reason: `Invalid URL format. Error: ${error}` };
    }
}

/**
 * Validates callback URLs (stricter than scraping URLs)
 * Only allows callbacks to YOUR backend domains
 * Reuses ALLOWED_ORIGINS environment variable (same domains as CORS)
 * @param {string} callbackUrl - The callback URL to validate
 * @returns {{valid: boolean, reason?: string}} Validation result
 */
function isValidCallbackUrl(callbackUrl) {
    if (!callbackUrl) return { valid: true }; // Optional parameter

    try {
        const parsedUrl = new URL(callbackUrl);

        // SSRF Protection: Only allow HTTP/HTTPS for callbacks
        if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
            return { valid: false, reason: 'Callback URL must use HTTP/HTTPS' };
        }

        // SSRF Protection: Reuse ALLOWED_ORIGINS for callback validation
        // These are the same domains that can call the scraping service (via CORS)
        // Default to localhost for local development
        const allowedOrigins = process.env.ALLOWED_ORIGINS
            ? process.env.ALLOWED_ORIGINS.split(',')
            : ['http://localhost:3000', 'http://localhost:5000', 'http://localhost:8888'];

        // Extract origin (hostname + port) from each allowed origin and check if callback URL matches
        const isAllowed = allowedOrigins.some(origin => {
            try {
                const allowedUrl = new URL(origin.trim());
                const allowedHostname = allowedUrl.hostname.toLowerCase();
                const allowedPort = allowedUrl.port;
                const callbackHostname = parsedUrl.hostname.toLowerCase();
                const callbackPort = parsedUrl.port;

                // For localhost: must match hostname AND port (if specified)
                if (allowedHostname === 'localhost' || allowedHostname === '127.0.0.1') {
                    // Compare full origin for localhost (including port)
                    const allowedOriginNormalized = `${allowedUrl.protocol}//${allowedHostname}${allowedPort ? ':' + allowedPort : ''}`;
                    const callbackOriginNormalized = `${parsedUrl.protocol}//${callbackHostname}${callbackPort ? ':' + callbackPort : ''}`;
                    return allowedOriginNormalized === callbackOriginNormalized;
                }

                // For public domains: match exact hostname or subdomain (port doesn't matter)
                return callbackHostname === allowedHostname ||
                       callbackHostname.endsWith('.' + allowedHostname);
            } catch {
                // If origin is not a valid URL, skip it
                return false;
            }
        });

        if (!isAllowed) {
            return { valid: false, reason: `Callback URL domain not in allowed list. Allowed origins: ${allowedOrigins.join(', ')}` };
        }

        return { valid: true };
    } catch (error) {
        return { valid: false, reason: `Invalid callback URL format. Error: ${error}` };
    }
}

module.exports = {
    isSafePublicUrl,
    isValidCallbackUrl
};
