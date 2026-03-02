# SyntegonEOLChecker Architecture

## Overview

This is a completely free EOL (End-of-Life) checker application built entirely on free tiers of various services. The architecture is specifically designed around the constraints and limitations of these free tiers.

## Design Constraints

### Free Tier Limitations

All architectural decisions are driven by these **hard limits**:

| Service                       | Limit                                                            | Impact on Architecture                                                                                                                                                             |
| ----------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Netlify Functions**         | 30s timeout (regular)<br/>15min timeout (background)             | - Polling instead of long-running tasks<br/>- Chain multiple background functions for long operations                                                                              |
| **Groq LLM**                  | 200,000 tokens/day<br/>8,000 tokens/minute<br/>(rolling windows) | - Smart content truncation (`analyze-job.js`)<br/>- Token availability checks before analysis<br/>- Retry logic with exponential backoff                                        |
| **SerpAPI Search**            | 250 searches/month                                               | - 1 search per product, only 2 search results used due to LLM token constraints<br/>- Manufacturer-specific direct URLs to skip search<br/>- 20 product limit on daily auto-checks |
| **BrowserQL**                 | 1,000 tokens/month<br/>(1 token = 30 seconds)                    | - Use ONLY for Cloudflare-protected sites<br/>- Puppeteer (free) for everything else                                                                                               |
| **Render (Scraping Service)** | 512MB RAM<br/>750 hours/month                                    | - Aggressive memory management<br/>- Self-restart when approaching limit<br/>- Sequential scraping (no concurrency)                                                                |
| **Netlify Blobs**             | Limited storage                                                  | - Job cleanup after 24 hours (1440 minutes)                                                                                                    |
| **Supabase**                  | Limited storage                                                  | - Log cleanup job running every 7 days                                                                                                                                             |

### Key Architectural Decisions

#### 1. **Manufacturer-Specific URL Strategies** (`initialize-job.js`)

Instead of always using SerpAPI search (1 search per product, limited to 250/month), the application uses hardcoded URL patterns for manufacturers with many database entries:

```javascript
// Example: SMC has consistent URL pattern
case 'SMC':
    return {
        url: `https://www.smcworld.com/webcatalog/s3s/ja-jp/detail/?partNumber=${model}`,
        scrapingMethod: 'render'
    };
