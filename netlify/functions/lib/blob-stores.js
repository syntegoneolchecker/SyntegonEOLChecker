/**
 * Centralized Blob Store Factory
 * Provides consistent store configuration across the codebase
 */

const { getStore } = require('@netlify/blobs');

// Store names (centralized for consistency)
const STORE_NAMES = {
    CSV_DATABASE: 'eol-database',
    JOBS: 'eol-jobs',
    AUTH: 'auth-data',
    AUTO_CHECK: 'auto-check-state',
    LOGS: 'log-storage'
};

// Default consistency level (strong for data integrity)
const DEFAULT_CONSISTENCY = 'strong';

/**
 * Create a blob store with consistent configuration
 * @param {string} storeName - Name of the store
 * @param {string} consistency - Consistency level ('strong' or 'eventual')
 * @returns {Object} Configured blob store
 */
function createStore(storeName, consistency = DEFAULT_CONSISTENCY) {
    return getStore({
        name: storeName,
        consistency
    });
}

/**
 * Get the CSV database store
 * @returns {Object} CSV database blob store
 */
function getCsvStore() {
    return createStore(STORE_NAMES.CSV_DATABASE);
}

/**
 * Get the jobs store
 * @returns {Object} Jobs blob store
 */
function getJobsStore() {
    return createStore(STORE_NAMES.JOBS);
}

/**
 * Get the auth data store
 * @returns {Object} Auth data blob store
 */
function getAuthStore() {
    return createStore(STORE_NAMES.AUTH);
}

/**
 * Get the auto-check state store
 * @returns {Object} Auto-check state blob store
 */
function getAutoCheckStore() {
    return createStore(STORE_NAMES.AUTO_CHECK);
}

/**
 * Get the log storage store
 * @returns {Object} Log storage blob store
 */
function getLogStore() {
    return createStore(STORE_NAMES.LOGS);
}

module.exports = {
    STORE_NAMES,
    createStore,
    getCsvStore,
    getJobsStore,
    getAuthStore,
    getAutoCheckStore,
    getLogStore
};
