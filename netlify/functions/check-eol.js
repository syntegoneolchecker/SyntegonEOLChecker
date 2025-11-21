// Function to process and reformat tables in content for better LLM comprehension
function processTablesInContent(content) {
    if (!content) return content;

    // Detect markdown tables by looking for multiple lines with pipe characters
    const lines = content.split('\n');
    const processedLines = [];
    let inTable = false;
    let tableLines = [];
    let headerRow = null;
    let separatorFound = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        // Check if line looks like a table row (contains | characters)
        const hasPipes = line.includes('|');
        const pipeCount = (line.match(/\|/g) || []).length;

        if (hasPipes && pipeCount >= 2) {
            // This looks like a table line
            if (!inTable) {
                inTable = true;
                tableLines = [];
            }
            tableLines.push(line);
        } else {
            // Not a table line
            if (inTable && tableLines.length > 0) {
                // End of table, process it
                processedLines.push(formatTable(tableLines));
                tableLines = [];
                inTable = false;
            }
            processedLines.push(line);
        }
    }

    // Handle case where table extends to end of content
    if (inTable && tableLines.length > 0) {
        processedLines.push(formatTable(tableLines));
    }

    return processedLines.join('\n');
}

// Helper function to format a table into a clear structure
function formatTable(tableLines) {
    if (tableLines.length === 0) return '';

    // Parse table structure
    const rows = tableLines.map(line => {
        // Split by | and clean up
        return line.split('|')
            .map(cell => cell.trim())
            .filter(cell => cell.length > 0 && !cell.match(/^-+$/)); // Remove empty cells and separator rows
    }).filter(row => row.length > 0);

    if (rows.length === 0) return '';

    // First non-separator row is usually headers
    const headers = rows[0];
    const dataRows = rows.slice(1);

    // Format as explicit table structure
    let formatted = '\n=== TABLE START ===\n';
    formatted += `Column Headers: ${headers.join(' | ')}\n`;
    formatted += '---\n';

    dataRows.forEach((row, idx) => {
        if (row.length > 0) {
            // Pad row to match header length if needed
            while (row.length < headers.length) {
                row.push('-');
            }

            // Create explicit column mappings
            const rowData = headers.map((header, i) => {
                const value = row[i] || '-';
                return `${header}="${value}"`;
            }).join(', ');

            formatted += `Row ${idx + 1}: ${rowData}\n`;
        }
    });

    formatted += '=== TABLE END ===\n';

    return formatted;
}

