exports.handler = async function(event, context) {
    // Only allow POST requests
    if (event.httpMethod !== 'POST') {
        return {
            statusCode: 405,
            body: JSON.stringify({ error: 'Method not allowed' })
        };
    }

    try {
        const { model, maker } = JSON.parse(event.body);

        if (!model || !maker) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Model and Maker are required' })
            };
        }

        console.log(`Starting EOL check for: ${maker} ${model}`);

        // Prepare the prompt for Groq Compound
        const prompt = `What is the end-of-life status of the ${model} by ${maker}?

RESPONSE FORMAT (JSON ONLY - NO OTHER TEXT):
{
    "status": "ACTIVE" | "DISCONTINUED" | "UNKNOWN",
    "explanation": "ONE brief sentence citing the most definitive source (Result #N: URL, key evidence)",
    "successor": {
        "status": "FOUND" | "UNKNOWN",
        "model": "model name or null",
        "explanation": "Brief explanation or 'Product is active, no successor needed'"
    }
}`;

        console.log('Calling Groq Compound API...');

        // Call Groq Compound API
        const groqResponse = await fetch(
            'https://api.groq.com/openai/v1/chat/completions',
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: 'groq/compound',
                    messages: [
                        {
                            role: 'user',
                            content: prompt
                        }
                    ],
                    temperature: 0,  // Deterministic - same input = same output
                    max_completion_tokens: 1024,
                    top_p: 1,
                    compound_custom: {
                        tools: {
                            enabled_tools: ['visit_website', 'web_search']
                        }
                    }
                })
            }
        );

        if (!groqResponse.ok) {
            const errorText = await groqResponse.text();
            console.error('Groq API error:', errorText);

            // Check for rate limiting
            if (groqResponse.status === 429) {
                return {
                    statusCode: 429,
                    body: JSON.stringify({
                        error: 'Rate limit exceeded. Please try again in a moment.',
                        rateLimited: true
                    })
                };
            }

            return {
                statusCode: 500,
                body: JSON.stringify({
                    error: `Groq API failed: ${groqResponse.status}`,
                    details: errorText
                })
            };
        }

        const groqData = await groqResponse.json();
        console.log('Groq response:', JSON.stringify(groqData));

        // Extract rate limit information from headers
        const rateLimitInfo = {
            // Tokens Per Minute
            remainingTokens: groqResponse.headers.get('x-ratelimit-remaining-tokens'),
            limitTokens: groqResponse.headers.get('x-ratelimit-limit-tokens'),
            // Requests Per Day
            remainingRequests: groqResponse.headers.get('x-ratelimit-remaining-requests'),
            limitRequests: groqResponse.headers.get('x-ratelimit-limit-requests')
        };

        console.log('Rate limit info:', rateLimitInfo);

        // Extract the generated text from OpenAI-compatible format
        let generatedText = '';
        if (groqData.choices && groqData.choices[0]?.message?.content) {
            generatedText = groqData.choices[0].message.content;
        } else {
            console.error('Unexpected Groq response format:', groqData);
            return {
                statusCode: 500,
                body: JSON.stringify({
                    error: 'Unexpected response format from LLM',
                    details: groqData
                })
            };
        }

        // Parse JSON from the response
        let analysisResult;
        try {
            // First try to parse the whole response
            analysisResult = JSON.parse(generatedText);
        } catch (e) {
            // If that fails, try to extract JSON using regex
            const jsonMatch = generatedText.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                try {
                    analysisResult = JSON.parse(jsonMatch[0]);
                } catch (e2) {
                    console.error('Failed to parse LLM response:', generatedText);
                    return {
                        statusCode: 500,
                        body: JSON.stringify({
                            error: 'Failed to parse LLM response as JSON',
                            llmResponse: generatedText
                        })
                    };
                }
            } else {
                console.error('No JSON found in LLM response:', generatedText);
                return {
                    statusCode: 500,
                    body: JSON.stringify({
                        error: 'No JSON found in LLM response',
                        llmResponse: generatedText
                    })
                };
            }
        }

        // Validate the response structure
        if (!analysisResult.status || !analysisResult.explanation || !analysisResult.successor) {
            console.error('Invalid analysis result structure:', analysisResult);
            return {
                statusCode: 500,
                body: JSON.stringify({
                    error: 'Invalid analysis result structure',
                    result: analysisResult
                })
            };
        }

        console.log('Analysis complete:', analysisResult);

        // Return the structured result
        return {
            statusCode: 200,
            body: JSON.stringify({
                status: analysisResult.status,
                explanation: analysisResult.explanation,
                successor: analysisResult.successor,
                rateLimits: rateLimitInfo
            })
        };

    } catch (error) {
        console.error('Error in check-eol function:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: 'Internal server error: ' + error.message,
                stack: error.stack
            })
        };
    }
};
