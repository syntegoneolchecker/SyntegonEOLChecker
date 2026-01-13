/**
 * Render Scraping Service Logger
 * Uses shared logger factory with Render-specific source identifier
 *
 * Set LOG_LEVEL environment variable to control output:
 * - DEBUG: All logs (verbose, for development)
 * - INFO: Important events (default, good for staging)
 * - WARN: Warnings and errors only (good for production)
 * - ERROR: Errors only (best for production)
 * - NONE: Silent (not recommended)
 *
 * Logs are sent to both console (for immediate debugging) and Supabase PostgreSQL
 * Set SUPABASE_URL and SUPABASE_API_KEY environment variables to enable central logging
 */

const { createLogger } = require('shared/logger-factory');

/**
 * Get the function source for Render service
 * Returns a static identifier for the scraping service
 */
function getFunctionSource() {
    return 'render/scraping-service';
}

// Create logger instance with Render-specific source identifier
const logger = createLogger(getFunctionSource);

module.exports = logger;
