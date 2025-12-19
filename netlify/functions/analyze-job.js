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
        const remainingTokens = Number.parseInt(response.headers.get('x-ratelimit-remaining-tokens') || '0');

        let resetSeconds = null;
        if (resetTokens) {
            const match = /^([\d.]+)s?$/.exec(resetTokens);
            
            if (match) {
                resetSeconds = Number.parseFloat(match[1]);
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

// Parse time string (e.g., "7m54.336s", "2h30m15s") to seconds
function parseTimeToSeconds(timeStr) {
    let totalSeconds = 0;

    // Extract hours
    const hoursMatch = timeStr.match(/(\d{1,2})h/);  // Max 2 digits for hours
    if (hoursMatch) {
        totalSeconds += Number.parseInt(hoursMatch[1]) * 3600;
    }

    // Extract minutes
    const minutesMatch = timeStr.match(/(\d{1,2})m/);  // Max 2 digits for minutes
    if (minutesMatch) {
        totalSeconds += Number.parseInt(minutesMatch[1]) * 60;
    }

    // Extract seconds (with optional decimal)
    const secondsMatch = timeStr.match(/(\d{1,2}(?:\.\d{1,3})?)s/);  // Reasonable decimal precision
    if (secondsMatch) {
        totalSeconds += Number.parseFloat(secondsMatch[1]);
    }

    return totalSeconds;
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

            // For daily limit errors, we want to update the job status but NOT save any analysis
            // This ensures no database changes are made for this product
            if (error.isDailyLimit) {
                // Store retrySeconds in job metadata so frontend can show countdown
                await updateJobStatus(jobId, 'error', error.message, context, {
                    isDailyLimit: true,
                    retrySeconds: error.retrySeconds || null
                });

                // Return immediately with a clear message - no retries, no timeouts
                return {
                    statusCode: 429,
                    body: JSON.stringify({
                        error: error.message,
                        isDailyLimit: true,
                        retrySeconds: error.retrySeconds || null,
                        message: 'Daily Groq token limit reached (rolling 24h window). Analysis cancelled. Tokens gradually recover as they age out of the 24-hour window.'
                    })
                };
            }

            // For other errors, update status as normal
            await updateJobStatus(jobId, 'error', error.message, context);
        } catch (e) {
            console.log(`Exception thrown: ${e}`);
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

    for (const element of lines) {
        const line = element;
        const isTableLine = isTableRow(line);
        const isSeparatorLine = isTableSeparator(line);

        if (isTableLine || (inTable && isSeparatorLine)) {
            processTableStart(inTable, processedLines);
            inTable = true;
            tableLines.push(line);
            processedLines.push(line);
        } else {
            processTableEnd(inTable, tableLines, processedLines);
            inTable = false;
            tableLines = [];
            processedLines.push(line);
        }
    }

    // Handle any table that ends at the end of content
    processTableEnd(inTable, tableLines, processedLines);

    return processedLines.join('\n');
}

function isTableRow(line) {
    const trimmed = line.trim();
    const pipeCount = (trimmed.match(/\|/g) || []).length;
    return trimmed.includes('|') && pipeCount >= 2;
}

function isTableSeparator(line) {
    const trimmed = line.trim();
    return /^[\s\-|]+$/.test(trimmed) && trimmed.length > 0;
}

function processTableStart(inTable, processedLines) {
    if (!inTable) {
        processedLines.push('\n=== TABLE START ===');
    }
}

function processTableEnd(inTable, tableLines, processedLines) {
    if (inTable && tableLines.length > 0) {
        processedLines.push('=== TABLE END ===\n');
    }
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

    filteredContent = filteredContent.replaceAll(/\n{3,}/g, '\n\n');

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

    const { tableStart, tableEnd } = findTableBoundaries(lines);
    if (!isValidTable(tableStart, tableEnd)) return tableContent;

    const productRows = findProductRows(lines, tableStart, tableEnd, productLower);
    if (productRows.length === 0) return tableContent;

    const rowsToKeep = determineRowsToKeep(lines, tableStart, tableEnd, productRows, ROWS_BEFORE, ROWS_AFTER);
    const truncatedTable = buildTruncatedTable(lines, tableStart, tableEnd, rowsToKeep);

    return truncatedTable;
}

function findTableBoundaries(lines) {
    let tableStart = -1;
    let tableEnd = -1;
    
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('=== TABLE START ===')) tableStart = i;
        if (lines[i].includes('=== TABLE END ===')) tableEnd = i;
    }
    
    return { tableStart, tableEnd };
}

