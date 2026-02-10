/**
 * SerpAPI Usage Endpoint
 * Returns current search usage and limits
 */
const { serpApiUsageHandler } = require("./lib/usage-api-factory");
const { requireHybridAuth } = require("./lib/auth-middleware");

// Protect with hybrid authentication (JWT or internal API key)
exports.handler = requireHybridAuth(serpApiUsageHandler);
