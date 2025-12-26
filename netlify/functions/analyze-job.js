// Run LLM analysis on fetched results
const { getJob, saveFinalResult, updateJobStatus } = require('./lib/job-storage');
const { processTablesInContent, filterIrrelevantTables, smartTruncate } = require('./lib/content-truncator');
const RE2 = require('re2');
const logger = require('./lib/logger');

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

        logger.info(`Groq tokens remaining: ${remainingTokens}, reset in: ${resetSeconds || 'N/A'}s`);

        return {
            available: remainingTokens > 500, // Need at least 500 tokens for analysis
            remainingTokens,
            resetSeconds: resetSeconds || 0
        };
    } catch (error) {
        logger.error('Failed to check Groq token availability:', error.message);
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

    const invocationTimestamp = new Date().toISOString();

    try {
        const { jobId } = JSON.parse(event.body);

        logger.info(`[ANALYZE DEBUG] ===== ANALYSIS START ===== Time: ${invocationTimestamp}`);
        logger.info(`[ANALYZE DEBUG] Starting analysis for job ${jobId}`);

        const job = await getJob(jobId, context);

        if (!job) {
            logger.warn(`[ANALYZE DEBUG] Job ${jobId} not found`);
            return {
                statusCode: 404,
                body: JSON.stringify({ error: 'Job not found' })
            };
        }

        logger.info(`[ANALYZE DEBUG] Job retrieved. Current status: ${job.status}, URLs: ${job.urls?.length}, Completed: ${job.urls?.filter(u => u.status === 'complete').length}`);

        // Update status to analyzing
        logger.info(`[ANALYZE DEBUG] Updating job status to 'analyzing'`);
        await updateJobStatus(jobId, 'analyzing', null, context);
        logger.info(`[ANALYZE DEBUG] Job status updated to 'analyzing'`);

        // FIX: Check Groq token availability BEFORE analysis
        const tokenCheck = await checkGroqTokenAvailability();
        if (!tokenCheck.available && tokenCheck.resetSeconds > 0) {
            const waitMs = Math.ceil(tokenCheck.resetSeconds * 1000) + 1000; // Add 1s buffer
            logger.info(`⏳ Groq tokens low (${tokenCheck.remainingTokens}), waiting ${waitMs}ms for rate limit reset...`);
            await new Promise(resolve => setTimeout(resolve, waitMs));
            logger.info(`✓ Wait complete, proceeding with analysis`);
        }

        // Format results for LLM
        const searchContext = formatResults(job);

        // Call Groq with retry logic
        const analysis = await analyzeWithGroq(job.maker, job.model, searchContext);

        // Save final result
        await saveFinalResult(jobId, analysis, context);

        logger.info(`Analysis complete for job ${jobId}`);

        return {
            statusCode: 200,
            body: JSON.stringify({ success: true, result: analysis })
        };

    } catch (error) {
        logger.error('Analysis error:', error);

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
            logger.info(`Exception thrown: ${e}`);
        }

        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};

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
                logger.info(`Truncating URL #${index + 1} content from ${processedContent.length} to ${MAX_CONTENT_LENGTH} chars`);
                processedContent = smartTruncate(processedContent, MAX_CONTENT_LENGTH, job.model);
            }

            resultSection += `\nFULL PAGE CONTENT:\n`;
            resultSection += `${processedContent}\n`;
        } else {
            resultSection += `\n[Note: Could not fetch full content - using snippet only]\n`;
        }

        resultSection += '\n========================================\n';

        if (totalChars + resultSection.length > MAX_TOTAL_CHARS) {
            logger.info(`Stopping at URL #${index + 1} - total char limit (${MAX_TOTAL_CHARS}) would be exceeded`);
            formatted += `\n[Note: Remaining URLs omitted to stay within token limits]\n`;
            break;
        }

        formatted += resultSection;
        totalChars += resultSection.length;
    }

    logger.info(`Final formatted content: ${totalChars} characters (~${Math.round(totalChars / 4)} tokens)`);
    return formatted.trim();
}

// Analyze with Groq
class GroqAnalyzer {
    MAX_RETRIES = 3;
    BASE_URL = 'https://api.groq.com/openai/v1/chat/completions';

    async analyze(maker, model, searchContext) {
        const prompt = this.buildPrompt(maker, model, searchContext);
        logger.info('This is the entire prompt:\n' + prompt);

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
        logger.error(`Groq API error (attempt ${attempt}):`, errorText);

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
        logger.error(this.formatDailyLimitMessage(retryInfo.message));

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

        logger.error(`Groq API attempt ${attempt} failed:`, error.message);

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
        logger.info(`⏳ Waiting ${ms}ms...`);
        await new Promise(resolve => setTimeout(resolve, ms));
    }

    async processResponse(response) {
        const groqData = await response.json();
        logger.info('Groq response:', JSON.stringify(groqData));

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
            logger.error('Daily token limit error handled');
        } else {
            logger.error('Groq API analysis failed:', error.message);
        }
    }
}

// Usage
async function analyzeWithGroq(maker, model, searchContext) {
    const analyzer = new GroqAnalyzer();
    return analyzer.analyze(maker, model, searchContext);
}