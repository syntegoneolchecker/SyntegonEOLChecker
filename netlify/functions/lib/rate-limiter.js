const { getStore } = require('@netlify/blobs');

/**
 * Rate Limiter using Netlify Blobs
 * Tracks request attempts per IP address with time windows
 */

const RATE_LIMIT_BLOB_KEY = 'rate-limits';

// Rate limit configurations
const RATE_LIMITS = {
    login: {
        maxAttempts: 5,
        windowMs: 15 * 60 * 1000  // 15 minutes
    },
    register: {
        maxAttempts: 3,
        windowMs: 60 * 60 * 1000  // 1 hour
    }
};

/**
 * Get configured Netlify Blobs store for rate limiting
 * @returns {Object} Netlify Blobs store instance
 */
function getRateLimitStore() {
    return getStore({
        name: 'auth-data',
        siteID: process.env.SITE_ID,
        token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_TOKEN
    });
}

/**
 * Get client IP from event
 * @param {Object} event - Netlify function event
 * @returns {string} Client IP address
 */
function getClientIP(event) {
    // Try various headers that might contain the real IP
    const ip = event.headers['x-forwarded-for']
        || event.headers['x-real-ip']
        || event.headers['client-ip']
        || 'unknown';

    // x-forwarded-for can be a comma-separated list, take the first one
    return ip.split(',')[0].trim();
}

/**
 * Check if rate limit is exceeded for a given endpoint and IP
 * @param {string} endpoint - Endpoint name (e.g., 'login', 'register')
 * @param {string} ip - Client IP address
 * @returns {Promise<Object>} { allowed: boolean, retryAfter?: number }
 */
async function checkRateLimit(endpoint, ip) {
    const config = RATE_LIMITS[endpoint];
    if (!config) {
        throw new Error(`Unknown rate limit endpoint: ${endpoint}`);
    }

    const store = getRateLimitStore();
    const rateLimits = await store.get(RATE_LIMIT_BLOB_KEY, { type: 'json' }) || {};

    const key = `${endpoint}:${ip}`;
    const now = Date.now();
    const record = rateLimits[key];

    // No previous attempts or window expired
    if (!record || now - record.firstAttempt > config.windowMs) {
        return { allowed: true };
    }

    // Check if limit exceeded
    if (record.count >= config.maxAttempts) {
        const timeRemaining = config.windowMs - (now - record.firstAttempt);
        const retryAfterSeconds = Math.ceil(timeRemaining / 1000);

        return {
            allowed: false,
            retryAfter: retryAfterSeconds,
            message: `Too many attempts. Please try again in ${Math.ceil(retryAfterSeconds / 60)} minute(s).`
        };
    }

    return { allowed: true };
}

/**
 * Record a rate limit attempt
 * @param {string} endpoint - Endpoint name
 * @param {string} ip - Client IP address
 * @returns {Promise<void>}
 */
async function recordAttempt(endpoint, ip) {
    const config = RATE_LIMITS[endpoint];
    if (!config) {
        throw new Error(`Unknown rate limit endpoint: ${endpoint}`);
    }

    const store = getRateLimitStore();
    const rateLimits = await store.get(RATE_LIMIT_BLOB_KEY, { type: 'json' }) || {};

    const key = `${endpoint}:${ip}`;
    const now = Date.now();
    const record = rateLimits[key];

    // Create new record or update existing
    if (!record || now - record.firstAttempt > config.windowMs) {
        rateLimits[key] = {
            count: 1,
            firstAttempt: now,
            lastAttempt: now
        };
    } else {
        rateLimits[key].count++;
        rateLimits[key].lastAttempt = now;
    }

    await store.setJSON(RATE_LIMIT_BLOB_KEY, rateLimits);
}

/**
 * Clear rate limit records for an IP (e.g., after successful login)
 * @param {string} endpoint - Endpoint name
 * @param {string} ip - Client IP address
 * @returns {Promise<void>}
 */
async function clearRateLimit(endpoint, ip) {
    const store = getRateLimitStore();
    const rateLimits = await store.get(RATE_LIMIT_BLOB_KEY, { type: 'json' }) || {};

    const key = `${endpoint}:${ip}`;
    delete rateLimits[key];

    await store.setJSON(RATE_LIMIT_BLOB_KEY, rateLimits);
}

/**
 * Cleanup expired rate limit records
 * @returns {Promise<number>} Number of records removed
 */
async function cleanupExpiredRecords() {
    const store = getRateLimitStore();
    const rateLimits = await store.get(RATE_LIMIT_BLOB_KEY, { type: 'json' }) || {};

    const now = Date.now();
    let removedCount = 0;

    for (const [key, record] of Object.entries(rateLimits)) {
        const [endpoint] = key.split(':');
        const config = RATE_LIMITS[endpoint];

        if (config && now - record.firstAttempt > config.windowMs) {
            delete rateLimits[key];
            removedCount++;
        }
    }

    if (removedCount > 0) {
        await store.setJSON(RATE_LIMIT_BLOB_KEY, rateLimits);
    }

    return removedCount;
}

module.exports = {
    checkRateLimit,
    recordAttempt,
    clearRateLimit,
    cleanupExpiredRecords,
    getClientIP
};
