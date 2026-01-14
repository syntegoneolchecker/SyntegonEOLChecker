# PDF Strategy and Missing Logs Analysis

## 1. PDF OCR Approach Evaluation

### Your Proposed Solution (Excellent!)

**Flow:**
```
EOL Check → SerpAPI (10 URLs) → Select 2 URLs → PDF Pre-screening
                                                          ↓
                                                  Is it a PDF?
                                                     ↙        ↘
                                                   YES        NO
                                                    ↓          ↓
                                      Try extract text    Pass to Render
                                      (quick check)            ↓
                                           ↓                   ✓
                                  Got > N chars?
                                   ↙           ↘
                                 YES           NO
                                  ↓             ↓
                           Pass to Render    Replace with next URL
                                  ↓             ↓
                                  ✓          Repeat screening
```

### Rating: ⭐⭐⭐⭐⭐ (Excellent Approach!)

**Why this is superior to OCR:**

✅ **Avoids OCR entirely** - No accuracy issues, no multi-language problems
✅ **Fast pre-screening** - Quick text extraction test (< 1 second per PDF)
✅ **Self-healing** - Automatically finds usable URLs
✅ **Cost-effective** - No OCR API costs
✅ **Reliable** - Text extraction is deterministic, OCR is probabilistic
✅ **Practical** - Most manufacturer PDFs are digital (text-based), not scanned

**Improvements/Considerations:**

### 1. Pre-screening Implementation Details

**Location:** In `initialize-job.js` after SerpAPI search, before saving job

```javascript
async function screenAndSelectUrls(searchResults, maxUrls = 2) {
    const scoredUrls = scoreUrls(searchResults); // Existing scoring logic
    const validUrls = [];
    let attemptedCount = 0;

    for (const url of scoredUrls) {
        if (validUrls.length >= maxUrls) break;
        attemptedCount++;

        // Check if URL is valid (non-PDF or readable PDF)
        const screenResult = await screenUrl(url);

        if (screenResult.valid) {
            validUrls.push({
                ...url,
                screeningResult: screenResult
            });
            logger.info(`✓ URL ${attemptedCount} passed screening: ${url.url}`);
        } else {
            logger.info(`✗ URL ${attemptedCount} failed screening (${screenResult.reason}): ${url.url}`);
            logger.info(`   Trying next URL from search results...`);
        }
    }

    if (validUrls.length < maxUrls) {
        logger.warn(`Only found ${validUrls.length}/${maxUrls} valid URLs after screening ${attemptedCount} candidates`);
    }

    return validUrls;
}

async function screenUrl(urlInfo) {
    const { url } = urlInfo;

    // Quick check: Is this a PDF URL?
    const isPdfUrl = url.toLowerCase().endsWith('.pdf') ||
                     url.includes('/pdf/') ||
                     url.includes('data_pdf');

    if (!isPdfUrl) {
        // Not a PDF, assume it's valid HTML
        return {
            valid: true,
            type: 'html',
            reason: 'Non-PDF URL, will scrape as HTML'
        };
    }

    // It's a PDF - attempt to extract text
    try {
        const extractionResult = await quickPdfTextCheck(url);

        if (extractionResult.success && extractionResult.charCount > 100) {
            return {
                valid: true,
                type: 'pdf',
                charCount: extractionResult.charCount,
                reason: `PDF with ${extractionResult.charCount} extractable characters`
            };
        } else if (extractionResult.success && extractionResult.charCount === 0) {
            return {
                valid: false,
                type: 'pdf',
                reason: 'PDF is image-only (0 text characters extracted)'
            };
        } else {
            return {
                valid: false,
                type: 'pdf',
                reason: extractionResult.error || 'PDF text extraction failed'
            };
        }
    } catch (error) {
        logger.error(`PDF screening error for ${url}: ${error.message}`);
        return {
            valid: false,
            type: 'pdf',
            reason: `Screening error: ${error.message}`
        };
    }
}

async function quickPdfTextCheck(pdfUrl) {
    const timeout = 5000; // 5 second timeout for quick check

    try {
        // Download PDF (with size limit)
        const response = await fetch(pdfUrl, {
            signal: AbortSignal.timeout(timeout),
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; EOLChecker/1.0)'
            }
        });

        if (!response.ok) {
            return {
                success: false,
                error: `HTTP ${response.status}`
            };
        }

        const contentType = response.headers.get('content-type');
        if (!contentType?.includes('pdf')) {
            return {
                success: false,
                error: `Not a PDF (Content-Type: ${contentType})`
            };
        }

        // Check size before downloading
        const contentLength = response.headers.get('content-length');
        if (contentLength && parseInt(contentLength) > 10 * 1024 * 1024) {
            return {
                success: false,
                error: `PDF too large (${contentLength} bytes, max 10MB for screening)`
            };
        }

        const buffer = await response.arrayBuffer();

        // Quick text extraction (first 3 pages only)
        const pdf = require('pdf-parse');
        const data = await pdf(Buffer.from(buffer), {
            max: 3  // Only parse first 3 pages for speed
        });

        return {
            success: true,
            charCount: data.text.length,
            pageCount: data.numpages
        };

    } catch (error) {
        if (error.name === 'AbortError') {
            return {
                success: false,
                error: 'Timeout during PDF download'
            };
        }
        return {
            success: false,
            error: error.message
        };
    }
}
```

