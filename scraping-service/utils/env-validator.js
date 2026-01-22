const logger = require('./logger');

/**
 * Environment variable validation for scraping service
 * Validates required environment variables at startup to fail fast
 */

/**
 * Validate required environment variables
 * @throws {Error} If any required variable is missing
 */
function validateEnvironmentVariables() {
    const requiredVars = [
        'SCRAPING_API_KEY' // Required for API authentication
    ];

    const optionalVars = [
        'PORT', // Defaults to 3000 if not set
        'ALLOWED_ORIGINS', // Defaults to localhost if not set
        'NODE_ENV', // Development vs production
        'NETLIFY_SITE_URL' // Required for centralized logging to Netlify
    ];

    const errors = [];
    const warnings = [];

    // Check required variables
    for (const varName of requiredVars) {
        if (!process.env[varName]) {
            errors.push(`Missing required environment variable: ${varName}`);
        }
    }

    // Warn about optional variables
    for (const varName of optionalVars) {
        if (!process.env[varName]) {
            warnings.push(`Optional environment variable not set: ${varName}`);
        }
    }

    // Log results
    if (warnings.length > 0) {
        logger.warn('⚠️  Environment variable warnings:');
        warnings.forEach(warning => logger.warn(`  - ${warning}`));
    }

    if (errors.length > 0) {
        logger.error('❌ Environment variable validation failed:');
        errors.forEach(error => logger.error(`  - ${error}`));
        throw new Error('Missing required environment variables');
    }

    logger.info('✓ Environment variables validated successfully');
}

/**
 * Validate ALLOWED_ORIGINS format
 * @returns {boolean} True if valid or not set
 */
function validateAllowedOrigins() {
    const origins = process.env.ALLOWED_ORIGINS;

    if (!origins) {
        logger.warn('⚠️  ALLOWED_ORIGINS not set, using default localhost origins');
        return true;
    }

    const originList = origins.split(',');
    const urlPattern = /^https?:\/\/.+/;

    for (const origin of originList) {
        if (!urlPattern.test(origin.trim())) {
            logger.error(`❌ Invalid origin format: "${origin.trim()}"`);
            logger.error('   Origins must start with http:// or https://');
            return false;
        }
    }

    logger.info(`✓ ALLOWED_ORIGINS validated: ${originList.length} origin(s) configured`);
    return true;
}

module.exports = {
    validateEnvironmentVariables,
    validateAllowedOrigins
};
