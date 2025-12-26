/**
 * Centralized logging utility with log levels
 * Set LOG_LEVEL environment variable to control output:
 * - DEBUG: All logs (verbose, for development)
 * - INFO: Important events (default, good for staging)
 * - WARN: Warnings and errors only (good for production)
 * - ERROR: Errors only (best for production)
 * - NONE: Silent (not recommended)
 *
 * Logs are sent to both console (for immediate debugging) and central log storage
 * Set NETLIFY_SITE_URL environment variable to enable central logging
 */

const LOG_LEVELS = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
    NONE: 4
};

// Get current log level from environment, default to INFO
const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? LOG_LEVELS.INFO;

// Source identifier for Render service
const functionSource = 'render/scraping-service';

/**
 * Send log to central ingestion endpoint
 * This is fire-and-forget to avoid blocking the main application
 */
async function sendToCentralLog(level, message, context) {
    try {
        // Get the Netlify site URL from environment variable
        const siteUrl = process.env.NETLIFY_SITE_URL;
        if (!siteUrl) {
            // Central logging not configured, skip silently
            return;
        }

        const logEndpoint = `${siteUrl}/.netlify/functions/log-ingest`;

        const logEntry = {
            timestamp: new Date().toISOString(),
            level,
            source: functionSource,
            message,
            context
        };

        // Fire and forget - don't await to avoid blocking
        fetch(logEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(logEntry)
        }).catch(() => {
            // Silently ignore errors in central logging to avoid cascading failures
        });
    } catch {
        // Silently ignore errors in central logging
    }
}

/**
 * Format arguments for logging
 */
function formatMessage(...args) {
    return args.map(arg => {
        if (typeof arg === 'string') return arg;
        if (arg instanceof Error) return `${arg.name}: ${arg.message}\n${arg.stack}`;
        return JSON.stringify(arg);
    }).join(' ');
}

/**
 * Extract context object from arguments
 */
function extractContext(...args) {
    const contextObj = {};
    args.forEach((arg, _index) => {
        if (typeof arg === 'object' && arg !== null && !(arg instanceof Error)) {
            Object.assign(contextObj, arg);
        }
    });
    return Object.keys(contextObj).length > 0 ? contextObj : undefined;
}

const logger = {
    /**
     * Debug-level logging (most verbose)
     * Use for detailed diagnostic information
     */
    debug: (...args) => {
        if (currentLevel <= LOG_LEVELS.DEBUG) {
            console.log('[DEBUG]', ...args);
            const message = formatMessage(...args);
            const context = extractContext(...args);
            sendToCentralLog('DEBUG', message, context);
        }
    },

    /**
     * Info-level logging
     * Use for general informational messages about application flow
     */
    info: (...args) => {
        if (currentLevel <= LOG_LEVELS.INFO) {
            console.log('[INFO]', ...args);
            const message = formatMessage(...args);
            const context = extractContext(...args);
            sendToCentralLog('INFO', message, context);
        }
    },

    /**
     * Warning-level logging
     * Use for potentially harmful situations that aren't errors
     */
    warn: (...args) => {
        if (currentLevel <= LOG_LEVELS.WARN) {
            console.warn('[WARN]', ...args);
            const message = formatMessage(...args);
            const context = extractContext(...args);
            sendToCentralLog('WARN', message, context);
        }
    },

    /**
     * Error-level logging
     * Use for error events that might still allow the application to continue
     */
    error: (...args) => {
        if (currentLevel <= LOG_LEVELS.ERROR) {
            console.error('[ERROR]', ...args);
            const message = formatMessage(...args);
            const context = extractContext(...args);
            sendToCentralLog('ERROR', message, context);
        }
    },

    /**
     * Get current log level
     * @returns {string} Current log level name
     */
    getLevel: () => {
        return Object.keys(LOG_LEVELS).find(key => LOG_LEVELS[key] === currentLevel) || 'INFO';
    }
};

module.exports = logger;