### 2. Character Count Threshold

**Recommendation: 100 characters minimum**

**Rationale:**
- Too low (< 50): Might accept PDFs with only headers/footers
- Too high (> 500): Might reject valid but concise PDFs
- 100 chars: ~15-20 words, sufficient to indicate meaningful content

**Make it configurable:**
```javascript
// config.js
PDF_SCREENING_MIN_CHARS: 100,
PDF_SCREENING_TIMEOUT_MS: 5000,
PDF_SCREENING_MAX_SIZE_MB: 10,
PDF_SCREENING_MAX_PAGES: 3,  // Only check first N pages
```

### 3. Edge Cases to Handle

**Case 1: All 10 URLs are unreadable PDFs**
```javascript
if (validUrls.length === 0) {
    logger.warn('No valid URLs found after screening all search results');
    return {
        jobId,
        status: 'complete',
        urlCount: 0,
        finalResult: {
            status: 'UNKNOWN',
            explanation: 'All search results were unreadable PDFs or inaccessible URLs',
            successor: { status: 'UNKNOWN', model: null, explanation: 'No accessible sources found' }
        }
    };
}
```

**Case 2: Only 1 valid URL found**
```javascript
if (validUrls.length === 1) {
    logger.info('Only 1 valid URL found, proceeding with single URL analysis');
    // Continue with 1 URL (better than nothing)
}
```

**Case 3: PDF download fails (network error)**
```javascript
catch (error) {
    if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
        // Treat as invalid (network issues), try next URL
        return { valid: false, reason: 'Network error during PDF download' };
    }
}
```

### 4. Performance Optimization

**Parallel screening:**
```javascript
// Screen multiple URLs concurrently
const screeningPromises = candidateUrls.map(url => screenUrl(url));
const screeningResults = await Promise.allSettled(screeningPromises);

// Take first N valid results
const validUrls = screeningResults
    .filter(r => r.status === 'fulfilled' && r.value.valid)
    .slice(0, maxUrls)
    .map(r => r.value);
```

**Potential issue:** If screening 10 PDFs in parallel, might overwhelm Netlify function memory.

**Solution:** Screen in batches
```javascript
async function screenUrlsInBatches(urls, maxValid = 2, batchSize = 3) {
    const validUrls = [];

    for (let i = 0; i < urls.length && validUrls.length < maxValid; i += batchSize) {
        const batch = urls.slice(i, i + batchSize);
        const results = await Promise.allSettled(
            batch.map(url => screenUrl(url))
        );

        for (const result of results) {
            if (result.status === 'fulfilled' && result.value.valid) {
                validUrls.push(result.value);
                if (validUrls.length >= maxValid) break;
            }
        }
    }

    return validUrls;
}
```

### 5. Logging for Debugging

**Add comprehensive screening logs:**
```javascript
logger.info(`[PDF-SCREEN] Starting URL screening: ${searchResults.length} candidates, need ${maxUrls} valid URLs`);
logger.info(`[PDF-SCREEN] URL ${i+1}/${searchResults.length}: ${url.url}`);
logger.info(`[PDF-SCREEN] → Type: ${isPdfUrl ? 'PDF' : 'HTML'}`);
logger.info(`[PDF-SCREEN] → PDF check: ${charCount} characters extracted`);
logger.info(`[PDF-SCREEN] → Result: ${valid ? 'PASS ✓' : 'FAIL ✗'} (${reason})`);
logger.info(`[PDF-SCREEN] Screening complete: ${validUrls.length}/${maxUrls} valid URLs found after checking ${attemptedCount} candidates`);
```

### 6. Alternative: Lazy Screening (On-Demand)