```

**Benefits**:

- Saves SerpAPI searches for a large amount of products
- Slightly faster (no search delay)
- More reliable information (manufacturer site or other certified source)

**Trade-off**:

- Manual maintenance required (manufacturer sites could change layout or URL structure)
- Can only be implemented for manufacturers with consistent and predictable locations for product information

#### 2. **BrowserQL or Puppeteer?**

```
┌─────────────────────────────────────────┐
│ Site has Cloudflare protection?         │
│ ├─ YES → BrowserQL (limited tokens)     │
│ └─ NO  → Puppeteer (unlimited)          │
└─────────────────────────────────────────┘
```

**BrowserQL** (`lib/browserql-scraper.js`):

- ✅ Bypasses Cloudflare
- ❌ Limited to 1000 tokens/month
- **Use cases**: Oriental Motor, NTN (on motion.com)

**Puppeteer** (Render scraping service):

- ✅ "Free indefinitely" with expected usage
- ❌ Blocked by Cloudflare
- **Use cases**: All the other manufacturers

#### 3. **Groq Token Optimization**

**Problem**: 200,000 tokens/day limit means ~25-30 products per day (more if less Groq tokens are used per request)

**Solutions**:

1. **Smart Content Truncation** (`analyze-job.js`):
    - Remove tables that don't mention the product
    - Extract only sections around product mentions
    - Truncate each URL to 6,500 characters, total limit 13,000 characters
    - Mix of Hiragana, Katakana, Kanji and other characters makes a direct translation of characters to Groq tokens difficult
      Solution -> Dynamic truncation with retry logic that reduces characters further if token limit is breached

2. **Token Availability Checks** (`analyze-job.js`):

    ```javascript
    const tokenCheck = await checkGroqTokenAvailability();
    if (!tokenCheck.available) {
    	await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    ```

3. **Daily Limit Handling** (`analyze-job.js`):
    - Parse "7m54.336s" format from error message
    - Show countdown to user
    - Cancel check (don't waste function invocations)

#### 4. **Memory Management in Render** (`scraping-service/index.js`)

**Problem**: 512MB RAM limit, Puppeteer uses 200-300MB per instance

**Solutions**:

1. **Sequential Processing** (lines 86-93):

    ```javascript
    let puppeteerQueue = Promise.resolve();
    function enqueuePuppeteerTask(task) {
    	const result = puppeteerQueue.then(task, task);
    	puppeteerQueue = result.catch(() => {});
    	return result;
    }
    ```

    - Only 1 browser instance at a time
    - Prevents memory spikes

2. **Aggressive Cleanup** (lines 906-927):
    - Close browser IMMEDIATELY after scraping
    - Null out large variables
    - Force garbage collection (`--expose-gc` flag)

3. **Self-Restart Safety Net** (lines 445-464):
    - Monitor RSS memory usage
    - Restart at 450MB (62MB buffer before OOM)
    - Render automatically restarts the service

#### 5. **Job Storage & Cleanup** (`lib/job-storage.js`)

**Problem**: Netlify Blobs has limited storage

**Solution**:

- Jobs deleted 24 hours (1440 minutes) after completion
- Cleanup runs on every new job creation

```javascript
// Automatic cleanup
async function createJob(maker, model, context) {
    cleanupOldJobs(context).catch(...); // Fire-and-forget
    // ... create new job
}
```

#### 6. **Polling System**

Since Netlify functions have a 30 second time limit, synchronous communication with the Render scraping service is not possible since website scraping often takes longer than 30 seconds.

**Current Solution**:
- Requests from Netlify to Render are made asynchronously
- Transition between the stages of an EOL check (creation, scraping, analysis, completion) are reflected in the job status
- Frontend polls job status every 2 seconds and triggers transition between stages
- Max 60 attempts (2 minutes)

## Data Flow

### Manual EOL Check

```
[User clicks "Check EOL"]
    ↓
[initialize-job] Creates job, performs SerpAPI search (or uses direct URL)
    ↓
[job-status] Frontend polls every 2s
    ↓
[fetch-url] Triggers Render scraping (or BrowserQL)
    ↓
[scraping-callback] Render service sends results back
    ↓
[analyze-job] Groq analyzes content (with token checks)
    ↓
[job-status] Frontend gets final result
    ↓
[Job cleanup after 24 hours]
```

### Automatic Daily Check (21:00 GMT+9)

```
[scheduled-eol-check] Netlify cron triggers daily
    ↓
[auto-eol-check-background] Finds oldest unchecked product
    ↓
[Checks SerpAPI credits] Must have 30+ credits (so users can still use the manual checking)
    ↓
[initialize-job] → [fetch-url] → [analyze-job] (same as manual)
    ↓
[Chains next check] If time remaining & credits available
    ↓
[Max 20 checks per day]
```

## Adding a New Manufacturer

### When to Add Direct URL Strategy

Add a manufacturer to the `getManufacturerUrl()` function in `initialize-job.js` if:

- Manufacturer has **10+ products** in database
- URL pattern is **predictable** (e.g., uses model number in URL) 
- ---OR--- 
- Product URL can be reliably found/constructed through **website navigation**

### Steps

1. Test if the majority of products of the new manufacturer strategy has available EOL information on the chosen website
2. Theorize a route on how the product information URL can be found/constructed
3. Add a new manufacturer case to the switch statement
    - Implement the website navigation (if necessary) and find/construct the product URL using the name of the product in the process
    - Scrape the product URL you constructed through the Render scraping service or through Browserless (if manufacturer site is Cloudflare protected)
4. Test the new manufacturer case by EOL checking multiple products by the manufacturer in the Syntegon EOL Checker

**Look at the existing manufacturer cases for inspiration if necessary.**

## Current Token Usage (Estimated)

| Operation                      | SerpAPI Tokens | Groq Tokens | BrowserQL Tokens |
| ------------------------------ | -------------- | ----------- | ---------------- |
| Manual check (SerpAPI)         | 1              | ~5,000      | 0                |
| Manual check (Direct URL)      | 0              | ~5,000      | 0                |
| Manual check (BrowserQL)       | 0              | ~5,000      | 1                |
| Daily auto-check (20 products) | 0-20           | ~100,000    | 0-20             |

## Common Issues & Solutions

| Issue                       | Cause                                                              | Solution                                    |
| --------------------------- | ------------------------------------------------------------------ | ------------------------------------------- |
| "Daily token limit reached" | Groq 200K/day limit hit                                            | Wait for tokens to recover (rolling window) |
| Job timeout after 2min      | Render cold start + slow site or unforseen issues during EOL check | Retry (first request wakes Render)          |
| Memory limit restart        | Large page or PDF                                                  | Expected behavior, service auto-restarts    |
| "No SerpAPI credits"        | Used 250 searches this month                                       | Wait for monthly reset or add direct URLs   |
| BrowserQL quota exhausted   | Used 1000 tokens this month                                        | Wait for monthly reset or reduce usage      |

## Future Improvements (If Free Tiers Change)

1. **If Groq increases tokens/minute limit**:
    - Remove aggressive content truncation
    - Check more than 2 URLs per search

2. **If Render increases RAM**:
    - Enable concurrent scraping (2-3 browsers)
    - Remove memory restart mechanism

3. **If SerpAPI increases limit**:
    - Increase number of daily checks (Groq daily limit still exists!)

4. **If BrowserQL increases tokens**:
    - Use for more manufacturers
    - Reduce Puppeteer usage
