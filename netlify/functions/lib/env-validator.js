const logger = require('./logger');

/**
 * Environment variable validation for Netlify functions
 * Each function should validate its required environment variables
 */

/**
 * Validate common environment variables required by multiple functions
 * @throws {Error} If any required variable is missing
 */
function validateCommonEnvVars() {
    const required = [
        'SITE_ID',
        'SERPAPI_API_KEY',
        'GROQ_API_KEY'
    ];

    const missing = required.filter(varName => !process.env[varName]);

    if (missing.length > 0) {
        const errorMsg = `Missing required environment variables: ${missing.join(', ')}`;
        logger.error('❌', errorMsg);
        throw new Error(errorMsg);
    }
}

/**
 * Validate BrowserQL API key (optional, used for Cloudflare-protected sites)
 * @returns {boolean} True if available
 */
function validateBrowserQLKey() {
    if (!process.env.BROWSERQL_API_KEY) {
        logger.warn('⚠️  BROWSERQL_API_KEY not set - Cloudflare-protected sites may fail');
        return false;
    }
    return true;
}

/**
 * Validate scraping service URL
 * @throws {Error} If URL is missing or invalid
 */
function validateScrapingServiceUrl() {
    const url = process.env.SCRAPING_SERVICE_URL;

    if (!url) {
        throw new Error('SCRAPING_SERVICE_URL environment variable is required');
    }

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        throw new Error(`Invalid SCRAPING_SERVICE_URL format: ${url}`);
    }

    return true;
}

/**
 * Validate Netlify Blobs token
 * @throws {Error} If token is missing
 */
function validateBlobsToken() {
    const token = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_TOKEN;

    if (!token) {
        throw new Error('NETLIFY_BLOBS_TOKEN or NETLIFY_TOKEN environment variable is required');
    }

    return true;
}

/**
 * Comprehensive validation for all environment variables
 * Use this in critical functions that need multiple env vars
 */
function validateAllEnvVars() {
    const errors = [];
    const warnings = [];

    try {
        validateCommonEnvVars();
    } catch (error) {
        errors.push(error.message);
    }

    try {
        validateBlobsToken();
    } catch (error) {
        errors.push(error.message);
    }

    try {
        validateScrapingServiceUrl();
    } catch (error) {
        warnings.push(error.message + ' (will use default)');
    }

    if (!validateBrowserQLKey()) {
        warnings.push('BrowserQL not configured - some manufacturers may fail');
    }

    if (warnings.length > 0) {
        logger.warn('⚠️  Environment warnings:');
        warnings.forEach(w => logger.warn(`   ${w}`));
    }

    if (errors.length > 0) {
        logger.error('❌ Environment validation failed:');
        errors.forEach(e => logger.error(`   ${e}`));
        throw new Error('Missing required environment variables');
    }

    logger.info('✓ Environment variables validated');
}

module.exports = {
    validateCommonEnvVars,
    validateBrowserQLKey,
    validateScrapingServiceUrl,
    validateBlobsToken,
    validateAllEnvVars
};
