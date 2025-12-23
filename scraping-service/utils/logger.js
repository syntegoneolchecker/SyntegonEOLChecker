/**
 * Centralized logging utility with log levels
 * Set LOG_LEVEL environment variable to control output:
 * - DEBUG: All logs (verbose, for development)
 * - INFO: Important events (default, good for staging)
 * - WARN: Warnings and errors only (good for production)
 * - ERROR: Errors only (best for production)
 * - NONE: Silent (not recommended)
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

const logger = {
    /**
     * Debug-level logging (most verbose)
     * Use for detailed diagnostic information
     */
    debug: (...args) => {
        if (currentLevel <= LOG_LEVELS.DEBUG) {
            console.log('[DEBUG]', ...args);
        }
    },

    /**
     * Info-level logging
     * Use for general informational messages about application flow
     */
    info: (...args) => {
        if (currentLevel <= LOG_LEVELS.INFO) {
            console.log('[INFO]', ...args);
        }
    },

    /**
     * Warning-level logging
     * Use for potentially harmful situations that aren't errors
     */
    warn: (...args) => {
        if (currentLevel <= LOG_LEVELS.WARN) {
            console.warn('[WARN]', ...args);
        }
    },

    /**
     * Error-level logging
     * Use for error events that might still allow the application to continue
     */
    error: (...args) => {
        if (currentLevel <= LOG_LEVELS.ERROR) {
            console.error('[ERROR]', ...args);
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
