/**
 * Factory for creating usage API endpoint handlers
 * Consolidates common patterns across SerpAPI, Groq, and Tavily usage endpoints
 */
const logger = require('./logger');
const { successResponse, errorResponse } = require('./response-builder');

/**
 * Create a usage API handler for external API services
 * @param {Object} config - Configuration object
 * @param {string} config.serviceName - Name of the service (for logging)
 * @param {Function} config.fetchUsage - Async function that fetches usage data, receives apiKey as parameter
 * @param {Function} config.transformResponse - Function that transforms API response to standard format
 * @param {string} config.apiKeyEnvVar - Environment variable name for API key
 * @returns {Function} Netlify function handler
 */
function createUsageApiHandler({ serviceName, fetchUsage, transformResponse, apiKeyEnvVar }) {
    return async function(_event, _context) {
        try {
            const apiKey = process.env[apiKeyEnvVar];

            if (!apiKey) {
                logger.warn(`${serviceName} API key not configured`);
                return errorResponse(`${serviceName} API key not configured`, null, 503);
            }

            const response = await fetchUsage(apiKey);

            if (!response.ok) {
                const errorText = await response.text();
                logger.error(`${serviceName} API error:`, errorText);
                return {
                    statusCode: response.status,
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    },
                    body: JSON.stringify({
                        error: `${serviceName} API failed: ${response.status}`,
                        details: errorText
                    })
                };
            }

            const data = await response.json();
            const transformedData = transformResponse(data);

            return {
                statusCode: 200,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                },
                body: JSON.stringify(transformedData)
            };

        } catch (error) {
            logger.error(`Error in ${serviceName} usage function:`, error);
            return errorResponse(`Internal server error: ${error.message}`);
        }
    };
}

/**
 * Pre-configured handler for SerpAPI usage
 */
const serpApiUsageHandler = createUsageApiHandler({
    serviceName: 'SerpAPI',
    apiKeyEnvVar: 'SERPAPI_API_KEY',
    fetchUsage: (apiKey) => fetch(`https://serpapi.com/account.json?api_key=${apiKey}`, { method: 'GET' }),
    transformResponse: (data) => ({
        usage: (data.searches_per_month || 100) - (data.total_searches_left || 0),
        limit: data.searches_per_month || 100,
        remaining: data.total_searches_left || 0,
        plan: data.plan_name || 'Unknown'
    })
});

/**
 * Pre-configured handler for Tavily usage (legacy, kept for compatibility)
 */
const tavilyUsageHandler = createUsageApiHandler({
    serviceName: 'Tavily',
    apiKeyEnvVar: 'TAVILY_API_KEY',
    fetchUsage: (apiKey) => fetch('https://api.tavily.com/usage', {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${apiKey}` }
    }),
    transformResponse: (data) => ({
        usage: data.key?.usage || 0,
        limit: data.key?.limit || 1000,
        remaining: (data.key?.limit || 1000) - (data.key?.usage || 0),
        plan: data.account?.current_plan || 'Unknown'
    })
});

/**
 * Pre-configured handler for Groq usage
 * Note: Groq requires a minimal API call to get rate limit headers
 */
const groqUsageHandler = async function(_event, _context) {
    try {
        const apiKey = process.env.GROQ_API_KEY;

        if (!apiKey) {
            logger.warn('Groq API key not configured');
            return errorResponse('Groq API key not configured', null, 503);
        }

        // Make a minimal API call to get rate limit headers
        const response = await fetch(
            'https://api.groq.com/openai/v1/chat/completions',
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: 'openai/gpt-oss-120b',
                    messages: [{ role: 'user', content: 'Hi' }],
                    temperature: 0,
                    max_completion_tokens: 1,
                    top_p: 1,
                    stream: false,
                    reasoning_effort: 'low',
                    stop: null,
                    tools: []
                })
            }
        );

        if (!response.ok) {
            const errorText = await response.text();
            logger.error('Groq usage check error:', errorText);
            return {
                statusCode: response.status,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                },
                body: JSON.stringify({
                    error: `Groq API failed: ${response.status}`,
                    details: errorText
                })
            };
        }

        // Extract rate limit information from headers
        const remainingTokens = response.headers.get('x-ratelimit-remaining-tokens');
        const limitTokens = response.headers.get('x-ratelimit-limit-tokens');
        const resetTokens = response.headers.get('x-ratelimit-reset-tokens');

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
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*'
            },
            body: JSON.stringify({
                remainingTokens: remainingTokens || '0',
                limitTokens: limitTokens || '8000',
                resetSeconds: resetSeconds
            })
        };

    } catch (error) {
        logger.error('Error in Groq usage function:', error);
        return errorResponse(`Internal server error: ${error.message}`);
    }
};

module.exports = {
    createUsageApiHandler,
    serpApiUsageHandler,
    tavilyUsageHandler,
    groqUsageHandler
};
