/**
 * Netlify Functions Logger
 * Uses shared logger factory with Netlify-specific function source detection
 *
 * Set LOG_LEVEL environment variable to control output:
 * - DEBUG: All logs (verbose, for development)
 * - INFO: Important events (default, good for staging)
 * - WARN: Warnings and errors only (good for production)
 * - ERROR: Errors only (best for production)
 * - NONE: Silent (not recommended)
 *
 * Logs are sent to both console (for immediate debugging) and Supabase PostgreSQL
 */

const { createLogger } = require('../../../shared/logger-factory');

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

// Create logger instance with Netlify-specific source detection
// Skip logging for view-logs and clear-logs to prevent recursion
const logger = createLogger(getFunctionName, ['view-logs', 'clear-logs']);

module.exports = logger;