function isValidTable(tableStart, tableEnd) {
    return tableStart !== -1 && tableEnd !== -1;
}

function findProductRows(lines, tableStart, tableEnd, productLower) {
    const productRows = [];
    for (let i = tableStart + 1; i < tableEnd; i++) {
        if (lines[i].toLowerCase().includes(productLower)) {
            productRows.push(i);
        }
    }
    return productRows;
}

function determineRowsToKeep(lines, tableStart, tableEnd, productRows, ROWS_BEFORE, ROWS_AFTER) {
    const rowsToKeep = new Set();

    // Always keep header row
    if (tableStart + 1 < tableEnd) {
        rowsToKeep.add(tableStart + 1);
    }

    // Keep rows around each product mention
    productRows.forEach(productRow => {
        addRowsAroundProduct(rowsToKeep, tableStart, tableEnd, productRow, ROWS_BEFORE, ROWS_AFTER);
    });

    return rowsToKeep;
}

function addRowsAroundProduct(rowsToKeep, tableStart, tableEnd, productRow, ROWS_BEFORE, ROWS_AFTER) {
    const startRow = Math.max(tableStart + 1, productRow - ROWS_BEFORE);
    const endRow = Math.min(tableEnd - 1, productRow + ROWS_AFTER);
    
    for (let i = startRow; i <= endRow; i++) {
        rowsToKeep.add(i);
    }
}

function buildTruncatedTable(lines, tableStart, tableEnd, rowsToKeep) {
    const keptLines = [];
    keptLines.push(lines[tableStart]); // TABLE START marker

    let lastKeptRow = tableStart;
    const sortedRows = Array.from(rowsToKeep).sort((a, b) => a - b);
    
    sortedRows.forEach(row => {
        // Add ellipsis if we skipped rows
        if (row - lastKeptRow > 1) {
            keptLines.push('| ... | ... |');
        }
        keptLines.push(lines[row]);
        lastKeptRow = row;
    });

    keptLines.push(lines[tableEnd]); // TABLE END marker

    const result = keptLines.join('\n');
    logTruncationStats(lines.length, keptLines.length);
    return result;
}

function logTruncationStats(originalRowCount, truncatedRowCount) {
    console.log(`Truncated table from ${originalRowCount} rows to ${truncatedRowCount} rows`);
}

// Helper: Extract sections containing product mentions with context
function extractProductSections(content, productModel, maxLength) {
    const CONTEXT_CHARS = 250;
    
    if (!content) return content;
    
    const mentions = findAllProductMentions(content, productModel);
    if (mentions.length === 0) {
        return simpleProductSectionsTruncate(content, maxLength);
    }

    console.log(`Found ${mentions.length} product mentions, extracting sections`);
    
    const sections = extractSectionsWithContext(content, productModel, mentions, CONTEXT_CHARS);
    const combined = combineSections(sections);
    
    return truncateToMaxLength(combined, sections, maxLength);
}

function findAllProductMentions(content, productModel) {
    const contentLower = content.toLowerCase();
    const productLower = productModel.toLowerCase();
    const mentions = [];
    
    let index = contentLower.indexOf(productLower);
    while (index !== -1) {
        mentions.push(index);
        index = contentLower.indexOf(productLower, index + 1);
    }
    
    return mentions;
}

function extractSectionsWithContext(content, productModel, mentions, contextChars) {
    return mentions.map(mentionIndex => {
        const section = extractSectionAroundMention(content, mentionIndex, productModel.length, contextChars);
        return formatSectionWithEllipsis(content, section, mentionIndex, contextChars);
    });
}

function extractSectionAroundMention(content, mentionIndex, productLength, contextChars) {
    const start = Math.max(0, mentionIndex - contextChars);
    const end = Math.min(content.length, mentionIndex + productLength + contextChars);
    return content.substring(start, end);
}