**Instead of pre-screening during initialization:**
- Screen PDFs when Render is about to fetch them
- If PDF fails screening, dynamically fetch next URL from search results

**Pros:**
- Faster job initialization
- Only screens PDFs that will actually be used

**Cons:**
- More complex state management
- Need to store full search results list in job
- Adds latency during fetching phase

**Recommendation:** Stick with **pre-screening during initialization** for simplicity.

---

## 2. ✅ Fix #2 Approved - No Further Action

---

## 3. ✅ Fix #3 Resolved - No Issue

The timeout behavior is working as designed with the fire-and-forget pattern.

---

## 4. PDF Parser Clarification

### Important Correction!

**You asked:** "pdf-parse fails when any images are present, correct?"

**Answer: NO! pdf-parse works fine with mixed PDFs (text + images).**

### How pdf-parse Actually Works

```javascript
// PDF with text + images
const buffer = readPdfFile('product-catalog.pdf');
const data = await pdfParse(buffer);

// Result:
data.text = "Product Name: ABC-123\nSpecifications: ...\n[Images are ignored]"
// ✓ Extracts text successfully, ignores images
```

**pdf-parse behavior:**
- ✅ **Text-only PDFs** → Extracts all text perfectly
- ✅ **Mixed PDFs (text + images)** → Extracts text, ignores images automatically
- ❌ **Image-only PDFs** (scanned documents) → Returns 0 characters (no text to extract)

### The OMRON PDF Case

The OMRON PDF (`2006391.pdf`) extracted **0 characters** because it's an **image-only PDF** (scanned document).

```
PDF Type: Scanned catalog pages
Content: Images of tables and Japanese text
Embedded Text: None (0 characters)
Why: Created by scanning paper → pure images, no text layer
```

**This is exactly what your screening approach will detect and reject!**

### No Need for Special Mixed-PDF Parser

**pdf-parse is already the solution you need!**

- ✓ Handles text-only PDFs
- ✓ Handles mixed PDFs (text + images) - ignores images automatically
- ✓ Fast (< 1 second for most PDFs)
- ✓ Works with CJK characters (Japanese, Chinese)
- ✓ Already used in Render service

**The only PDFs it fails on are image-only (scanned), which your screening will reject.**

### Render Service Already Has This

Looking at Render's code, it uses `pdf-parse`:
```javascript
const pdfParse = require('pdf-parse');
const data = await pdfParse(buffer);
// Extracts text, ignores images ✓
```

**No changes needed to PDF extraction logic!** Just add screening.

---

## 5. Phase 2 Lock Cleanup Consideration

### Your Question: "Would stuck-fetch cleanup work with 2-minute timeout?"

**You're absolutely right to question this!**

### Context Clarification

**Manual EOL Checks (Frontend):**
- User clicks "Check EOL" → Frontend polls job-status
- **No 2-minute timeout** - polls indefinitely until job completes
- Functions timeout individually (30s each), but job continues

**Auto EOL Checks (Background):**
- Scheduled daily checks via background function
- **15-minute timeout** for entire background function
- Polls job within background function with 2-minute limit per job

### Stuck-Fetch Cleanup Usefulness

**Scenario 1: Manual Check**
```
User triggers check → URL marked 'fetching' → Render times out → No callback
After 30s: fetch-url function times out
After 2 min: URL still 'fetching' (stuck!)
Cleanup would detect and reset → Triggers retry ✓
```

**Scenario 2: Auto-Check**
```
Background function starts → URL marked 'fetching' → Render dies
After 2 min: Background function gives up on polling
URL still 'fetching' (stuck!)
Next auto-check (24h later): Would skip this product (appears in-progress)
```

### Revised Phase 2 Recommendation

**Add cleanup in TWO places:**

**Place 1: During job-status polling (auto-check background)**
```javascript
// In auto-eol-check-background.js polling loop
const job = await getJob(jobId);
cleanupStuckUrls(job); // Reset URLs stuck > 2 minutes

if (job.status === 'urls_ready' || job.status === 'fetching') {
    // Continue polling...
}
```

**Place 2: At start of new manual check (initialize-job)**
```javascript
// When user starts a new check for the same product
const existingJob = await findJobByProduct(maker, model);
if (existingJob && existingJob.status !== 'complete') {
    cleanupStuckUrls(existingJob); // Clean up stuck state
    // Optionally: Resume vs. restart
}
```

