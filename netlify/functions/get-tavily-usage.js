const logger = require('./lib/logger');

exports.handler = async function(_event, _context) {
    try {
        // Call Tavily usage endpoint
        const response = await fetch('https://api.tavily.com/usage', {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${process.env.TAVILY_API_KEY}`
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            logger.error('Tavily usage API error:', errorText);
            return {
                statusCode: response.status,
                body: JSON.stringify({
                    error: `Tavily usage API failed: ${response.status}`,
                    details: errorText
                })
            };
        }

        const usageData = await response.json();

        // Extract the relevant data
        // Expected format:
        // {
        //   "key": { "usage": 150, "limit": 1000 },
        //   "account": { "current_plan": "Bootstrap", ... }
        // }

        return {
            statusCode: 200,
            body: JSON.stringify({
                usage: usageData.key?.usage || 0,
                limit: usageData.key?.limit || 1000,
                remaining: (usageData.key?.limit || 1000) - (usageData.key?.usage || 0),
                plan: usageData.account?.current_plan || 'Unknown'
            })
        };

    } catch (error) {
        logger.error('Error in get-tavily-usage function:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: 'Internal server error: ' + error.message
            })
        };
    }
};