function formatSectionWithEllipsis(content, section, mentionIndex, contextChars) {
    const start = Math.max(0, mentionIndex - contextChars);
    const end = Math.min(content.length, mentionIndex + contextChars);
    
    let formatted = section;
    if (start > 0) formatted = '...' + formatted;
    if (end < content.length) formatted = formatted + '...';
    
    return formatted;
}

function combineSections(sections) {
    return sections.join('\n\n[...]\n\n');
}

function truncateToMaxLength(combined, sections, maxLength) {
    if (combined.length <= maxLength) {
        return combined;
    }
    
    return prioritizeSectionsByFirstMentions(sections, maxLength);
}

function prioritizeSectionsByFirstMentions(sections, maxLength) {
    let result = '';
    
    for (const section of sections) {
        if (result.length + section.length + 20 > maxLength) {
            break;
        }
        
        if (result.length > 0) {
            result += '\n\n[...]\n\n';
        }
        
        result += section;
    }
    
    return result;
}

function simpleProductSectionsTruncate(content, maxLength) {
    if (content.length <= maxLength) {
        return content;
    }
    
    return content.substring(0, maxLength - 3) + '...';
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
        resultSection += `URL: ${result?.url || urlInfo.url}\n`;
        resultSection += `Snippet: ${urlInfo.snippet}\n`;

        if (result?.fullContent) {
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
class GroqAnalyzer {
    MAX_RETRIES = 3;
    BASE_URL = 'https://api.groq.com/openai/v1/chat/completions';

    async analyze(maker, model, searchContext) {
        const prompt = this.buildPrompt(maker, model, searchContext);
        console.log('This is the entire prompt:\n' + prompt);

        try {
            const response = await this.callWithRetry(prompt);
            return this.processResponse(response);
        } catch (error) {
            this.handleError(error);
            throw error;
        }
    }

    buildPrompt(maker, model, searchContext) {
        return `TASK: Determine if the product "${model}" by ${maker} is discontinued (end-of-life).

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
        - **CRITICAL: When provided with a product specification page with no indication of discontinuation, assume that the product is ACTIVE**
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
    }

    async callWithRetry(prompt) {
        for (let attempt = 1; attempt <= this.MAX_RETRIES; attempt++) {
            try {
                const response = await this.makeRequest(prompt);
                if (response.ok) return response;
                await this.handleFailedRequest(response, attempt);
            } catch (error) {
                await this.handleRetry(error, attempt);
            }
        }
        throw new Error('Groq API call failed after all retries');
    }

    async makeRequest(prompt) {
        return fetch(this.BASE_URL, {
            method: 'POST',
            headers: this.getHeaders(),
            body: JSON.stringify(this.getRequestBody(prompt))
        });
    }

    getHeaders() {
        return {
            'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
            'Content-Type': 'application/json'
        };
    }

    getRequestBody(prompt) {
        return {
            model: 'openai/gpt-oss-120b',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0,
            max_completion_tokens: 8192,
            top_p: 1,
            stream: false,
            reasoning_effort: 'low',
            response_format: { type: 'json_object' },
            stop: null,
            seed: 1
        };
    }

    async handleFailedRequest(response, attempt) {
        const errorText = await response.text();
        console.error(`Groq API error (attempt ${attempt}):`, errorText);

        if (response.status === 429) {
            if (errorText.includes('tokens per day (TPD)')) {
                throw this.createDailyLimitError(errorText);
            }
            await this.handleRateLimit(response, attempt);
        }
        
        throw new Error(`Groq API failed: ${response.status} - ${errorText}`);
    }

    async handleRateLimit(response, attempt) {
        if (attempt < this.MAX_RETRIES) {
            const waitTime = this.calculateWaitTime(response);
            await this.wait(waitTime);
            throw new Error('Rate limit - retrying');
        }
        throw new Error(`Rate limit exceeded after ${this.MAX_RETRIES} attempts`);
    }

    calculateWaitTime(response) {
        const resetSeconds = this.extractResetTime(response);
        return Math.ceil(resetSeconds * 1000) + 2000;
    }

    extractResetTime(response) {
        const resetTokens = response.headers.get('x-ratelimit-reset-tokens');
        if (!resetTokens) return 60;
        const match = /^([\d.]+)s?$/.exec(resetTokens);
        return match ? Number.parseFloat(match[1]) : 60;
    }

    createDailyLimitError(errorText) {
        const retryInfo = this.extractRetryTime(errorText);
        console.error(this.formatDailyLimitMessage(retryInfo.message));
        
        const error = new Error(
            `Daily token limit reached (rolling 24h window). Analysis cancelled.${retryInfo.message}`
        );
        error.isDailyLimit = true;
        error.retrySeconds = retryInfo.seconds;
        return error;
    }

    formatDailyLimitMessage(additionalMessage) {
        return `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🚫 GROQ DAILY TOKEN LIMIT REACHED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
The daily token limit of 200,000 tokens has been reached.
Groq uses a rolling 24-hour window - tokens gradually recover as they age out.
${additionalMessage || ''}
EOL check cancelled - no database changes will be made.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
    }

    extractRetryTime(errorText) {
        const retryMatch = /Please try again in ((?:\d+h)?(?:\d+m)?(?:\d+(?:\.\d+)?s))/.exec(errorText);
        if (!retryMatch) return { message: '', seconds: null };
        
        const timeStr = retryMatch[1];
        return {
            message: ` Tokens will recover in approximately ${timeStr}.`,
            seconds: parseTimeToSeconds(timeStr)
        };
    }

    async handleRetry(error, attempt) {
        if (error.isDailyLimit) throw error;
        
        console.error(`Groq API attempt ${attempt} failed:`, error.message);
        
        if (attempt < this.MAX_RETRIES) {
            await this.wait(this.calculateBackoffTime(attempt));
            throw new Error('Retrying after error');
        }
        throw error;
    }

    calculateBackoffTime(attempt) {
        return 2000 * Math.pow(2, attempt - 1);
    }

    async wait(ms) {
        console.log(`⏳ Waiting ${ms}ms...`);
        await new Promise(resolve => setTimeout(resolve, ms));
    }

    async processResponse(response) {
        const groqData = await response.json();
        console.log('Groq response:', JSON.stringify(groqData));
        
        const generatedText = this.extractGeneratedText(groqData);
        const parsedResult = this.parseResponseText(generatedText);
        this.validateResult(parsedResult);
        
        parsedResult.rateLimits = this.extractRateLimits(response);
        return parsedResult;
    }

    extractGeneratedText(groqData) {
        if (groqData.choices?.[0]?.message?.content) {
            return groqData.choices[0].message.content;
        }
        throw new Error('Unexpected response format from LLM');
    }

    parseResponseText(text) {
        try {
            return JSON.parse(text);
        } catch (error) {
            return this.extractJsonFromText(text, error);
        }
    }

    extractJsonFromText(text, parseError) {
        const MAX_SIZE = 8192 * 5;
        if (text.length > MAX_SIZE) {
            throw new Error('Response exceeds maximum expected size');
        }
        
        const jsonRegex = RE2.fromString(String.raw`\{[^}]*?(?:\{[^}]*?}[^}]*?)*}`);
        const jsonMatch = jsonRegex.exec(text);
        
        if (jsonMatch) {
            try {
                return JSON.parse(jsonMatch[0]);
            } catch (extractionError) {
                throw new Error(
                    `Failed to parse extracted JSON: ${extractionError.message} ` +
                    `(Original error: ${parseError.message})`
                );
            }
        }
        
        throw new Error(`No JSON object found in response. Original parse error: ${parseError.message}`);
    }

    validateResult(result) {
        if (!result.status || !result.explanation || !result.successor) {
            throw new Error('Invalid analysis result structure');
        }
    }

    extractRateLimits(response) {
        return {
            remainingTokens: response.headers.get('x-ratelimit-remaining-tokens'),
            limitTokens: response.headers.get('x-ratelimit-limit-tokens'),
            resetSeconds: this.extractResetTime(response)
        };
    }

    handleError(error) {
        if (error.isDailyLimit) {
            console.error('Daily token limit error handled');
        } else {
            console.error('Groq API analysis failed:', error.message);
        }
    }
}

// Usage
async function analyzeWithGroq(maker, model, searchContext) {
    const analyzer = new GroqAnalyzer();
    return analyzer.analyze(maker, model, searchContext);
}