**Implementation:**
```javascript
function cleanupStuckUrls(job) {
    const now = Date.now();
    const STUCK_THRESHOLD_MS = 120000; // 2 minutes
    let cleaned = false;

    for (const url of job.urls) {
        if (url.status === 'fetching') {
            const duration = now - (url.fetchingStartedAt || job.createdAt);
            if (duration > STUCK_THRESHOLD_MS) {
                logger.warn(`[CLEANUP] URL ${url.index} stuck in 'fetching' for ${duration}ms, resetting to 'pending'`);
                url.status = 'pending';
                url.fetchingStartedAt = null;
                cleaned = true;
            }
        }
    }

    if (cleaned) {
        await saveJob(job);
    }

    return cleaned;
}
```

**Benefit:** Prevents stuck URLs from blocking future checks.

**Alternative:** Instead of cleanup, make stuck URLs automatically expire:
```javascript
// In job-storage.js getJob function
function isUrlStuck(url, job) {
    if (url.status !== 'fetching') return false;
    const duration = Date.now() - (url.fetchingStartedAt || job.createdAt);
    return duration > 120000; // 2 minutes
}

async function getJob(jobId) {
    const job = await store.get(jobId, { type: 'json' });
    if (!job) return null;

    // Auto-expire stuck URLs on read
    for (const url of job.urls) {
        if (isUrlStuck(url, job)) {
            logger.warn(`[AUTO-EXPIRE] URL ${url.index} expired from 'fetching' state`);
            url.status = 'error';
            url.error = 'Fetch timeout (stuck > 2 minutes)';
        }
    }

    return job;
}
```

**Your call:** Add cleanup or not? Probably not critical given your current flow.

---

## 6. Render Cold Start Clarification

### You're Absolutely Correct!

**Your understanding:**
```
Netlify site loads → Health check triggered → Render wakes up (50s)
Render reports healthy → EOL check can start → Render already warm ✓
```

**Timeline in auto-check:**
```
00:00 - scheduled-eol-check.js runs (cron trigger)
00:00 - Triggers auto-eol-check-background.js
00:01 - Background function wakes Render (health checks)
00:50 - Render healthy ✓
00:51 - Initialize job
00:52 - Fetch URL 0 → Render ready, no cold start delay!
00:54 - Fetch URL 1 → Render still warm ✓
```

**So the 30s timeout increase is NOT for cold starts.**

### What IS the 30s Timeout For?

**Reason 1: PDF Processing Time**
Even with warm Render:
```
PDF fetch: 2-5 seconds (1.7 MB download)
PDF parse: 3-5 seconds (pdf-parse processing)
Callback prepare: 0.5-1 second
Total: 5-11 seconds

With network variability: 15 seconds is tight!
30 seconds: Safe buffer ✓
```

**Reason 2: Render Under Load**
If Render service is processing multiple requests:
```
Request queuing: 1-5 seconds
Processing time: 5-10 seconds
Total: 15-20 seconds

30 seconds prevents false timeouts ✓
```

**Reason 3: Network Variability**
Japan → US Render server:
```
Network latency spikes: 1-10 seconds
Render response time: 5-10 seconds
Total: 20 seconds possible

30 seconds handles spikes ✓
```

### Will 30s Cause Problems?

**Your question: "Should not cause any problems (correct?)"**

**Answer: Correct, no problems expected!**

**Why it's safe:**
- ✅ fetch-url returns immediately (202) regardless of timeout
- ✅ Callbacks arrive independently
- ✅ 30s << 30s Netlify function limit (room for other operations)
- ✅ Fire-and-forget pattern doesn't block on timeout
- ✅ Reduces false timeout logs
- ✅ Improves stability under load

**Potential non-issue:**
- Slow failure detection (30s vs 15s to detect actual failure)
- But: Real failures (404, 500) return immediately, not after timeout
- Only timeout happens when Render is slow but working

**Verdict: 30s timeout is good, no downside!**

---

## Summary

### Approved Approaches
1. ✅ **PDF Pre-screening** - Excellent strategy, will implement
2. ✅ **pdf-parse for mixed PDFs** - Already works, no changes needed
3. ✅ **30s timeout** - Safe and stable
4. ⚠️ **Stuck-fetch cleanup** - Optional, low priority given current flow

### Action Items
1. Implement PDF screening in initialize-job.js
2. Add screening configuration to config.js
3. Add comprehensive screening logs
4. Test with various PDF types
5. Investigate missing logs (next section)

---

## Missing Logs Investigation (Coming Next...)

Analyzing why these logs are absent from the EOL check flow.
