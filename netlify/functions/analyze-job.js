// Run LLM analysis on fetched results
const { getJob, saveFinalResult, updateJobStatus } = require('./lib/job-storage');

exports.handler = async function(event, context) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const { jobId } = JSON.parse(event.body);

        console.log(`Starting analysis for job ${jobId}`);

        const job = await getJob(jobId, context);

        if (!job) {
            return {
                statusCode: 404,
                body: JSON.stringify({ error: 'Job not found' })
            };
        }

        // Update status to analyzing
        await updateJobStatus(jobId, 'analyzing', null, context);

        // Format results for LLM
        const searchContext = formatResults(job);

        // Call Groq
        const analysis = await analyzeWithGroq(job.maker, job.model, searchContext);

        // Save final result
        await saveFinalResult(jobId, analysis, context);

        console.log(`Analysis complete for job ${jobId}`);

        return {
            statusCode: 200,
            body: JSON.stringify({ success: true, result: analysis })
        };

    } catch (error) {
        console.error('Analysis error:', error);

        try {
            const { jobId } = JSON.parse(event.body);
            await updateJobStatus(jobId, 'error', error.message, context);
        } catch (e) {
            // Ignore
        }

        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};

// Process tables in content (mark with delimiters)
function processTablesInContent(content) {
    if (!content) return content;

    const lines = content.split('\n');
    const processedLines = [];
    let inTable = false;
    let tableLines = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        const hasPipes = trimmed.includes('|');
        const pipeCount = (trimmed.match(/\|/g) || []).length;
        const isSeparator = /^[\s\-|]+$/.test(trimmed) && trimmed.length > 0;

        if (hasPipes && pipeCount >= 2) {
            if (!inTable) {
                inTable = true;
                tableLines = [];
                processedLines.push('\n=== TABLE START ===');
            }
            tableLines.push(line);
            processedLines.push(line);
        } else if (inTable && isSeparator) {
            tableLines.push(line);
            processedLines.push(line);
        } else {
            if (inTable && tableLines.length > 0) {
                processedLines.push('=== TABLE END ===\n');
                tableLines = [];
                inTable = false;
            }
            processedLines.push(line);
        }
    }

    if (inTable && tableLines.length > 0) {
        processedLines.push('=== TABLE END ===\n');
    }

    return processedLines.join('\n');
}

// Remove tables that don't contain the product model name
function filterIrrelevantTables(content, productModel) {
    if (!content || !productModel) return content;

    const tableRegex = /=== TABLE START ===[\s\S]*?=== TABLE END ===/g;
    let match;
    const tablesToRemove = [];

    while ((match = tableRegex.exec(content)) !== null) {
        const tableContent = match[0];

        if (!tableContent.toLowerCase().includes(productModel.toLowerCase())) {
            tablesToRemove.push({
                content: tableContent,
                start: match.index,
                end: match.index + tableContent.length
            });
        }
    }

    let filteredContent = content;
    for (let i = tablesToRemove.length - 1; i >= 0; i--) {
        const table = tablesToRemove[i];
        filteredContent = filteredContent.substring(0, table.start) +
                         filteredContent.substring(table.end);
    }

    filteredContent = filteredContent.replace(/\n{3,}/g, '\n\n');

    return filteredContent;
}

