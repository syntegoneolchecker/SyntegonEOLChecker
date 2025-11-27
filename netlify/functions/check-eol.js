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
        const prompt = `TASK: Determine the current status of the exact product **${model}** by ${maker}.

RULES

1. **Exact model only**
   - Consider ONLY the string "${model}".
   - Anything with extra characters (e.g., ${model}‑E, ${model}A, ${model}‑V2) is a DIFFERENT product and must be ignored.

2. **What counts as ACTIVE**
   - The model is listed **as a current offering** on the official ${maker} website, an authorized distributor, or a current‑price sheet.
   - The model appears **as a replacement, successor, or recommended alternative** for another (usually older) product.
     *Important nuance*: If a document is titled "End‑of‑Life" **but the row for ${model} is in the "Replacement" column**, that is **evidence of ACTIVE status**, not discontinuation.
   - Recent (within the last 2‑3 years) datasheets, price lists, or ordering guides that include ${model}.

3. **What counts as DISCONTINUED**
   - An official "Discontinued / End‑of‑Life" table that explicitly marks ${model} with a status such as "Discontinued", "EOL", "End of sales", or provides a "Last Time Buy" date **without also listing a replacement** for ${model}.
   - A clear statement from ${maker} (or an authorized partner) that production of ${model} has stopped.

4. **How to treat tables**
   - Read every column header. Typical columns are:
     \`Model | End‑of‑order date | Discontinued date | Repair‑support expiry | Replacement\`
   - **If the "Replacement" column contains "${model}" for another model, treat ${model} as ACTIVE.**
   - **If the row for ${model} itself has a non‑empty "Discontinued date" and the "Replacement" column is empty, treat it as DISCONTINUED.**
   - Ignore rows that merely mention ${model} in a "Notes" or "Description" field unless the note explicitly says "${model} is a replacement for …".

5. **Evidence hierarchy**
   - Official ${maker} PDFs, web pages, or authorized distributor PDFs are highest priority.
   - Third‑party reseller pages are secondary, but only if they show a current price/availability.
   - Auction or second‑hand listings are **never** used as proof of ACTIVE status.

6. **When in doubt**
   - If the information is ambiguous (e.g., the table shows ${model} in both "Discontinued" and "Replacement" columns), answer **UNKNOWN** and note the conflict.

OUTPUT FORMAT (JSON)

{
    "status": "ACTIVE" | "DISCONTINUED" | "UNKNOWN",
    "explanation": "One brief sentence citing the most definitive source (Result #N: URL, key evidence).",
    "successor": {
        "status": "FOUND" | "UNKNOWN",
        "model": "model name or null",
        "explanation": "Brief explanation or 'Product is active, no successor needed'."
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
                    model: 'groq/compound-mini',
                    messages: [
                        {
                            role: 'user',
                            content: prompt
                        }
                    ],
                    temperature: 0,  // Deterministic - same input = same output
                    max_completion_tokens: 8192,
                    top_p: 1,
                    compound_custom: {
                        tools: {
                            enabled_tools: ['web_search', 'visit_website']
                        }
                    },
                    search_settings: {
                        include_domains: [
                            '*.daitron.co.jp',
                            '*.kdwan.co.jp',
                            '*.hewtech.co.jp',
                            '*.directindustry.com',
                            '*.printerland.co.uk',
                            '*.orimvexta.co.jp',
                            '*.sankyo-seisakusho.co.jp',
                            '*.tsubakimoto.co.jp',
                            '*.nbk1560.com',
                            '*.habasit.com',
                            '*.nagoya.sc',
                            '*.misumi-ec.com',
                            '*.anelva.canon',
                            '*.mouser.jp',
                            '*.digikey.jp',
                            '*.rs-components.com',
                            '*.fa-ubon.jp',
                            '*.monotaro.com',
                            '*.misumi.co.jp',
                            '*.fujitsu.com',
                            '*.hubbell.com',
                            '*.adlinktech.com',
                            '*.touchsystems.com',
                            '*.elotouch.com',
                            '*.aten.com',
                            '*.canon.com',
                            '*.axiomtek.com',
                            '*.apc.com',
                            '*.hp.com',
                            '*.fujielectric.co.jp',
                            '*.panasonic.jp',
                            '*.wago.com',
                            '*.schmersal.com',
                            '*.apiste.co.jp',
                            '*.tdklamda.com',
                            '*.phoenixcontact.com',
                            '*.idec.com',
                            '*.patlite.co.jp',
                            '*.smcworld.com',
                            '*.sanyodenki.co.jp',
                            '*.nissin-ele.co.jp',
                            '*.sony.co.jp',
                            '*.mitsubishielectric.co.jp',
                            '*.orientalmotor.co.jp',
                            '*.keyence.co.jp',
                            '*.omron.co.jp'
                        ]
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
