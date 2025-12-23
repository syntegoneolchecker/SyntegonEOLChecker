const logger = require('./logger');

// Memory management utilities
const MEMORY_LIMIT_MB = 450; // Restart threshold (leaves 62MB buffer before 512MB limit)
const MEMORY_WARNING_MB = 380; // Warning threshold (log detailed memory info)

// Memory usage tracking for analysis
const memoryHistory = [];

// Shutdown state flag
let isShuttingDown = false;

// Request counter
let requestCount = 0;

/**
 * Force garbage collection if available (start with --expose-gc flag)
 */
function forceGarbageCollection() {
    if (globalThis.gc) {
        const before = getMemoryUsageMB();
        globalThis.gc();
        const after = getMemoryUsageMB();
        logger.info(`GC: ${before.rss}MB → ${after.rss}MB (freed ${before.rss - after.rss}MB)`);
    }
}

/**
 * Get current memory usage in MB
 * @returns {Object} Memory usage object with rss, heapUsed, heapTotal, and external
 */
function getMemoryUsageMB() {
    const used = process.memoryUsage();
    return {
        rss: Math.round(used.rss / 1024 / 1024),
        heapUsed: Math.round(used.heapUsed / 1024 / 1024),
        heapTotal: Math.round(used.heapTotal / 1024 / 1024),
        external: Math.round(used.external / 1024 / 1024)
    };
}

/**
 * Track memory usage history
 * @param {string} stage - Description of the current stage
 * @returns {Object} Current memory usage
 */
function trackMemoryUsage(stage) {
    const memory = getMemoryUsageMB();
    const entry = {
        timestamp: new Date().toISOString(),
        stage,
        requestCount,
        ...memory
    };

    memoryHistory.push(entry);

    // Keep only last 20 entries to avoid memory bloat
    if (memoryHistory.length > 20) {
        memoryHistory.shift();
    }

    // Log warning if approaching limit
    if (memory.rss >= MEMORY_WARNING_MB) {
        logger.warn(`⚠️  Memory approaching limit: ${memory.rss}MB RSS (warning threshold: ${MEMORY_WARNING_MB}MB)`);
        logger.info(`Memory history (last 5): ${JSON.stringify(memoryHistory.slice(-5), null, 2)}`);
    }

    return memory;
}

/**
 * Check if we should restart based on memory usage
 * @returns {boolean} True if restart is needed
 */
function shouldRestartDueToMemory() {
    const memory = getMemoryUsageMB();

    if (memory.rss >= MEMORY_LIMIT_MB) {
        logger.error(`❌ Memory limit reached: ${memory.rss}MB >= ${MEMORY_LIMIT_MB}MB, scheduling restart`);
        logger.info(`Memory breakdown: Heap=${memory.heapUsed}/${memory.heapTotal}MB, External=${memory.external}MB`);
        logger.info(`Request count at restart: ${requestCount}`);
        return true;
    }

    return false;
}

/**
 * Schedule process restart if memory limit reached
 */
function scheduleRestartIfNeeded() {
    if (shouldRestartDueToMemory()) {
        logger.info(`\n${'='.repeat(60)}`);
        logger.info(`🔄 MEMORY LIMIT REACHED - RESTARTING`);
        logger.info(`Current memory: ${getMemoryUsageMB().rss}MB RSS`);
        logger.info(`Scheduling graceful restart in 2 seconds to free memory...`);
        logger.info(`${'='.repeat(60)}\n`);

        // Set shutdown flag to reject new requests
        isShuttingDown = true;

        // Give time for response to be sent, then exit
        // Render will automatically restart the service
        setTimeout(() => {
            logger.info('Exiting process for restart...');
            logger.info(`Total requests processed before restart: ${requestCount}`);
            process.exit(0);
        }, 2000);
    }
}

/**
 * Get current shutdown state
 * @returns {boolean} True if shutting down
 */
function getShutdownState() {
    return isShuttingDown;
}

/**
 * Set shutdown state
 * @param {boolean} state - New shutdown state
 */
function setShutdownState(state) {
    isShuttingDown = state;
}

/**
 * Increment and get request count
 * @returns {number} New request count
 */
function incrementRequestCount() {
    return ++requestCount;
}

/**
 * Get current request count
 * @returns {number} Current request count
 */
function getRequestCount() {
    return requestCount;
}

/**
 * Get memory history
 * @returns {Array} Memory history array
 */
function getMemoryHistory() {
    return memoryHistory;
}

module.exports = {
    MEMORY_LIMIT_MB,
    MEMORY_WARNING_MB,
    forceGarbageCollection,
    getMemoryUsageMB,
    trackMemoryUsage,
    shouldRestartDueToMemory,
    scheduleRestartIfNeeded,
    getShutdownState,
    setShutdownState,
    incrementRequestCount,
    getRequestCount,
    getMemoryHistory
};
