/**
 * Groq Usage Endpoint
 * Returns current token usage and rate limits
 */
const logger = require("./lib/logger");
const { errorResponse, getCorsOrigin } = require("./lib/response-builder");
const { requireHybridAuth } = require("./lib/auth-middleware");

const groqUsageHandler = async function (_event, _context) {
	try {
		const apiKey = process.env.GROQ_API_KEY;

		if (!apiKey) {
			logger.warn("Groq API key not configured");
			return errorResponse("Groq API key not configured", null, 503);
		}

		// Make a minimal API call to get rate limit headers
		const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json"
			},
			body: JSON.stringify({
				model: "openai/gpt-oss-120b",
				messages: [{ role: "user", content: "Hi" }],
				temperature: 0,
				max_completion_tokens: 1,
				top_p: 1,
				stream: false,
				reasoning_effort: "low",
				stop: null,
				tools: []
			})
		});

		if (!response.ok) {
			const errorText = await response.text();
			logger.error("Groq usage check error:", errorText);
			return {
				statusCode: response.status,
				headers: {
					"Content-Type": "application/json",
					"Access-Control-Allow-Origin": getCorsOrigin()
				},
				body: JSON.stringify({
					error: `Groq API failed: ${response.status}`,
					details: errorText
				})
			};
		}

		// Extract rate limit information from headers
		const remainingTokens = response.headers.get("x-ratelimit-remaining-tokens");
		const limitTokens = response.headers.get("x-ratelimit-limit-tokens");
		const resetTokens = response.headers.get("x-ratelimit-reset-tokens");

		// Parse reset time (format: "7.66s" -> 7.66 seconds)
		let resetSeconds = null;
		if (resetTokens) {
			const match = new RegExp(/^([\d.]+)s?$/).exec(resetTokens);
			if (match) {
				resetSeconds = Number.parseFloat(match[1]);
			}
		}

		return {
			statusCode: 200,
			headers: {
				"Content-Type": "application/json",
				"Access-Control-Allow-Origin": getCorsOrigin()
			},
			body: JSON.stringify({
				remainingTokens: remainingTokens || "0",
				limitTokens: limitTokens || "8000",
				resetSeconds: resetSeconds
			})
		};
	} catch (error) {
		logger.error("Error in Groq usage function:", error);
		return errorResponse(`Internal server error: ${error.message}`);
	}
};

// Protect with hybrid authentication (JWT or internal API key)
exports.handler = requireHybridAuth(groqUsageHandler);
