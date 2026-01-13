/**
 * Shared logger factory
 * Creates a logger instance with centralized logging capabilities
 *
 * Both Netlify Functions and Render service use this factory,
 * each providing their own function source identifier
 */

const LOG_LEVELS = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
    NONE: 4
};

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

/**
 * Create a logger instance
 *
 * @param {Function} getFunctionSource - Function that returns the source identifier
 * @param {Array<string>} skipSources - Optional list of source identifiers to skip logging for (prevents recursion)
 * @returns {Object} Logger instance with debug, info, warn, error, and getLevel methods
 */
function createLogger(getFunctionSource, skipSources = []) {
    // Get current log level from environment, default to INFO
    const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL?.toUpperCase()] ?? LOG_LEVELS.INFO;

    /**
     * Send log to Supabase PostgreSQL
     * This is fire-and-forget to avoid blocking the main application
     * Uses Supabase REST API with publishable API key
     */
    async function sendToCentralLog(level, message, context) {
        try {
            // Get function source dynamically for each log
            const functionSource = getFunctionSource();

            // Skip logging for specified sources (prevents recursion)
            if (skipSources.some(skip => functionSource.includes(skip))) {
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

    return {
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
}

module.exports = {
    createLogger,
    LOG_LEVELS
};
