exports.handler = async function(event, context) {
    try {
        // Make a minimal API call to Groq just to get rate limit headers
        // Using smallest possible prompt to minimize token usage
        const response = await fetch(
            'https://api.groq.com/openai/v1/chat/completions',
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: 'openai/gpt-oss-120b',
                    messages: [
                        {
                            role: 'user',
                            content: 'Hi'
                        }
                    ],
                    temperature: 0,
                    max_completion_tokens: 1,  // Minimal token usage
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
            console.error('Groq usage check error:', errorText);
            return {
                statusCode: response.status,
                body: JSON.stringify({
                    error: `Groq API failed: ${response.status}`,
                    details: errorText
                })
            };
        }

        // Extract token rate limit information from headers
        // TPM = Tokens Per Minute, TPD = Tokens Per Day
        const remainingTokensMinute = response.headers.get('x-ratelimit-remaining-tokens');
        const limitTokensMinute = response.headers.get('x-ratelimit-limit-tokens');

        // Daily limits (check various possible header names)
        const remainingTokensDay = response.headers.get('x-ratelimit-remaining-tokens-day') ||
                                   response.headers.get('x-daily-ratelimit-remaining-tokens');
        const limitTokensDay = response.headers.get('x-ratelimit-limit-tokens-day') ||
                              response.headers.get('x-daily-ratelimit-limit-tokens');

        return {
            statusCode: 200,
            body: JSON.stringify({
                // Per-minute limits
                remainingTokens: remainingTokensMinute || '0',
                limitTokens: limitTokensMinute || '8000',
                // Per-day limits
                remainingTokensDay: remainingTokensDay || 'N/A',
                limitTokensDay: limitTokensDay || 'N/A'
            })
        };

    } catch (error) {
        console.error('Error in get-groq-usage function:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: 'Internal server error: ' + error.message,
                stack: error.stack
            })
        };
    }
};
