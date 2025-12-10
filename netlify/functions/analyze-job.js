// Run LLM analysis on fetched results
const { getJob, saveFinalResult, updateJobStatus } = require('./lib/job-storage');

// Check Groq API token availability before making request
async function checkGroqTokenAvailability() {
    try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'openai/gpt-oss-120b',
                messages: [{ role: 'user', content: 'ping' }],
                max_completion_tokens: 1
            })
        });

        const resetTokens = response.headers.get('x-ratelimit-reset-tokens');
        const remainingTokens = parseInt(response.headers.get('x-ratelimit-remaining-tokens') || '0');

        let resetSeconds = null;
        if (resetTokens) {
            const match = resetTokens.match(/^([\d.]+)s?$/);
            if (match) {
                resetSeconds = parseFloat(match[1]);
            }
        }

        console.log(`Groq tokens remaining: ${remainingTokens}, reset in: ${resetSeconds || 'N/A'}s`);

        return {
            available: remainingTokens > 500, // Need at least 500 tokens for analysis
            remainingTokens,
            resetSeconds: resetSeconds || 0
        };
    } catch (error) {
        console.error('Failed to check Groq token availability:', error.message);
        // If check fails, assume tokens available and let actual call handle it
        return { available: true, remainingTokens: null, resetSeconds: 0 };
    }
}

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

        // FIX: Check Groq token availability BEFORE analysis
        const tokenCheck = await checkGroqTokenAvailability();
        if (!tokenCheck.available && tokenCheck.resetSeconds > 0) {
            const waitMs = Math.ceil(tokenCheck.resetSeconds * 1000) + 1000; // Add 1s buffer
            console.log(`⏳ Groq tokens low (${tokenCheck.remainingTokens}), waiting ${waitMs}ms for rate limit reset...`);
            await new Promise(resolve => setTimeout(resolve, waitMs));
            console.log(`✓ Wait complete, proceeding with analysis`);
        }

        // Format results for LLM
        const searchContext = formatResults(job);

        // Call Groq with retry logic
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

// Advanced smart truncation that preserves product mentions
function smartTruncate(content, maxLength, productModel) {
    if (content.length <= maxLength) return content;
    if (!productModel) {
        // No product model - simple truncation from end
        return simpleTruncate(content, maxLength);
    }

    const productLower = productModel.toLowerCase();
    const contentLower = content.toLowerCase();

    // Check if product name is present in content
    if (!contentLower.includes(productLower)) {
        // Product not mentioned - simple truncation from end
        console.log(`Product "${productModel}" not found in content, using simple truncation`);
        return simpleTruncate(content, maxLength);
    }

    console.log(`Product "${productModel}" found in content, using advanced truncation`);

    // Product IS mentioned - use advanced truncation
    // Step 1: Process tables (remove non-product tables, truncate product tables)
    let processedContent = truncateTablesWithProduct(content, productModel, maxLength);

    // Step 2: If still too long, extract product mention sections
    if (processedContent.length > maxLength) {
        processedContent = extractProductSections(processedContent, productModel, maxLength);
    }

    // Step 3: Final check - if STILL too long, hard truncate but preserve first product mention
    if (processedContent.length > maxLength) {
        console.log(`Content still too long after section extraction, applying final truncation`);
        processedContent = finalTruncate(processedContent, productModel, maxLength);
    }

    return processedContent + '\n\n[Content truncated to preserve product mentions]';
}

// Helper: Simple truncation from end at sentence boundary
function simpleTruncate(content, maxLength) {
    let truncated = content.substring(0, maxLength);

    // Try to cut at sentence boundary
    const lastPeriod = truncated.lastIndexOf('.');
    const lastNewline = truncated.lastIndexOf('\n');
    const cutPoint = Math.max(lastPeriod, lastNewline);

    if (cutPoint > maxLength * 0.7) {
        truncated = truncated.substring(0, cutPoint + 1);
    }

    return truncated + '\n\n[Content truncated due to length]';
}

// Helper: Truncate tables intelligently (keep product mentions, remove others)
function truncateTablesWithProduct(content, productModel, maxLength) {
    const tableRegex = /=== TABLE START ===[\s\S]*?=== TABLE END ===/g;
    let result = content;
    let match;
    const tables = [];

    // Find all tables
    while ((match = tableRegex.exec(content)) !== null) {
        tables.push({
            content: match[0],
            start: match.index,
            end: match.index + match[0].length
        });
    }

    // Process tables in reverse order (to preserve indices)
    for (let i = tables.length - 1; i >= 0; i--) {
        const table = tables[i];
        const tableContent = table.content;

        if (!tableContent.toLowerCase().includes(productModel.toLowerCase())) {
            // Table doesn't contain product - already removed by filterIrrelevantTables
            continue;
        }

        // Table contains product - truncate to keep only relevant rows
        const truncatedTable = truncateTableRows(tableContent, productModel);

        // Replace original table with truncated version
        result = result.substring(0, table.start) + truncatedTable + result.substring(table.end);
    }

    return result;
}

