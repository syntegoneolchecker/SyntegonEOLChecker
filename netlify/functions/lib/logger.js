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

/**
 * Get the function name from the call stack
 * Extracts the actual function filename (e.g., 'initialize-job.js')
 */
function getFunctionName() {
    try {
        // Create error to get stack trace
        const err = new Error("Error for stack trace");
        const stack = err.stack || '';

        // Look for lines containing '/netlify/functions/'
        const lines = stack.split('\n');
        for (const line of lines) {
            const match = new RegExp(/\/netlify\/functions\/([^/\s:]+)\.js/).exec(line);
            if (match && match[1] !== 'logger' && match[1] !== 'view-logs' && match[1] !== 'log-ingest') {
                return `netlify/${match[1]}`;
            }
        }

        // Fallback: check AWS_LAMBDA_FUNCTION_NAME but clean it
        if (process.env.AWS_LAMBDA_FUNCTION_NAME) {
            const name = process.env.AWS_LAMBDA_FUNCTION_NAME;
            // If it's a hash (64 chars of hex), return unknown
            if (name.length === 64 && /^[a-f0-9]+$/.test(name)) {
                return 'netlify-unknown';
            }
            return `netlify/${name}`;
        }

        return 'netlify-unknown';
    } catch {
        return 'netlify-unknown';
    }
}

/**
 * Generate a random string for unique log IDs
 */
function generateRandomId(length = 8) {
    try {
        return Array.from(crypto.getRandomValues(new Uint8Array(length)))
            .map(b => b.toString(36))
            .join('')
            .replaceAll('.', '')
            .substring(0, length);
    } catch {
        // Fallback to Math.random() if crypto fails
        return Array.from({ length }, () =>
            Math.floor(Math.random() * 36).toString(36)
        ).join('');
    }
}

/**
 * Write log directly to Netlify Blobs
 * Each log entry gets its own blob to prevent race conditions
 * This is fire-and-forget to avoid blocking the main application
 */
async function sendToCentralLog(level, message, context) {
    try {
        // Get function name dynamically for each log
        const functionSource = getFunctionName();

        // Skip logging for log-ingest and view-logs functions to prevent recursion
        if (functionSource.includes('log-ingest') || functionSource.includes('view-logs')) {
            return;
        }

        const store = getStore({
            name: 'logs',
            siteID: process.env.SITE_ID,
            token: process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_TOKEN
        });

        const timestamp = new Date().toISOString();
        const logEntry = {
            timestamp,
            level,
            source: functionSource,
            message,
            context
        };

        // Create a unique key for this log entry to prevent race conditions
        // Format: logs-YYYY-MM-DD-timestamp-randomId.json
        const date = new Date(timestamp);
        const dateKey = date.toISOString().split('T')[0];
        const timestampMs = date.getTime();
        const randomId = generateRandomId(8);
        const logKey = `logs-${dateKey}-${timestampMs}-${randomId}.json`;

        // Store as individual blob - fire and forget (don't await)
        // No race condition possible because each log gets a unique blob
        store.setJSON(logKey, logEntry).catch(() => {
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