// Smart truncation that preserves complete tables
function smartTruncate(content, maxLength) {
    if (content.length <= maxLength) return content;

    // Find all table sections
    const tableRegex = /=== TABLE START ===[\s\S]*?=== TABLE END ===/g;
    const tables = [];
    let match;
    let tablePositions = [];

    while ((match = tableRegex.exec(content)) !== null) {
        tables.push(match[0]);
        tablePositions.push({
            start: match.index,
            end: match.index + match[0].length,
            content: match[0]
        });
    }

    // If no tables, simple truncation at sentence boundary
    if (tables.length === 0) {
        let truncated = content.substring(0, maxLength);
        // Try to end at a sentence
        const lastPeriod = truncated.lastIndexOf('.');
        const lastNewline = truncated.lastIndexOf('\n');
        const cutPoint = Math.max(lastPeriod, lastNewline);
        if (cutPoint > maxLength * 0.7) { // Only use sentence boundary if it's not too far back
            truncated = truncated.substring(0, cutPoint + 1);
        }
        return truncated + '\n\n[Content truncated due to length]';
    }

    // Calculate total table size
    const totalTableSize = tables.reduce((sum, table) => sum + table.length, 0);

    // If tables alone exceed max length, keep all tables and truncate
    if (totalTableSize >= maxLength) {
        return tables.join('\n\n') + '\n\n[Non-table content removed due to length constraints]';
    }

    // Otherwise, keep all tables and fill remaining space with non-table content
    const remainingSpace = maxLength - totalTableSize;

    // Extract non-table content
    let nonTableContent = content;
    tablePositions.reverse().forEach(pos => {
        nonTableContent = nonTableContent.substring(0, pos.start) +
                         '###TABLE_PLACEHOLDER###' +
                         nonTableContent.substring(pos.end);
    });

    // Truncate non-table content
    if (nonTableContent.length > remainingSpace) {
        const parts = nonTableContent.split('###TABLE_PLACEHOLDER###');
        let truncatedParts = [];
        let currentLength = 0;

        for (let part of parts) {
            if (currentLength + part.length <= remainingSpace) {
                truncatedParts.push(part);
                currentLength += part.length;
            } else {
                const spaceLeft = remainingSpace - currentLength;
                if (spaceLeft > 100) { // Only add partial if we have reasonable space
                    truncatedParts.push(part.substring(0, spaceLeft) + '...');
                }
                break;
            }
        }

        nonTableContent = truncatedParts.join('###TABLE_PLACEHOLDER###');
    }

    // Reinsert tables
    let result = nonTableContent;
    tables.forEach(table => {
        result = result.replace('###TABLE_PLACEHOLDER###', table);
    });

    return result;
}

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
                include_raw_content: 'text',
                chunks_per_source: 5,
                include_domains: [
                    'jp.misumi-ec.com',
                    'www.orimvexta.co.jp',
                    'anelva.canon',
                    'www.printerland.co.uk',
                    '.ysol.co.jp',
                    'pdf.directindustry.com',
                    '.manualslib.com',
                    'fa.omron.co.jp',
                    '.mouser.jp',
                    '.digikey.jp',
                    '.rs-components.com',
                    '.fa-ubon.jp',
                    '.monotaro.com',
                    '.misumi.co.jp',
                    '.fujitsu.com',
                    '.hubbell.com',
                    '.adlinktech.com',
                    '.touchsystems.com',
                    '.elotouch.com',
                    '.aten.com',
                    '.canon.com',
                    '.axiomtek.com',
                    '.apc.com',
                    '.hp.com',
                    '.fujielectric.co.jp',
                    '.panasonic.jp',
                    '.wago.com',
                    '.schmersal.com',
                    '.apiste.co.jp',
                    '.tdklamda.com',
                    '.phoenixcontact.com',
                    '.idec.com',
                    '.patlite.co.jp',
                    '.smcworld.com',
                    '.sanyodenki.co.jp',
                    '.nissin-ele.co.jp',
                    '.sony.co.jp',
                    '.mitsubishielectric.co.jp',
                    '.orientalmotor.co.jp',
                    '.keyence.co.jp',
                    '.omron.co.jp'
                ]
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

        // Step 2: Prepare search context for LLM with table processing and smart truncation
        const MAX_CONTENT_LENGTH = 5000; // Maximum characters per result to avoid token limits
        // With 5 results × 5000 chars = 25000 chars ≈ 7000 tokens + prompt overhead ≈ 8000 tokens total

        const searchContext = relevantResults
            .map((result, index) => {
                // Use raw_content if available, otherwise fall back to content
                let rawContent = result.raw_content || result.content || '';

                // Process tables in the content for better LLM comprehension
                let processedContent = processTablesInContent(rawContent);

                // Smart truncation: preserve tables, truncate other content
                if (processedContent.length > MAX_CONTENT_LENGTH) {
                    processedContent = smartTruncate(processedContent, MAX_CONTENT_LENGTH);
                }

                return `Result #${index + 1}
URL: ${result.url}
Content:
${processedContent}`;
            })
            .join('\n\n---\n\n');

        // Log the full search context being sent to LLM
        console.log('=== FULL SEARCH CONTEXT SENT TO LLM ===');
        console.log(searchContext);
        console.log('=== END SEARCH CONTEXT ===');

        // Step 3: Analyze with Groq LLM
        console.log('Step 2: Analyzing with Groq...');

        const prompt = `TASK: Determine if the product "${model}" by ${maker} is discontinued (end-of-life).

SEARCH RESULTS:
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
   - Listed as a replacement/successor for other products
   - Has recent documentation, pricing, or specifications listed
   - **CRITICAL: If "${model}" is listed as the REPLACEMENT for a discontinued product, then "${model}" is ACTIVE**
     Example: "Product X discontinued, replacement: ${model}" means ${model} is ACTIVE

3. EVIDENCE OF DISCONTINUED STATUS (ONLY mark discontinued with concrete proof):
   - Explicitly listed in official discontinuation/EOL tables or announcements
   - Clear statement: "discontinued", "end of life", "end of sales", "production ended"
   - Must be from reputable source (manufacturer, official distributor)
   - Auction sites or secondhand listings are NOT evidence
   - Make sure that the discontinuation is specifically mentioned for "${model}"
   - **CRITICAL: Do NOT mark "${model}" as discontinued just because it appears in a document about OTHER discontinued products**
   - **CRITICAL: If "${model}" is the REPLACEMENT/SUCCESSOR for discontinued products, "${model}" is ACTIVE, not discontinued**

4. REPLACEMENT LOGIC - READ CAREFULLY:
   - "Product X → Product Y" means: X is discontinued, Y is the active replacement
   - "Discontinued: X, Replacement: Y" means: X is old/discontinued, Y is new/active
   - If you see "${model}" as the replacement target, "${model}" is ACTIVE
   - Example interpretations:
     * "QA1S38B discontinued, replacement: Q38B" → Q38B is ACTIVE
     * "Q38B-E discontinued, replacement: Q38B" → Q38B is ACTIVE
     * Document lists Q38B as replacement for 3 products → Q38B is ACTIVE (it's the current model)

5. SUCCESSOR IDENTIFICATION
   - If discontinued: Search all content for explicit successor mentions
     ("replaced by X", "successor: X", "recommended replacement: X")
   - If active: No successor needed
   - Only report if explicitly stated for this exact product

6. USE COMMON SENSE
   - Prioritize official manufacturer information
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
                    model: 'llama-3.3-70b-versatile',
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

        // Extract rate limit information from headers
        const rateLimitInfo = {
            remainingRequests: groqResponse.headers.get('x-ratelimit-remaining-requests'),
            limitRequests: groqResponse.headers.get('x-ratelimit-limit-requests'),
            remainingTokens: groqResponse.headers.get('x-ratelimit-remaining-tokens'),
            limitTokens: groqResponse.headers.get('x-ratelimit-limit-tokens')
        };

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
                sources: relevantResults.map(r => r.url),
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
