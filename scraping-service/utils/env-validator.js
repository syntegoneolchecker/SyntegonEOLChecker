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
        'PORT' // Not strictly required (defaults to 3000), but good to document
    ];

    const optionalVars = [
        'ALLOWED_ORIGINS', // Defaults to localhost if not set
        'NODE_ENV' // Development vs production
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
        console.warn('⚠️  Environment variable warnings:');
        warnings.forEach(warning => console.warn(`  - ${warning}`));
    }

    if (errors.length > 0) {
        console.error('❌ Environment variable validation failed:');
        errors.forEach(error => console.error(`  - ${error}`));
        throw new Error('Missing required environment variables');
    }

    console.log('✓ Environment variables validated successfully');
}

/**
 * Validate ALLOWED_ORIGINS format
 * @returns {boolean} True if valid or not set
 */
function validateAllowedOrigins() {
    const origins = process.env.ALLOWED_ORIGINS;

    if (!origins) {
        console.warn('⚠️  ALLOWED_ORIGINS not set, using default localhost origins');
        return true;
    }

    const originList = origins.split(',');
    const urlPattern = /^https?:\/\/.+/;

    for (const origin of originList) {
        if (!urlPattern.test(origin.trim())) {
            console.error(`❌ Invalid origin format: "${origin.trim()}"`);
            console.error('   Origins must start with http:// or https://');
            return false;
        }
    }

    console.log(`✓ ALLOWED_ORIGINS validated: ${originList.length} origin(s) configured`);
    return true;
}

module.exports = {
    validateEnvironmentVariables,
    validateAllowedOrigins
};