// Helper: Truncate table to keep only rows around product mentions
function truncateTableRows(tableContent, productModel) {
    const lines = tableContent.split('\n');
    const productLower = productModel.toLowerCase();
    const ROWS_BEFORE = 3;
    const ROWS_AFTER = 3;

    // Find table boundaries
    let tableStart = -1;
    let tableEnd = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('=== TABLE START ===')) tableStart = i;
        if (lines[i].includes('=== TABLE END ===')) tableEnd = i;
    }

    if (tableStart === -1 || tableEnd === -1) return tableContent;

    // Find rows containing product
    const productRows = [];
    for (let i = tableStart + 1; i < tableEnd; i++) {
        if (lines[i].toLowerCase().includes(productLower)) {
            productRows.push(i);
        }
    }

    if (productRows.length === 0) return tableContent;

    // Build set of rows to keep (including context)
    const rowsToKeep = new Set();

    // Always keep header row (first row after TABLE START)
    if (tableStart + 1 < tableEnd) {
        rowsToKeep.add(tableStart + 1);
    }

    // Keep rows around each product mention
    for (const productRow of productRows) {
        // Keep ROWS_BEFORE before, the product row, and ROWS_AFTER after
        for (let i = Math.max(tableStart + 1, productRow - ROWS_BEFORE);
             i <= Math.min(tableEnd - 1, productRow + ROWS_AFTER);
             i++) {
            rowsToKeep.add(i);
        }
    }

    // Build truncated table
    const keptLines = [];
    keptLines.push(lines[tableStart]); // TABLE START marker

    let lastKeptRow = tableStart;
    for (let i = tableStart + 1; i < tableEnd; i++) {
        if (rowsToKeep.has(i)) {
            // Add ellipsis if we skipped rows
            if (i - lastKeptRow > 1) {
                keptLines.push('| ... | ... |');
            }
            keptLines.push(lines[i]);
            lastKeptRow = i;
        }
    }

    keptLines.push(lines[tableEnd]); // TABLE END marker

    const result = keptLines.join('\n');
    console.log(`Truncated table from ${lines.length} rows to ${keptLines.length} rows`);
    return result;
}

// Helper: Extract sections containing product mentions with context
function extractProductSections(content, productModel, maxLength) {
    const CONTEXT_CHARS = 250; // Characters before and after product mention
    const productLower = productModel.toLowerCase();
    const contentLower = content.toLowerCase();

    // Find all product mentions
    const mentions = [];
    let index = contentLower.indexOf(productLower);
    while (index !== -1) {
        mentions.push(index);
        index = contentLower.indexOf(productLower, index + 1);
    }

    if (mentions.length === 0) {
        return simpleTruncate(content, maxLength);
    }

    console.log(`Found ${mentions.length} product mentions, extracting sections`);

    // Extract sections around each mention
    const sections = [];
    for (const mentionIndex of mentions) {
        const start = Math.max(0, mentionIndex - CONTEXT_CHARS);
        const end = Math.min(content.length, mentionIndex + productModel.length + CONTEXT_CHARS);

        let section = content.substring(start, end);

        // Add ellipsis if we cut mid-text
        if (start > 0) section = '...' + section;
        if (end < content.length) section = section + '...';

        sections.push(section);
    }

    // Combine sections
    let combined = sections.join('\n\n[...]\n\n');

    // If combined sections still too long, prioritize first mentions
    if (combined.length > maxLength) {
        combined = '';
        for (const section of sections) {
            if (combined.length + section.length + 20 <= maxLength) {
                if (combined.length > 0) combined += '\n\n[...]\n\n';
                combined += section;
            } else {
                break;
            }
        }
    }

    return combined;
}

// Helper: Final hard truncation while preserving first product mention
function finalTruncate(content, productModel, maxLength) {
    const productLower = productModel.toLowerCase();
    const contentLower = content.toLowerCase();
    const firstMention = contentLower.indexOf(productLower);

    if (firstMention === -1 || firstMention > maxLength) {
        // Product mention not in first maxLength chars, just truncate from start
        return simpleTruncate(content, maxLength);
    }

    // Try to keep content centered around first mention
    const CONTEXT = 200;
    const start = Math.max(0, firstMention - CONTEXT);
    const end = Math.min(content.length, start + maxLength);

    let result = content.substring(start, end);
    if (start > 0) result = '...' + result;
    if (end < content.length) result = result + '...';

    return result;
}