// Smart truncation that preserves complete tables
function smartTruncate(content, maxLength, productModel) {
    if (content.length <= maxLength) return content;

    const tableRegex = /=== TABLE START ===[\s\S]*?=== TABLE END ===/g;
    const tables = [];
    let match;

    while ((match = tableRegex.exec(content)) !== null) {
        tables.push({
            content: match[0],
            start: match.index,
            end: match.index + match[0].length,
            containsProduct: productModel ? match[0].includes(productModel) : false
        });
    }

    if (tables.length === 0) {
        let truncated = content.substring(0, maxLength);
        const lastPeriod = truncated.lastIndexOf('.');
        const lastNewline = truncated.lastIndexOf('\n');
        const cutPoint = Math.max(lastPeriod, lastNewline);
        if (cutPoint > maxLength * 0.7) {
            truncated = truncated.substring(0, cutPoint + 1);
        }
        return truncated + '\n\n[Content truncated due to length]';
    }

    tables.sort((a, b) => {
        if (a.containsProduct && !b.containsProduct) return -1;
        if (!a.containsProduct && b.containsProduct) return 1;
        return a.start - b.start;
    });

    const totalTableSize = tables.reduce((sum, table) => sum + table.content.length, 0);

    if (totalTableSize >= maxLength) {
        let keptTables = [];
        let currentSize = 0;

        for (let table of tables) {
            if (currentSize + table.content.length <= maxLength) {
                keptTables.push(table.content);
                currentSize += table.content.length;
            } else {
                if (keptTables.length === 0) {
                    const partialTable = table.content.substring(0, maxLength - 100) + '\n\n[Table truncated due to size constraints]';
                    keptTables.push(partialTable);
                }
                break;
            }
        }

        return keptTables.join('\n\n') + '\n\n[Non-table content removed due to length constraints]';
    }

    const remainingSpace = maxLength - totalTableSize;

    let nonTableContent = content;
    tables.sort((a, b) => b.start - a.start).forEach(table => {
        nonTableContent = nonTableContent.substring(0, table.start) +
                         '###TABLE_PLACEHOLDER###' +
                         nonTableContent.substring(table.end);
    });

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
                if (spaceLeft > 50) {
                    let partial = part.substring(0, spaceLeft);
                    const lastPeriod = partial.lastIndexOf('.');
                    const lastNewline = partial.lastIndexOf('\n');
                    const cutPoint = Math.max(lastPeriod, lastNewline);
                    if (cutPoint > spaceLeft * 0.5) {
                        partial = partial.substring(0, cutPoint + 1);
                    }
                    truncatedParts.push(partial + '...');
                }
                break;
            }
        }

        nonTableContent = truncatedParts.join('###TABLE_PLACEHOLDER###');
    }

    let result = nonTableContent;
    tables.forEach(table => {
        result = result.replace('###TABLE_PLACEHOLDER###', table.content);
    });

    return result;
}

// Format job results for LLM with token limiting
function formatResults(job) {
    const MAX_CONTENT_LENGTH = 8000; // Maximum characters per result
    const MAX_TOTAL_CHARS = 16000; // 2 URLs × 8000 chars = 16,000 chars (~4,000 tokens)

    let formatted = '';
    let totalChars = 0;

    for (let index = 0; index < job.urls.length; index++) {
        const urlInfo = job.urls[index];
        const result = job.urlResults[urlInfo.index];

        let resultSection = `\n========================================\n`;
        resultSection += `RESULT #${index + 1}:\n`;
        resultSection += `========================================\n`;
        resultSection += `Title: ${urlInfo.title}\n`;
        resultSection += `URL: ${urlInfo.url}\n`;
        resultSection += `Snippet: ${urlInfo.snippet}\n`;

        if (result && result.fullContent) {
            let processedContent = processTablesInContent(result.fullContent);
            processedContent = filterIrrelevantTables(processedContent, job.model);

            if (processedContent.length > MAX_CONTENT_LENGTH) {
                console.log(`Truncating URL #${index + 1} content from ${processedContent.length} to ${MAX_CONTENT_LENGTH} chars`);
                processedContent = smartTruncate(processedContent, MAX_CONTENT_LENGTH, job.model);
            }

            resultSection += `\nFULL PAGE CONTENT:\n`;
            resultSection += `${processedContent}\n`;
        } else {
            resultSection += `\n[Note: Could not fetch full content - using snippet only]\n`;
        }

        resultSection += '\n========================================\n';

        if (totalChars + resultSection.length > MAX_TOTAL_CHARS) {
            console.log(`Stopping at URL #${index + 1} - total char limit (${MAX_TOTAL_CHARS}) would be exceeded`);
            formatted += `\n[Note: Remaining URLs omitted to stay within token limits]\n`;
            break;
        }

        formatted += resultSection;
        totalChars += resultSection.length;
    }

    console.log(`Final formatted content: ${totalChars} characters (~${Math.round(totalChars / 4)} tokens)`);
    return formatted.trim();
}

