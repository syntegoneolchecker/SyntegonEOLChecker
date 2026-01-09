/**
 * Centralized logging utility with log levels
 * Set LOG_LEVEL environment variable to control output:
 * - DEBUG: All logs (verbose, for development)
 * - INFO: Important events (default, good for staging)
 * - WARN: Warnings and errors only (good for production)
 * - ERROR: Errors only (best for production)
 * - NONE: Silent (not recommended)
 *
 * Logs are sent to both console (for immediate debugging) and Supabase PostgreSQL
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
 * Send log to Supabase PostgreSQL
 * This is fire-and-forget to avoid blocking the main application
 * Uses Supabase REST API with publishable API key
 */
async function sendToCentralLog(level, message, context) {
    try {
        // Get function name dynamically for each log
        const functionSource = getFunctionName();

        // Skip logging for view-logs function to prevent recursion
        if (functionSource.includes('view-logs') || functionSource.includes('clear-logs')) {
            return;
        }

        // Check if Supabase is configured
        if (!process.env.SUPABASE_URL || !process.env.SUPABASE_API_KEY) {
            // Silently skip if not configured (allows graceful degradation)
            return;
        }

        const timestamp = new Date().toISOString();
        const logEntry = {
            timestamp,
            level,
            source: functionSource,
            message,
            context: context || null
        };

        // Send to Supabase via REST API - fire and forget (don't await)
        fetch(`${process.env.SUPABASE_URL}/rest/v1/logs`, {
            method: 'POST',
            headers: {
                'apikey': process.env.SUPABASE_API_KEY,
                'Authorization': `Bearer ${process.env.SUPABASE_API_KEY}`,
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal' // Don't return inserted data (faster)
            },
            body: JSON.stringify(logEntry),
            signal: AbortSignal.timeout(5000) // 5 second timeout
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
