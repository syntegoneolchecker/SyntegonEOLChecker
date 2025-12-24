/**
 * Configuration constants for EOL Checker application
 * Centralizes all magic numbers and limits for easier maintenance
 *
 * FREE TIER LIMITS (as of 2025):
 * - Netlify Functions: 30s timeout (regular), 15min timeout (background)
 * - Groq: 200,000 tokens/day, 8,000 tokens/minute (rolling window)
 * - Tavily: 1,000 tokens/month (2 tokens per search/EOL check)
 * - BrowserQL: 1,000 tokens/month (1 token = 30 seconds)
 * - Render: 512MB RAM, 750 hours/month
 * - Webshare Proxies: 1GB bandwidth/month
 */

module.exports = {
    // === JOB MANAGEMENT ===
    JOB_CLEANUP_DELAY_MINUTES: 1440,  // Delete completed jobs after 24 hours (1440 minutes)
    JOB_POLL_MAX_ATTEMPTS: 60,     // Max polling attempts (60 × 2s = 2 min)
    JOB_POLL_INTERVAL_MS: 2000,    // Poll interval between status checks

    // === GROQ LLM LIMITS ===
    GROQ_MIN_TOKENS_REQUIRED: 500,      // Min tokens needed before starting analysis
    GROQ_DAILY_TOKEN_LIMIT: 200000,     // Daily token limit (rolling 24h window)
    GROQ_MINUTE_TOKEN_LIMIT: 8000,      // Per-minute token limit (rolling window)
    GROQ_MAX_RETRIES: 3,                 // Max retries for rate limit errors

    // === CONTENT TRUNCATION ===
    MAX_CONTENT_LENGTH_PER_URL: 6500,   // Max characters per scraped URL
    MAX_TOTAL_CONTENT_LENGTH: 13000,    // Max total content (2 URLs × 6500)
    PRODUCT_MENTION_CONTEXT_CHARS: 250, // Characters around product mentions
    TABLE_CONTEXT_ROWS_BEFORE: 3,       // Rows to keep before product mention in tables
    TABLE_CONTEXT_ROWS_AFTER: 3,        // Rows to keep after product mention in tables

    // === TAVILY SEARCH ===
    TAVILY_MAX_RESULTS: 2,              // URLs per search (low to stay within groq token limits)
    TAVILY_SEARCH_DEPTH: 'advanced',    // Search depth level (this is why token cost is 2 per search)

    // === BROWSERQL / SCRAPING ===
    BROWSERQL_MONTHLY_TOKENS: 1000,     // BrowserQL token limit
    BROWSERQL_SECONDS_PER_TOKEN: 30,    // Seconds per BrowserQL token
    RENDER_MEMORY_LIMIT_MB: 450,        // Restart threshold (512MB limit - 62MB buffer)
    RENDER_MEMORY_WARNING_MB: 380,      // Warning threshold for memory logs
    SCRAPING_TIMEOUT_MS: 120000,        // 2 minutes max for scraping operations
    FAST_FETCH_TIMEOUT_MS: 5000,        // 5 seconds for simple HTTP fetches
    PDF_FETCH_TIMEOUT_MS: 20000,        // 20 seconds for PDF downloads
    MAX_PDF_SIZE_MB: 20,                // Max PDF size to process

    // === AUTO-CHECK LIMITS ===
    MAX_AUTO_CHECKS_PER_DAY: 20,        // Daily auto-check limit
    MIN_TAVILY_CREDITS_FOR_AUTO: 50,    // Min Tavily credits to enable auto-check
    AUTO_CHECK_SCHEDULE_CRON: '0 12 * * *', // Daily at 21:00 GMT+9 (12:00 UTC)

    // === RETRY LOGIC ===
    CALLBACK_MAX_RETRIES: 3,            // Max retries for scraping callbacks
    CALLBACK_RETRY_BASE_MS: 1000,       // Base delay for exponential backoff (2s, 4s, 8s)
    BLOBS_OPERATION_MAX_RETRIES: 5,     // Max retries for Netlify Blobs operations
    GIT_PUSH_MAX_RETRIES: 4,            // Max retries for git push (network errors)

    // === DATABASE SCHEMA ===
    CSV_COLUMN_COUNT: 13,               // Expected number of columns in CSV
    CSV_COLUMNS: {
        SAP_PART_NUMBER: 0,
        LEGACY_PART_NUMBER: 1,
        DESIGNATION: 2,
        MODEL: 3,
        MANUFACTURER: 4,
        STATUS: 5,
        STATUS_COMMENT: 6,
        SUCCESSOR_MODEL: 7,
        SUCCESSOR_COMMENT: 8,
        SUCCESSOR_SAP_NUMBER: 9,
        STOCK: 10,
        INFORMATION_DATE: 11,
        AUTO_CHECK: 12
    },

    // === VALIDATION ===
    MAX_MODEL_NAME_LENGTH: 200,         // Max length for model names
    MAX_MAKER_NAME_LENGTH: 200,         // Max length for manufacturer names
    SAP_NUMBER_DIGIT_COUNT: 10,         // Expected digits in SAP part number
    MAX_STRING_LENGTH: 1000,            // Generic max string length for sanitization

    // === NETWORK TIMEOUTS ===
    HEALTH_CHECK_TIMEOUT_MS: 5000,      // Timeout for health check requests
    NETLIFY_FUNCTION_TIMEOUT_MS: 30000, // Netlify function timeout (30s)
    NETLIFY_BACKGROUND_TIMEOUT_MS: 900000, // Background function timeout (15min)
    FIRE_AND_FORGET_TIMEOUT_MS: 10000,  // Timeout for fire-and-forget operations
    RENDER_SERVICE_CALL_TIMEOUT_MS: 15000, // Timeout for Render service calls (should respond with 202 within seconds)

    // === SERVICE URLs ===
    // Default URLs (can be overridden by environment variables)
    DEFAULT_SCRAPING_SERVICE_URL: 'https://eolscrapingservice.onrender.com',
    DEFAULT_BROWSERQL_API_URL: 'https://production-sfo.browserless.io/stealth/bql',

    // === FRONTEND POLLING ===
    FRONTEND_JOB_POLL_INTERVAL_MS: 2000,      // Frontend polls job status every 2s
    FRONTEND_AUTO_CHECK_MONITOR_MS: 10000,    // Frontend monitors auto-check every 10s

    // === AUTO-CHECK BACKGROUND ===
    AUTO_CHECK_RENDER_WAKE_MAX_MS: 120000,    // Max time to wait for Render wake (2 min)
    AUTO_CHECK_RENDER_WAKE_INTERVAL_MS: 30000, // Check Render health every 30s during wake

    // === FIRE-AND-FORGET RETRY ===
    FIRE_AND_FORGET_MAX_RETRIES: 2,           // Max retries for fire-and-forget operations
    FIRE_AND_FORGET_RETRY_DELAY_MS: 1000,     // Base delay for retries (1s, 2s, 3s)
};
