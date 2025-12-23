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
 */

const { getStore } = require('@netlify/blobs');

const LOG_LEVELS = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
    NONE: 4
};

// Get current log level from environment, default to INFO
const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? LOG_LEVELS.INFO;

// Detect the source context (function name)
let functionSource = 'netlify-unknown';
try {
    // Try to get the function name from AWS Lambda context or Netlify context
    if (process.env.AWS_LAMBDA_FUNCTION_NAME) {
        functionSource = `netlify/${process.env.AWS_LAMBDA_FUNCTION_NAME}`;
    }
} catch (e) {
    // Ignore errors
}

/**
 * Write log directly to Netlify Blobs
 * This is fire-and-forget to avoid blocking the main application
 */
async function sendToCentralLog(level, message, context) {
    // Skip logging for log-ingest and view-logs functions to prevent recursion
    if (functionSource.includes('log-ingest') || functionSource.includes('view-logs')) {
        return;
    }

    try {
        const store = getStore({
            name: 'logs',
            siteID: process.env.SITE_ID,
            token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_TOKEN
        });

        const logEntry = {
            timestamp: new Date().toISOString(),
            level,
            source: functionSource,
            message,
            context
        };

        // Create a key based on the date (YYYY-MM-DD format)
        const date = new Date(logEntry.timestamp);
        const dateKey = date.toISOString().split('T')[0];
        const logKey = `logs-${dateKey}.jsonl`;

        // Get existing logs for today (if any)
        let existingLogs = '';
        try {
            existingLogs = await store.get(logKey, { type: 'text' }) || '';
        } catch (err) {
            // File doesn't exist yet, that's OK
            existingLogs = '';
        }

        // Append the new log entry as a JSON line
        const logLine = JSON.stringify(logEntry) + '\n';
        const updatedLogs = existingLogs + logLine;

        // Store back to blob - fire and forget (don't await)
        store.set(logKey, updatedLogs).catch(() => {
            // Silently ignore errors in central logging to avoid cascading failures
        });
    } catch (error) {
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
    args.forEach((arg, index) => {
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
