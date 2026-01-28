/**
 * Configuration constants for EOL Checker application
 * Centralizes all magic numbers and limits that are USED in code
 *
 * Note: Free tier limit documentation is in ARCHITECTURE.md
 */

module.exports = {
    // === JOB MANAGEMENT ===
    JOB_CLEANUP_DELAY_MINUTES: 1440,  // Delete completed jobs after 24 hours (1440 minutes)

    // === LOG MANAGEMENT ===
    LOG_RETENTION_DAYS: 1,         // Delete logs older than 1 day

    // === CONTENT TRUNCATION ===
    MAX_CONTENT_LENGTH_PER_URL: 6500,   // Max characters per scraped URL
    MAX_TOTAL_CONTENT_LENGTH: 13000,    // Max total content (2 URLs × 6500)
    PRODUCT_MENTION_CONTEXT_CHARS: 250, // Characters around product mentions
    TABLE_CONTEXT_ROWS_BEFORE: 3,       // Rows to keep before product mention in tables
    TABLE_CONTEXT_ROWS_AFTER: 3,        // Rows to keep after product mention in tables

    // === SERPAPI SEARCH ===
    SERPAPI_MAX_RESULTS: 10,            // Search results to fetch from SerpAPI (organic_results limit)
    SERPAPI_ENGINE: 'google',           // Search engine to use with SerpAPI
    SERPAPI_GOOGLE_DOMAIN: 'google.com', // Google domain for searches
    // Site list loaded from external JSON file for maintainability
    // See serpapi-sites.json for the full list
    SERPAPI_SITES_TO_SEARCH: require('./serpapi-sites.json'),

    // === BROWSERQL / SCRAPING ===
    BROWSERQL_MONTHLY_TOKENS: 1000,     // BrowserQL token limit
    BROWSERQL_SECONDS_PER_TOKEN: 30,    // Seconds per BrowserQL token
    RENDER_MEMORY_LIMIT_MB: 450,        // Restart threshold (512MB limit - 62MB buffer)
    RENDER_MEMORY_WARNING_MB: 380,      // Warning threshold for memory logs
    SCRAPING_TIMEOUT_MS: 120000,        // 2 minutes max for scraping operations
    FAST_FETCH_TIMEOUT_MS: 5000,        // 5 seconds for simple HTTP fetches
    PDF_FETCH_TIMEOUT_MS: 20000,        // 20 seconds for PDF downloads
    MAX_PDF_SIZE_MB: 20,                // Max PDF size to process

    // === PDF SCREENING ===
    PDF_SCREENING_MIN_CHARS: 100,       // Minimum extractable characters to accept PDF
    PDF_SCREENING_TIMEOUT_MS: 5000,     // Timeout for PDF screening check
    PDF_SCREENING_MAX_SIZE_MB: 10,      // Max PDF size to screen (smaller than scraping limit)
    PDF_SCREENING_MAX_PAGES: 3,         // Only check first N pages during screening

    // === AUTO-CHECK LIMITS ===
    MAX_AUTO_CHECKS_PER_DAY: 20,        // Daily auto-check limit (reduced for SerpAPI)
    MIN_SERPAPI_CREDITS_FOR_AUTO: 30,   // Min SerpAPI credits to enable auto-check
    AUTO_CHECK_SCHEDULE_CRON: '0 12 * * *', // Daily at 21:00 GMT+9 (12:00 UTC)

    // === RETRY LOGIC ===
    CALLBACK_MAX_RETRIES: 3,            // Max retries for scraping callbacks
    CALLBACK_RETRY_BASE_MS: 1000,       // Base delay for exponential backoff (2s, 4s, 8s)

    // === DATABASE SCHEMA ===
    CSV_COLUMN_COUNT: 13,               // Expected number of columns in CSV

    // === NETWORK TIMEOUTS ===
    FIRE_AND_FORGET_TIMEOUT_MS: 10000,  // Timeout for fire-and-forget operations

    // === SERVICE URLs ===
    // Default URLs (can be overridden by environment variables)
    DEFAULT_SCRAPING_SERVICE_URL: 'https://eolscrapingservice.onrender.com',
    DEFAULT_BROWSERQL_API_URL: 'https://production-sfo.browserless.io/stealth/bql',
    DEFAULT_NETLIFY_SITE_URL: 'https://syntegoneolchecker.netlify.app',
    DEVELOP_NETLIFY_SITE_URL: 'https://develop--syntegoneolchecker.netlify.app',

    // === FIRE-AND-FORGET RETRY ===
    FIRE_AND_FORGET_MAX_RETRIES: 2,           // Max retries for fire-and-forget operations
    FIRE_AND_FORGET_RETRY_DELAY_MS: 1000,     // Base delay for retries (1s, 2s, 3s)
};
