/**
 * Configuration constants for EOL Checker application
 * Centralizes all magic numbers and limits that are USED in code
 *
 * Note: Free tier limit documentation is in ARCHITECTURE.md
 */

module.exports = {
    // === JOB MANAGEMENT ===
    JOB_CLEANUP_DELAY_MINUTES: 1440,  // Delete completed jobs after 24 hours (1440 minutes)

    // === CONTENT TRUNCATION ===
    // Scraped URL content is truncated before being sent to the LLM to fit within token limits.
    // If the LLM returns "prompt too large", truncation level increases and content is re-processed.
    //
    // PROGRESSIVE TRUNCATION LEVELS:
    //   Level 0: maxContentLength = BASE_CONTENT_LENGTH (6000 chars/URL)
    //   Level 1: maxContentLength = BASE - REDUCTION (4500 chars/URL)
    //   Level 2: maxContentLength = BASE - 2*REDUCTION (3000 chars/URL)
    //   Formula: max(MIN_CONTENT_LENGTH, BASE - level * REDUCTION)
    //
    // TOTAL LIMIT: maxTotalChars = maxContentLength * MULTIPLIER + BUFFER
    //   Level 0: 6000 * 2 + 1000 = 13000 chars across all URLs
    //
    // DYNAMIC URL BUDGET: Per-URL limit adjusts based on actual URL count to include all URLs:
    //   - 1 URL:  (13000-1000)/1 = 12000 chars (more budget since no other URLs)
    //   - 2 URLs: (13000-1000)/2 = 6000 chars (standard)
    //   - 10 URLs: (13000-1000)/10 = 1200 chars -> clamped to MIN_CONTENT_LENGTH (1500)
    //   If total still exceeds limit, progressive truncation handles it (no URLs omitted)
    //
    BASE_CONTENT_LENGTH: 6000,            // Max chars per URL at truncation level 0
    TRUNCATION_REDUCTION_PER_LEVEL: 1500, // Chars subtracted per level (level 1 = -1500, level 2 = -3000)
    MIN_CONTENT_LENGTH: 1500,             // Floor value - truncation levels can't go below this
    TOTAL_CONTENT_MULTIPLIER: 2,          // URLs combined (maxContentLength * 2)
    TOTAL_CONTENT_BUFFER: 1000,           // Extra chars for headers/formatting in combined output

    // TABLE HANDLING:
    // Tables are detected by lines with 2+ pipe characters and wrapped with === TABLE START/END ===
    // Tables not containing the product name are removed, EXCEPT adjacent tables (may have related info)
    //
    TABLE_CONTEXT_ROWS_BEFORE: 3,       // When truncating tables, keep N rows before product mention
    TABLE_CONTEXT_ROWS_AFTER: 3,        // When truncating tables, keep N rows after product mention
    ADJACENT_TABLE_THRESHOLD: 200,      // Tables within N chars of a product-containing table are kept
    TABLE_FILTERING_THRESHOLD_RATIO: 1.0, // Only filter tables when content > maxContentLength * ratio

    // ZONE EXTRACTION (last resort truncation):
    // Keeps only content near product mentions and EOL-related keywords (e.g., "discontinued", "生産終了")
    // Everything between zones is replaced with [...] separators
    //
    ZONE_RADIUS_MIN: 400,               // Minimum chars to keep around each important position
    ZONE_RADIUS_MAX: 2000,              // Maximum chars to keep (adaptive based on available space)
    KEYWORD_MAX_OCCURRENCES: 3,         // Track max N occurrences of each EOL keyword
    KEYWORD_MAX_TOTAL: 20,              // Track max N keyword positions total (prevents keyword spam)

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
    // The cron expression must be present in the scheduled function to avoid build errors on Netlify
    //AUTO_CHECK_SCHEDULE_CRON: '0 12 * * *', // Daily at 21:00 GMT+9 (12:00 UTC)

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
