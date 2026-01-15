const logger = require('./lib/logger');

exports.handler = async function(_event, _context) {
    try {
        // Call SerpAPI account endpoint to get usage information
        const response = await fetch(`https://serpapi.com/account.json?api_key=${process.env.SERPAPI_API_KEY}`, {
            method: 'GET'
        });

        if (!response.ok) {
            const errorText = await response.text();
            logger.error('SerpAPI account API error:', errorText);
            return {
                statusCode: response.status,
                body: JSON.stringify({
                    error: `SerpAPI account API failed: ${response.status}`,
                    details: errorText
                })
            };
        }

        const accountData = await response.json();

        // Extract the relevant data
        // Expected format:
        // {
        //   "account_id": "...",
        //   "api_key": "...",
        //   "plan_id": "...",
        //   "plan_name": "Free",
        //   "searches_per_month": 100,
        //   "total_searches_left": 85,
        //   ...
        // }

        const usage = (accountData.searches_per_month || 100) - (accountData.total_searches_left || 0);
        const limit = accountData.searches_per_month || 100;
        const remaining = accountData.total_searches_left || 0;

        return {
            statusCode: 200,
            body: JSON.stringify({
                usage: usage,
                limit: limit,
                remaining: remaining,
                plan: accountData.plan_name || 'Unknown'
            })
        };

    } catch (error) {
        logger.error('Error in get-serpapi-usage function:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: 'Internal server error: ' + error.message
            })
        };
    }
};
