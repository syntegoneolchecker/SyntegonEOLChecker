/**
 * Tavily Usage Endpoint (Legacy - kept for compatibility)
 * Returns current search usage and limits
 */
const { tavilyUsageHandler } = require('./lib/usage-api-factory');

exports.handler = tavilyUsageHandler;
