# SyntegonEOLChecker Architecture

## Overview

This is a completely free EOL (End-of-Life) checker application built entirely on free tiers of various services. The architecture is specifically designed around the constraints and limitations of these free tiers.

## Design Constraints

### Free Tier Limitations

All architectural decisions are driven by these **hard limits**:

| Service | Limit | Impact on Architecture |
|---------|-------|------------------------|
| **Netlify Functions** | 30s timeout (regular)<br/>15min timeout (background) | - Polling instead of long-running tasks<br/>- Chain multiple background functions for long operations |
| **Groq LLM** | 200,000 tokens/day<br/>8,000 tokens/minute<br/>(rolling windows) | - Smart content truncation (`analyze-job.js:235-467`)<br/>- Token availability checks before analysis<br/>- Retry logic with exponential backoff |
| **Tavily Search** | 1,000 tokens/month | - 2 Tokens per search, only 2 search results used due to LLM Token constraints<br/>- Manufacturer-specific direct URLs to skip search<br/>- 20 product limit on daily auto-checks |
| **BrowserQL** | 1,000 tokens/month<br/>(1 token = 30 seconds) | - Use ONLY for Cloudflare-protected sites<br/>- Puppeteer (free) for everything else |
| **Render (Scraping Service)** | 512MB RAM<br/>750 hours/month | - Aggressive memory management<br/>- Self-restart when approaching limit<br/>- Sequential scraping (no concurrency) |
| **Webshare Proxies** | 1GB bandwidth/month | - Use proxies ONLY when needed (IDEC geo-restriction) |
| **Netlify Blobs** | Limited storage | - Job cleanup after 5 minutes<br/>- No historical data retention |

### Key Architectural Decisions

#### 1. **Manufacturer-Specific URL Strategies** (`initialize-job.js:12-90`)

Instead of always using Tavily search (2 tokens per product), we maintain hardcoded URL patterns for manufacturers with many database entries:

```javascript
// Example: SMC has consistent URL pattern
case 'SMC':
    return {
        url: `https://www.smcworld.com/webcatalog/s3s/ja-jp/detail/?partNumber=${model}`,
        scrapingMethod: 'render'
    };
```

**Benefits**:
- Saves ~1000 Tavily tokens per month for frequently-checked manufacturers
- Faster (no search delay)
- More reliable (direct to manufacturer page)

**Trade-off**:
- Manual maintenance required
- Only works for manufacturers with predictable URL patterns

#### 2. **BrowserQL vs Puppeteer Decision Matrix**

```
┌─────────────────────────────────────────┐
│ Site has Cloudflare protection?        │
│ ├─ YES → BrowserQL (limited tokens)    │
│ └─ NO  → Puppeteer (unlimited)         │
└─────────────────────────────────────────┘
```

**BrowserQL** (`lib/browserql-scraper.js`):
- ✅ Bypasses Cloudflare
- ❌ Limited to 1000 tokens/month
- ❌ Cannot use custom proxies (their proxy is too expensive)
- **Use cases**: Oriental Motor, NTN (on motion.com)

**Puppeteer** (Render scraping service):
- ✅ "Free indefinitely" for our usage
- ✅ Can use custom proxies (Webshare)
- ❌ Blocked by Cloudflare
- **Use cases**: 90% of manufacturers

#### 3. **Groq Token Optimization**

**Problem**: 200,000 tokens/day limit means ~25-30 products max per day

**Solutions**:
1. **Smart Content Truncation** (`analyze-job.js:235-467`):
   - Remove tables that don't mention the product
   - Extract only sections around product mentions
   - Truncate each URL to 6,500 characters
   - Total limit: 13,000 characters (~3,250 tokens)

2. **Token Availability Checks** (`analyze-job.js:93-99`):
   ```javascript
   const tokenCheck = await checkGroqTokenAvailability();
   if (!tokenCheck.available) {
       await new Promise(resolve => setTimeout(resolve, waitMs));
   }
   ```

3. **Daily Limit Handling** (`analyze-job.js:634-664`):
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
- Jobs deleted 5 minutes after completion
- Cleanup runs on every new job creation (opportunistic)
- Logs are separate (not affected by cleanup)

```javascript
// Automatic cleanup
async function createJob(maker, model, context) {
    cleanupOldJobs(context).catch(...); // Fire-and-forget
    // ... create new job
}
```

#### 6. **Polling Instead of WebSocket**

**Why not WebSocket?**
- Netlify Functions don't support persistent connections
- Would need external WebSocket service ($$)

**Current Solution**:
- Frontend polls job status every 2 seconds
- Max 60 attempts (2 minutes)
- Good enough for ~10-20 checks/day volume

#### 7. **IDEC Dual-Site with Proxies** (`scraping-service/index.js:1316-1714`)

**Problem**: IDEC automatically redirects based on IP location. Japanese site has different data than US site.

**Solution**:
- Use 2 Webshare proxies (Japan + USA IPs)
- Try JP site first, fall back to US site
- Only use proxies for this specific manufacturer

```javascript
// Step 1: Try JP proxy
const jpResult = await scrapeIdecSite(jpUrl, jpProxyUrl, 'JP');
if (jpResult.success) return jpResult;

// Step 2: Fall back to US proxy
const usResult = await scrapeIdecSite(usUrl, usProxyUrl, 'US');
```

## Data Flow

### Manual EOL Check

```
[User clicks "Check EOL"]
    ↓
[initialize-job] Creates job, performs Tavily search (or uses direct URL)
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
[Job cleanup after 5min]
```

### Automatic Daily Check (21:00 GMT+9)

```
[scheduled-eol-check] Netlify cron triggers daily
    ↓
