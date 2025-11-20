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

        // Step 1: Search with Tavily API
        console.log('Step 1: Searching with Tavily...');
        const searchQuery = `${maker} ${model} discontinued OR 販売終了 OR 終息製品`;

        const tavilyResponse = await fetch('https://api.tavily.com/search', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                api_key: process.env.TAVILY_API_KEY,
                query: searchQuery,
                search_depth: 'advanced',
                max_results: 5,
                include_raw_content: false
            })
        });

        if (!tavilyResponse.ok) {
            const errorText = await tavilyResponse.text();
            console.error('Tavily API error:', errorText);
            return {
                statusCode: 500,
                body: JSON.stringify({
                    error: `Tavily API failed: ${tavilyResponse.status}`,
                    details: errorText
                })
            };
        }

        const tavilyData = await tavilyResponse.json();
        console.log(`Tavily returned ${tavilyData.results?.length || 0} results`);

        if (!tavilyData.results || tavilyData.results.length === 0) {
            return {
                statusCode: 200,
                body: JSON.stringify({
                    status: 'UNKNOWN',
                    explanation: 'No search results found',
                    successor: {
                        status: 'UNKNOWN',
                        model: null,
                        explanation: 'No information available'
                    }
                })
            };
        }

        // Use all top results (no score filtering - let LLM decide)
        const relevantResults = tavilyData.results;
        console.log(`Sending ${relevantResults.length} results to LLM for analysis`);

        // Step 2: Prepare search context for LLM
        const searchContext = relevantResults
            .map((result, index) => {
                return `Result #${index + 1} (Relevance: ${(result.score * 100).toFixed(0)}%)
URL: ${result.url}
Title: ${result.title}
Content: ${result.content}`;
            })
            .join('\n\n---\n\n');

        // Step 3: Analyze with Groq LLM
        console.log('Step 2: Analyzing with Groq...');

        const prompt = `TASK: Determine if the product "${model}" by ${maker} is discontinued (end-of-life).

SEARCH RESULTS (ranked by relevance):
${searchContext}

ANALYSIS RULES:

1. EXACT PRODUCT IDENTIFICATION
   - You are analyzing "${model}" ONLY
   - Product variants with ANY character difference (suffixes, prefixes, version numbers) are DIFFERENT products
   - Example: "Q38B" ≠ "Q38B-E" ≠ "QA1S38B"
   - Only use information explicitly about "${model}"

2. EVIDENCE OF ACTIVE STATUS (product is NOT discontinued if):
   - Currently sold on manufacturer's official website or authorized retailers
   - Available for purchase (not auction/secondhand sites)
   - Appears as a replacement/successor for other products
   - Has recent documentation, pricing, or specifications listed

3. EVIDENCE OF DISCONTINUED STATUS (ONLY mark discontinued with concrete proof):
   - Explicitly listed in official discontinuation/EOL tables or announcements
   - Clear statement: "discontinued", "end of life", "end of sales", "production ended"
   - Must be from reputable source (manufacturer, official distributor)
   - Auction sites or secondhand listings are NOT evidence
   - Make sure that the discontinuation is specifically mentioned for "${model}"

4. SUCCESSOR IDENTIFICATION
   - If discontinued: Search all content for explicit successor mentions
     ("replaced by X", "successor: X", "recommended replacement: X")
   - If active: No successor needed
   - Only report if explicitly stated for this exact product

5. USE COMMON SENSE
   - Prioritize official manufacturer information
   - Higher-ranked search results are more relevant
   - When uncertain, lean toward UNKNOWN rather than guessing
   - Active sales = strong evidence of ACTIVE status
   - The information is provided in the form of scraped websites. Websites have links, footers, headers etc. Because of this circumstance, not all content is relevant to the task!
   - The term "discontinued" appearing somewhere on the page alone is not proof of discontinuation, it must be connected to "${model}" or relate to it specifically

RESPONSE FORMAT (JSON ONLY - NO OTHER TEXT):
{
    "status": "ACTIVE" | "DISCONTINUED" | "UNKNOWN",
    "explanation": "ONE brief sentence citing the most definitive source (Result #N: URL, key evidence)",
    "successor": {
        "status": "FOUND" | "UNKNOWN",
        "model": "model name or null",
        "explanation": "Brief explanation or 'Product is active, no successor needed'"
    }
}

Respond ONLY with valid JSON. Do not include any other text before or after the JSON.`;

        const groqResponse = await fetch(
            'https://api.groq.com/openai/v1/chat/completions',
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: 'llama-3.1-8b-instant',
                    messages: [
                        {
                            role: 'user',
                            content: prompt
                        }
                    ],
                    temperature: 0.1,
                    max_tokens: 500
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
        // Try to extract JSON from the text (in case there's extra text)
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
                sources: relevantResults.map(r => r.url)
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
