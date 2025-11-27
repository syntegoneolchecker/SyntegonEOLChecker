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
                    model: 'groq/compound-mini',
                    messages: [
                        {
                            role: 'user',
                            content: 'Hi'
                        }
                    ],
                    max_completion_tokens: 1  // Minimal token usage
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

        // Extract rate limit information from headers
        // TPM = Tokens Per Minute, RPD = Requests Per Day
        const remainingTokens = response.headers.get('x-ratelimit-remaining-tokens');
        const limitTokens = response.headers.get('x-ratelimit-limit-tokens');
        const remainingRequests = response.headers.get('x-ratelimit-remaining-requests');
        const limitRequests = response.headers.get('x-ratelimit-limit-requests');

        return {
            statusCode: 200,
            body: JSON.stringify({
                remainingTokens: remainingTokens || '0',
                limitTokens: limitTokens || '70000',
                remainingRequests: remainingRequests || '0',
                limitRequests: limitRequests || '250'
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