[auto-eol-check-background] Finds oldest unchecked product
    ↓
[Checks Tavily credits] Must have 50+ credits
    ↓
[initialize-job] → [fetch-url] → [analyze-job] (same as manual)
    ↓
[Chains next check] If time remaining & credits available
    ↓
[Max 20 checks per day]
```

## Adding a New Manufacturer

### When to Add Direct URL Strategy

Add a manufacturer to `initialize-job.js:12-90` if:
1. ✅ Manufacturer has **10+ products** in database
2. ✅ URL pattern is **predictable** (e.g., uses model number in URL)
3. ✅ Website is **reliable** (not frequently changing)

### Steps

1. **Test the URL Pattern**:
   ```javascript
   // Test with 3-5 different model numbers
   const testModels = ['ABC-123', 'DEF-456', 'GHI-789'];
   testModels.forEach(model => {
       const url = `https://manufacturer.com/product/${model}`;
       // Manually verify URL works
   });
   ```

2. **Determine Scraping Method**:
   - Try Puppeteer first (free)
   - If Cloudflare-protected → BrowserQL (limited tokens)
   - If geo-restricted → Add proxy configuration

3. **Add to Switch Statement**:
   ```javascript
   case 'New Manufacturer':
       return {
           url: `https://.../${encodedModel}`,
           scrapingMethod: 'render' // or 'browserql'
       };
   ```

4. **Test Thoroughly**:
   - Test with 5+ different products
   - Check for edge cases (special characters, long names)
   - Verify token usage (check Tavily dashboard)

## Token Usage Optimization Tips

### Current Token Usage (Estimated)

| Operation | Tavily Tokens | Groq Tokens | BrowserQL Tokens |
|-----------|---------------|-------------|------------------|
| Manual check (Tavily) | 2 | ~5,000 | 0 |
| Manual check (Direct URL) | 0 | ~5,000 | 0 |
| Manual check (BrowserQL) | 0 | ~5,000 | ~0.5 |
| Daily auto-check (20 products) | 0-40 | ~100,000 | 0-10 |

### Maximizing Daily Capacity

**Current**: ~25-30 products/day with Groq limit

**Optimization strategies**:
1. **Manufacturer Direct URLs**: Already implemented, saves Tavily tokens
2. **Content Truncation**: Already aggressive, hard to improve further
3. **Caching**: NOT implemented (same product won't be checked twice in months anyway)
4. **Parallel LLM Requests**: Not possible (rate limit is per-account)

**Bottleneck**: Groq 200,000 tokens/day limit is the hard cap

## Monitoring & Debugging

### Logs to Watch

1. **Netlify Function Logs**:
   - Token usage: `Groq tokens remaining: X, reset in: Ys`
   - Memory warnings: `⚠️  Memory approaching limit: XMB RSS`
   - Job cleanup: `✓ Cleanup complete: deleted X old job(s)`

2. **Render Service Logs**:
   - Memory before/after: `Memory before scrape: RSS=250MB`
   - Restart triggers: `🔄 MEMORY LIMIT REACHED - RESTARTING`
   - Network timeouts: `NETWORK TIMEOUT DIAGNOSTICS`

3. **Frontend (Browser Console)**:
   - Polling attempts: `Polling job abc123 (attempt X/60)`
   - Token countdown: `Daily token limit reached. Retry in 7m54s`

### Common Issues & Solutions

| Issue | Cause | Solution |
|-------|-------|----------|
| "Daily token limit reached" | Groq 200K/day limit hit | Wait for tokens to recover (rolling window) |
| Job timeout after 2min | Render cold start + slow site | Retry (first request wakes Render) |
| Memory limit restart | Large page or PDF | Expected behavior, service auto-restarts |
| "No Tavily credits" | Used 1000 searches this month | Wait for monthly reset or add direct URLs |
| BrowserQL quota exhausted | Used 1000 tokens this month | Wait for monthly reset or reduce usage |

## Testing Strategy

### What to Test (No API Token Cost)

✅ CSV parsing (`lib/csv-parser.js`)
✅ Input validation (`lib/validators.js`)
✅ URL construction for manufacturers
✅ Format/truncation logic

### What NOT to Test (Costs Tokens)

❌ Actual scraping (costs Render time)
❌ Groq API calls (costs LLM tokens)
❌ Tavily searches (costs search tokens)
❌ BrowserQL calls (costs scraping tokens)

### Running Tests

```bash
# Create test file (suggested)
node test.js

# Test CSV parser
const { parseCSV } = require('./netlify/functions/lib/csv-parser');
const result = parseCSV('test,data\n1,2');
console.assert(result.success === true);
console.assert(result.data.length === 2);
```

## Future Improvements (If Free Tiers Change)

1. **If Groq increases daily limit**:
   - Remove aggressive content truncation
   - Increase auto-check limit from 20/day

2. **If Render increases RAM**:
   - Enable concurrent scraping (2-3 browsers)
   - Remove memory restart mechanism

3. **If Tavily increases limit**:
   - Use 3-4 URLs per search (better accuracy)
   - Remove some manufacturer direct URLs

4. **If BrowserQL increases tokens**:
   - Use for more manufacturers
   - Reduce Puppeteer usage

## Contributing

When making changes:
1. **Test token impact**: Check Tavily, Groq, BrowserQL usage after changes
2. **Monitor memory**: Watch Render logs for memory spikes
3. **Update config**: Add new magic numbers to `lib/config.js`
4. **Document limits**: Update this file if free tier limits change

## License

Internal use only (Syntegon).
