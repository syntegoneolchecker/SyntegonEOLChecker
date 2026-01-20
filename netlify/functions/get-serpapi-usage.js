/**
 * SerpAPI Usage Endpoint
 * Returns current search usage and limits
 */
const { serpApiUsageHandler } = require('./lib/usage-api-factory');

exports.handler = serpApiUsageHandler;
