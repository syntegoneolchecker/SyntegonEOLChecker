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

        // Extract rate limit information from headers
        // TPM = Tokens Per Minute
        const remainingTokens = response.headers.get('x-ratelimit-remaining-tokens');
        const limitTokens = response.headers.get('x-ratelimit-limit-tokens');
        const resetTokens = response.headers.get('x-ratelimit-reset-tokens');

        // Parse reset time (format: "7.66s" -> 7.66 seconds)
        let resetSeconds = null;
        if (resetTokens) {
            const match = resetTokens.match(/^([\d.]+)s?$/);
            if (match) {
                resetSeconds = parseFloat(match[1]);
            }
        }

        return {
            statusCode: 200,
            body: JSON.stringify({
                remainingTokens: remainingTokens || '0',
                limitTokens: limitTokens || '8000',
                resetSeconds: resetSeconds
            })
        };

    } catch (error) {
        console.error('Error in get-groq-usage function:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: 'Internal server error: ' + error.message
            })
        };
    }
};
