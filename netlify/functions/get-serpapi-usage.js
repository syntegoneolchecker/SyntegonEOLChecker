/**
 * SerpAPI Usage Endpoint
 * Returns current search usage and limits
 */
const logger = require("./lib/logger");
const { errorResponse, getCorsOrigin } = require("./lib/response-builder");
const { requireHybridAuth } = require("./lib/auth-middleware");

const serpApiUsageHandler = async function (_event, _context) {
	try {
		const apiKey = process.env.SERPAPI_API_KEY;

		if (!apiKey) {
			logger.warn("SerpAPI API key not configured");
			return errorResponse("SerpAPI API key not configured", null, 503);
		}

		const response = await fetch(`https://serpapi.com/account.json?api_key=${apiKey}`, {
			method: "GET"
		});

		if (!response.ok) {
			const errorText = await response.text();
			logger.error("SerpAPI API error:", errorText);
			return {
				statusCode: response.status,
				headers: {
					"Content-Type": "application/json",
					"Access-Control-Allow-Origin": getCorsOrigin()
				},
				body: JSON.stringify({
					error: `SerpAPI API failed: ${response.status}`,
					details: errorText
				})
			};
		}

		const data = await response.json();

		return {
			statusCode: 200,
			headers: {
				"Content-Type": "application/json",
				"Access-Control-Allow-Origin": getCorsOrigin()
			},
			body: JSON.stringify({
				usage: (data.searches_per_month || 100) - (data.total_searches_left || 0),
				limit: data.searches_per_month || 100,
				remaining: data.total_searches_left || 0,
				plan: data.plan_name || "Unknown"
			})
		};
	} catch (error) {
		logger.error("Error in SerpAPI usage function:", error);
		return errorResponse(`Internal server error: ${error.message}`);
	}
};

// Protect with hybrid authentication (JWT or internal API key)
exports.handler = requireHybridAuth(serpApiUsageHandler);