// Format job results for LLM with token limiting
function formatResults(job) {
    const MAX_CONTENT_LENGTH = 6500; // Maximum characters per result
    const MAX_TOTAL_CHARS = 13000; // 2 URLs × 6500 chars = 13,000 chars

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
   - **CRITICAL: If there is a price or a delivery date provided for "${model}", then the product is ACTIVE**
   - **CRITICAL: If "${model}" is listed as the REPLACEMENT/SUCCESSOR for a discontinued product, then "${model}" is ACTIVE**

3. EVIDENCE OF DISCONTINUED STATUS (ONLY mark discontinued with concrete proof):
   - Explicitly listed in official discontinuation/EOL tables or announcements
   - Clear statement: "discontinued", "end of life", "end of sales", "production ended"
   - Must be from reputable source (manufacturer, official distributor)
   - Auction sites or secondhand listings are NOT evidence
   - Make sure that the discontinuation is specifically mentioned for "${model}"
   - **CRITICAL: Do NOT mark "${model}" as discontinued just because it appears in a document about OTHER discontinued products**
   - **CRITICAL: If "${model}" is the REPLACEMENT/SUCCESSOR for discontinued products, "${model}" is ACTIVE, not discontinued**
   - **CRITICAL: If "${model}" is being actively sold, has a delivery date, or current price information then it is ACTIVE and not discontinued**

4. REPLACEMENT LOGIC - READ CAREFULLY:
   - "Product X → Product Y" means: X is discontinued, Y is the active replacement
   - "Discontinued: X, Replacement: Y" means: X is old/discontinued, Y is new/active
   - If you see "${model}" as the replacement target in tables or documentation, "${model}" is ACTIVE
   - Being listed as a replacement/successor for multiple older products means "${model}" is the current active model

5. SUCCESSOR IDENTIFICATION
   - If discontinued: Search all content for explicit successor mentions
     ("replaced by X", "successor: X", "recommended replacement: X", or any equivalent statements)
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

RESPONSE FORMAT (JSON ONLY - NO OTHER TEXT, for the status sections put EXACLTY one of the options mentioned):
{
    "status": "ACTIVE" | "DISCONTINUED" | "UNKNOWN",
    "explanation": "ONE brief sentence citing the most definitive source (Result #N: URL(ALWAYS provide the URL), key evidence)",
    "successor": {
        "status": "FOUND" | "UNKNOWN",
        "model": "model name or null",
        "explanation": "Brief explanation or 'Product is active, no successor needed'"
    }
}`;

    console.log('This is the entire prompt:\n' + prompt);

    // FIX: Add retry logic with exponential backoff for rate limits
    const MAX_RETRIES = 3;
    let groqResponse = null;
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            console.log(`Groq API call attempt ${attempt}/${MAX_RETRIES}`);

            groqResponse = await fetch(
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
                console.error(`Groq API error (attempt ${attempt}):`, errorText);

                if (groqResponse.status === 429) {
                    // Rate limit - extract reset time from headers and wait
                    const resetTokens = groqResponse.headers.get('x-ratelimit-reset-tokens');
                    let resetSeconds = 60; // Default to 60s if not provided

                    if (resetTokens) {
                        const match = resetTokens.match(/^([\d.]+)s?$/);
                        if (match) {
                            resetSeconds = parseFloat(match[1]);
                        }
                    }

                    if (attempt < MAX_RETRIES) {
                        const waitMs = Math.ceil(resetSeconds * 1000) + 2000; // Add 2s buffer
                        console.log(`⏳ Rate limit hit, waiting ${waitMs}ms before retry ${attempt + 1}...`);
                        await new Promise(resolve => setTimeout(resolve, waitMs));
                        continue; // Retry
                    } else {
                        throw new Error(`Rate limit exceeded after ${MAX_RETRIES} attempts`);
                    }
                }

                // Other HTTP errors
                if (attempt < MAX_RETRIES) {
                    const backoffMs = 2000 * Math.pow(2, attempt - 1); // 2s, 4s, 8s
                    console.log(`HTTP ${groqResponse.status} error, retrying in ${backoffMs}ms...`);
                    await new Promise(resolve => setTimeout(resolve, backoffMs));
                    continue;
                } else {
                    throw new Error(`Groq API failed: ${groqResponse.status} - ${errorText}`);
                }
            }

            // Success!
            console.log(`✓ Groq API call successful on attempt ${attempt}`);
            break;

        } catch (error) {
            lastError = error;
            console.error(`Groq API attempt ${attempt} failed:`, error.message);

            if (attempt < MAX_RETRIES) {
                const backoffMs = 2000 * Math.pow(2, attempt - 1);
                console.log(`Retrying in ${backoffMs}ms...`);
                await new Promise(resolve => setTimeout(resolve, backoffMs));
            } else {
                throw error;
            }
        }
    }

    if (!groqResponse || !groqResponse.ok) {
        throw lastError || new Error('Groq API call failed after all retries');
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
