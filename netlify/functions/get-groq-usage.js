/**
 * Groq Usage Endpoint
 * Returns current token usage and rate limits
 */
const { groqUsageHandler } = require('./lib/usage-api-factory');

exports.handler = groqUsageHandler;
