/**
 * Groq Usage Endpoint
 * Returns current token usage and rate limits
 */
const { groqUsageHandler } = require("./lib/usage-api-factory");
const { requireHybridAuth } = require("./lib/auth-middleware");

// Protect with hybrid authentication (JWT or internal API key)
exports.handler = requireHybridAuth(groqUsageHandler);
