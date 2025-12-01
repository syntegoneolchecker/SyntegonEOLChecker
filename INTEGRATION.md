# Integrating Scraping Service with Netlify Function

## Overview

The EOL check function will use a two-tier approach:

1. **Primary:** Tavily API (fast, efficient, works for most sites)
2. **Fallback:** Render.com scraping service (slower, handles dynamic sites and bot detection)

## Strategy

```
Tavily Search
    ↓
Get URLs
    ↓
Check if Tavily content is valid (not 404, has useful content)
    ↓
    Valid? → Use Tavily content
    ↓
    Invalid? → Scrape with Render.com
    ↓
Send to LLM
```

## Implementation Plan

### 1. Detect Invalid Tavily Results

Add a function to detect soft 404s and empty content:

```javascript
function isValidContent(content) {
    if (!content || content.length < 200) {
        return false; // Too short to be useful
    }

    // Detect 404 pages
    const soft404Indicators = [
        'PAGE NOT FOUND',
        'Error404',
        'ページが見つかりませんでした',
        '申し訳ございませんが、ご指定のページが見つかりませんでした',
        '404 Not Found',
        'Page Not Found'
    ];

    // Check if content is mostly error messages
    const indicatorCount = soft404Indicators.filter(indicator =>
        content.includes(indicator)
    ).length;

    // If multiple indicators present, likely a 404
    if (indicatorCount >= 2) {
        return false;
    }

    return true;
}
```

### 2. Add Scraping Service Integration

Add function to call the Render.com service:

```javascript
async function scrapeWithService(url) {
    const scrapingServiceUrl = process.env.SCRAPING_SERVICE_URL;

    if (!scrapingServiceUrl) {
        console.warn('SCRAPING_SERVICE_URL not configured');
        return null;
    }

    try {
        console.log(`Scraping ${url} with external service...`);

        const response = await fetch(`${scrapingServiceUrl}/scrape`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ url }),
            timeout: 90000 // 90 second timeout for cold starts
        });

        if (!response.ok) {
            console.error(`Scraping service error: ${response.status}`);
            return null;
        }

        const result = await response.json();

        if (result.success && result.content) {
            console.log(`Successfully scraped ${url} (${result.contentLength} chars)`);
            return result.content;
        }

        return null;
    } catch (error) {
        console.error(`Scraping service failed for ${url}:`, error.message);
        return null;
    }
}
```

### 3. Modify Result Processing

Update the result processing loop:

```javascript
const searchContext = [];

for (let index = 0; index < relevantResults.length; index++) {
    const result = relevantResults[index];
    let rawContent = result.raw_content || '';

    // Check if Tavily content is valid
    if (!isValidContent(rawContent)) {
        console.warn(`Result #${index + 1} has invalid content (404 or too short), attempting scrape...`);

        // Try scraping with Render.com service
        const scrapedContent = await scrapeWithService(result.url);

        if (scrapedContent && isValidContent(scrapedContent)) {
            console.log(`Successfully replaced invalid Tavily content with scraped content`);
            rawContent = scrapedContent;
        } else {
            console.warn(`Scraping also failed, skipping result #${index + 1}`);
            continue; // Skip this result entirely
        }
    }

    // Process tables in the content
    let processedContent = processTablesInContent(rawContent);

    // Filter out tables that don't contain the product model name
    processedContent = filterIrrelevantTables(processedContent, model);

    // Smart truncation
    if (processedContent.length > MAX_CONTENT_LENGTH) {
        processedContent = smartTruncate(processedContent, MAX_CONTENT_LENGTH, model);
    }

    searchContext.push(`Result #${index + 1}
URL: ${result.url}
Content:
${processedContent}`);
}

const searchContextString = searchContext.join('\n\n---\n\n');
```

### 4. Environment Variable Setup

In Netlify:
1. Go to **Site settings** → **Environment variables**
2. Add:
   - Key: `SCRAPING_SERVICE_URL`
   - Value: `https://your-service.onrender.com`

## Performance Considerations

### Cold Starts
- First request after 15 min inactivity: **30-60 seconds**
- Subsequent requests: **5-10 seconds**
- Netlify function timeout: Default 10 seconds (free), 26 seconds (paid)

### Recommendation
If using free Netlify tier, you might see timeouts on cold starts. Options:
1. Keep scraping service warm with periodic health pings
2. Upgrade Netlify to Pro for 26-second timeout
3. Handle timeout gracefully (mark as UNKNOWN, allow retry)

### Batch Scraping
For multiple URLs, use the `/scrape-batch` endpoint:

```javascript
async function scrapeMultipleUrls(urls) {
    const scrapingServiceUrl = process.env.SCRAPING_SERVICE_URL;

    const response = await fetch(`${scrapingServiceUrl}/scrape-batch`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ urls }),
        timeout: 120000 // 2 minutes for batch
    });

    const result = await response.json();
    return result.results;
}
```

## Error Handling

Always have fallbacks:

```javascript
// Try Tavily
if (!isValidContent(tavilyContent)) {
    // Try scraping
    scrapedContent = await scrapeWithService(url);

    if (!scrapedContent) {
        // Both failed - return UNKNOWN
        return {
            status: 'UNKNOWN',
            explanation: 'Unable to retrieve product information'
        };
    }
}
```

## Testing

Test the integration locally:

1. Start scraping service locally:
   ```bash
   cd scraping-service
   npm install
   npm start
   ```

2. Set env var:
   ```bash
   export SCRAPING_SERVICE_URL=http://localhost:3000
   ```

3. Run Netlify dev:
   ```bash
   netlify dev
   ```

4. Test EOL check with a product on MISUMI

## Next Steps

Would you like me to:
1. Implement the integration in `check-eol.js`?
2. Create a test script to verify the scraping service?
3. Add monitoring/logging improvements?