// Analyze with Groq
async function analyzeWithGroq(maker, model, searchContext) {
    const prompt = `TASK: Determine if the product "${model}" by ${maker} is discontinued (end-of-life).

SEARCH RESULTS:
${searchContext}

ANALYSIS RULES:

1. EXACT PRODUCT IDENTIFICATION
   - You are analyzing "${model}" ONLY
   - Product variants with ANY character difference (suffixes, prefixes, version numbers) are DIFFERENT products
   - Only use information explicitly about "${model}"

2. EVIDENCE OF ACTIVE STATUS (product is NOT discontinued if):
   - Currently sold on manufacturer's official website or authorized retailers
   - Available for purchase (not auction/secondhand sites)
   - Listed as a replacement/successor for other products
   - Has recent documentation, pricing, or specifications listed
   - **CRITICAL: If "${model}" is listed as the REPLACEMENT/SUCCESSOR for a discontinued product, then "${model}" is ACTIVE**

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
   - If you see "${model}" as the replacement target in tables or documentation, "${model}" is ACTIVE
   - Being listed as a replacement/successor for multiple older products means "${model}" is the current active model

5. SUCCESSOR IDENTIFICATION
   - If discontinued: Search all content for explicit successor mentions
     ("replaced by X", "successor: X", "recommended replacement: X")
   - If active: No successor needed
   - Only report if explicitly stated for this exact product

6. USE COMMON SENSE
   - Prioritize official manufacturer information
   - When uncertain, lean toward UNKNOWN rather than guessing
   - If there is conflicting information, lean toward UNKNOWN rather than guessing
   - Active sales = strong evidence of ACTIVE status
   - The information is provided in the form of scraped websites. Websites have links, footers, headers etc. Because of this circumstance, not all content is relevant to the task!
   - The term "discontinued" appearing somewhere on the page alone is not proof of discontinuation, it must be connected to "${model}" or relate to it specifically

THIS PART IS EXTREMELY IMPORTANT:
If you are provided with insufficient information: return the status UNKNOWN and write the reason in the explanation sections.
Respond ONLY with valid JSON. Do not include any other text before or after the JSON.

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

    const groqResponse = await fetch(
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
                        content: prompt
                    }
                ],
                temperature: 0,
                max_completion_tokens: 8192,
                top_p: 1,
                stream: false,
                reasoning_effort: 'low',
                response_format: {
                    type: 'json_object'
                },
                stop: null,
                seed: 1
            })
        }
    );

    if (!groqResponse.ok) {
        const errorText = await groqResponse.text();
        console.error('Groq API error:', errorText);

        if (groqResponse.status === 429) {
            throw new Error('Rate limit exceeded. Please try again in a moment.');
        }

        throw new Error(`Groq API failed: ${groqResponse.status} - ${errorText}`);
    }

    const groqData = await groqResponse.json();
    console.log('Groq response:', JSON.stringify(groqData));

    // Extract token rate limit information from headers
    const resetTokens = groqResponse.headers.get('x-ratelimit-reset-tokens');
    let resetSeconds = null;
    if (resetTokens) {
        const match = resetTokens.match(/^([\d.]+)s?$/);
        if (match) {
            resetSeconds = parseFloat(match[1]);
        }
    }

    const rateLimitInfo = {
        remainingTokens: groqResponse.headers.get('x-ratelimit-remaining-tokens'),
        limitTokens: groqResponse.headers.get('x-ratelimit-limit-tokens'),
        resetSeconds: resetSeconds
    };

    // Extract the generated text
    let generatedText = '';
    if (groqData.choices && groqData.choices[0]?.message?.content) {
        generatedText = groqData.choices[0].message.content;
    } else {
        throw new Error('Unexpected response format from LLM');
    }

    // Parse JSON from the response
    let analysisResult;
    try {
        analysisResult = JSON.parse(generatedText);
    } catch (e) {
        const jsonMatch = generatedText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            try {
                analysisResult = JSON.parse(jsonMatch[0]);
            } catch (e2) {
                throw new Error('Failed to parse LLM response as JSON');
            }
        } else {
            throw new Error('No JSON found in LLM response');
        }
    }

    // Validate the response structure
    if (!analysisResult.status || !analysisResult.explanation || !analysisResult.successor) {
        throw new Error('Invalid analysis result structure');
    }

    // Add rate limit info to result
    analysisResult.rateLimits = rateLimitInfo;

    return analysisResult;
}
