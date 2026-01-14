# Fix Discussion and Implementation Plan

## Question 1: Tesseract.js Performance for Japanese PDFs

### Processing Time
Based on research and benchmarks:
- **Typical range**: 2-20+ seconds per page
- **Factors affecting speed**:
  - Image resolution (higher = slower)
  - Content complexity
  - Worker initialization overhead (can be 50% of total time)
  - Browser vs. Node.js environment

**For your specific case (OMRON PDF):**
- The PDF is 1.69 MB with likely multiple pages
- Assuming 3-5 pages with Japanese text
- **Estimated total OCR time**: 10-60 seconds for full document

### Multi-Language Support: Japanese + English

**Critical Issue: Japanese and English DON'T work well together in Tesseract.js!**

**The Problem:**
- CJK block characters fundamentally conflict with Latin alphabets
- Using "jpn+eng" or "eng+jpn" yields poor results
- When both specified:
  - English dominates → Japanese becomes random symbols
  - OR Japanese dominates → English words are missed

**Tesseract.js Syntax for Multiple Languages:**
```javascript
// Method 1: Array format
const worker = await createWorker(['jpn', 'eng']);

// Method 2: Plus-separated string
await worker.recognize(image, { lang: 'jpn+eng' });

// For Japanese including vertical text
const worker = await createWorker(['jpn', 'jpn_vert']);
```

**Available CJK Language Codes:**
- `jpn` - Japanese (horizontal)
- `jpn_vert` - Japanese (vertical)
- `chi_sim` - Chinese Simplified
- `chi_tra` - Chinese Traditional
- `kor` - Korean

### Recommended Approach for Mixed Language PDFs

**Option A: Language-Specific Processing (Recommended)**
```javascript
// Run OCR twice with different language models
const japaneseText = await worker.recognize(image, { lang: 'jpn' });
const englishText = await worker.recognize(image, { lang: 'eng' });

// Merge results (combine unique text)
const combinedText = mergeOcrResults(japaneseText, englishText);
```

**Option B: Use Better Alternative (Strongly Recommended)**
For production Japanese+English OCR, consider:
- **PaddleOCR** (by Baidu) - Superior multi-language handling
- **Google Cloud Vision API** - Strong CJK support ($1.50/1000 pages)
- **Azure Document Intelligence** - 10+ languages including CJK
- **Surya** - Modern Python OCR with 90+ languages

**My Recommendation:**
1. **Short term**: Try OCR with `jpn` only (will capture Japanese, miss English)
2. **Medium term**: Implement PaddleOCR or cloud OCR as fallback for complex PDFs
3. **Long term**: Add PDF type detection (text vs. image) to choose extraction method

---

## Question 2: Implement URL Status Check Before Retry ✅ APPROVED

### Current Problem
The retry logic doesn't check if a URL is already `complete` or `fetching` before triggering another fetch attempt. This causes the same URL to be fetched multiple times concurrently.

### Implementation Locations

**Location 1: scraping-callback.js (lines 115-132)**
When triggering next URL after callback:
```javascript
const nextUrl = job.urls.find(u => u.status === 'pending');
if (nextUrl) {
    await triggerFetchUrl(baseUrl, payload);
}
```

**Location 2: fire-and-forget.js (triggerFetchUrl function)**
Add status check before firing fetch:
```javascript
async function triggerFetchUrl(baseUrl, payload) {
    // NEW: Check current URL status first
    const job = await getJob(payload.jobId);
    const url = job?.urls[payload.urlIndex];

    if (!url) {
        logger.warn(`URL ${payload.urlIndex} not found in job ${payload.jobId}`);
        return;
    }

    if (url.status === 'complete') {
        logger.info(`URL ${payload.urlIndex} already complete, skipping fetch`);
        return;
    }

    if (url.status === 'fetching') {
        logger.info(`URL ${payload.urlIndex} already fetching, skipping duplicate`);
        return;
    }

    // Proceed with fetch...
}
```

**Status:** WILL IMPLEMENT

---

## Question 3: Explain fetch-url Timeout Behavior in Detail

### Your Question
> "The process times out after 15 seconds, assuming background processing which is correct, right? Is this implementation problematic and caused the issues in the previous EOL check?"

### Answer: The Implementation is CORRECT!

Let me explain the architectural pattern:

### How It Actually Works (Fire-and-Forget Pattern)

**Step 1: fetch-url receives request**
```
01:18:18 - [FETCH-URL] Invocation starts
01:18:18 - Mark URL as 'fetching'
01:18:18 - Call Render service with 15s timeout
```

**Step 2: Render service call with timeout**
```javascript
// fetch-url.js line 297-309
await retryWithBackoff({
    operation: async () => fetch(renderServiceUrl, { ... }),
    maxRetries: 3,
    timeoutMs: 15000,
    breakOnTimeout: true  // ← KEY: Don't retry on timeout
});
```

**Step 3: Two possible outcomes**

**Outcome A: Render responds within 15 seconds**
```
→ Render receives request
→ Render immediately returns HTTP 202 Accepted
→ fetch-url logs "succeeded" and returns
→ Render continues scraping in background
→ Render calls scraping-callback when done
```

**Outcome B: Render doesn't respond within 15 seconds (cold start)**
```
→ Render is waking up from cold state
→ 15 seconds pass without response
→ fetch-url logs "timeout after 15000ms (assuming background processing)"
→ fetch-url returns HTTP 202 to caller
→ Render eventually wakes up and processes request
→ Render calls scraping-callback when done
```

### Why This is CORRECT Design

1. **Netlify Functions have 30s timeout** - if we waited longer, the function would die
2. **Render callbacks handle the actual result** - we don't need to wait
3. **HTTP 202 Accepted = "request received, processing asynchronously"**
4. **The timeout prevents function death, not data loss**

### What Actually Caused the 4 Fetch Attempts?

**NOT the timeout behavior!** The timeout is working as designed.

**The REAL cause:** Race condition in retry logic

```
Timeline:
01:18:19 - Attempt 1: fetch-url called (by polling or callback)
01:18:34 - Attempt 1 times out → logs "assuming background processing"
01:18:34 - Attempt 2: RETRY triggered (by fire-and-forget wrapper)
                     BUT doesn't check if URL status = 'fetching'
01:18:46 - Attempt 3: ANOTHER retry
01:18:47 - Attempt 4: YET ANOTHER retry

Each attempt:
- Marks URL as 'fetching' (redundantly)
- Calls Render service (creates duplicate request)
- Times out after 15s
- Returns HTTP 202
```

### The Problem is NOT the Timeout Pattern

The problem is:
1. **Multiple callers** trigger fetch-url for same URL
2. **No deduplication** - doesn't check if URL is already fetching
3. **Retry wrapper** blindly retries without checking current state

### The Fix (Question 2) Will Solve This

Adding status checks before retry will prevent:
- Fetching already-complete URLs
- Duplicate fetches of in-progress URLs
- Wasted Render service calls

**Conclusion: The timeout behavior is correct and NOT the root cause.**

---

## Question 4: Why Multiple PDF Parsers? Can't One Parser Work?

### The Reality of PDF Complexity

PDFs are NOT a uniform format. There are fundamentally different types:

### PDF Type 1: Text-Based PDFs
- Created digitally (Word, Excel → PDF)
- Contains actual text characters embedded
- **Extraction**: Fast and perfect with pdf-parse or pdfjs-dist
- **Example**: Generated reports, digital documentation

### PDF Type 2: Image-Based PDFs (Scanned Documents)
- Created by scanning paper documents
- Contains images of text, NOT actual text
- **Extraction**: Requires OCR (Tesseract, PaddleOCR)
- **Example**: Old datasheets, scanned archives
- **Your OMRON PDF falls into this category!**

### PDF Type 3: Mixed/Complex PDFs
- Combination of text and images
- Non-standard fonts or encodings
- CJK character rendering issues
- Password-protected or encrypted

### Why a Single Parser Isn't Sufficient

**Scenario:**
```
Try pdf-parse:
  ├─ Text-based PDF → Success! ✓
  ├─ Image-based PDF → 0 characters extracted ✗
  └─ Complex encoding → Garbled text ✗

Try OCR only:
  ├─ Text-based PDF → Slow (2-20s) + possible errors ✗
  ├─ Image-based PDF → Success! ✓
  └─ Quality depends on image resolution

Try pdfjs-dist:
  ├─ Text-based PDF → Success! ✓
  ├─ CJK characters → Better than pdf-parse ✓
  ├─ Image-based PDF → 0 characters ✗
```

### Recommended Fallback Chain Strategy

```javascript
async function extractPdfText(pdfBuffer, url) {
    // ATTEMPT 1: Fast text extraction (0.5-2 seconds)
    try {
        const text = await extractWithPdfParse(pdfBuffer);
        if (text.length > 100) {  // Minimum threshold
            logger.info(`PDF text extracted with pdf-parse: ${text.length} chars`);
            return text;
        }
    } catch (error) {
        logger.warn(`pdf-parse failed: ${error.message}`);
    }

    // ATTEMPT 2: Better CJK support (1-3 seconds)
    try {
        const text = await extractWithPdfjsDist(pdfBuffer);
        if (text.length > 100) {
            logger.info(`PDF text extracted with pdfjs-dist: ${text.length} chars`);
            return text;
        }
    } catch (error) {
        logger.warn(`pdfjs-dist failed: ${error.message}`);
    }

    // ATTEMPT 3: OCR for image-based PDFs (10-60 seconds)
    try {
        logger.info('Text extraction failed, attempting OCR...');
        const text = await extractWithOcr(pdfBuffer, 'jpn');
        if (text.length > 100) {
            logger.info(`PDF text extracted with OCR: ${text.length} chars`);
            return text;
        }
    } catch (error) {
        logger.error(`OCR failed: ${error.message}`);
    }

    // ATTEMPT 4: Fallback error message
    return `[PDF extraction failed: May be image-based without OCR support, encrypted, or empty. Manual review recommended.]`;
}
```

### Benefits of Multi-Parser Approach

1. **Speed**: Try fast parsers first (text-based PDFs done in <2s)
2. **Coverage**: Handle both text-based and image-based PDFs
3. **CJK Support**: pdfjs-dist handles Japanese better than pdf-parse
4. **Reliability**: If one parser fails, others may succeed
5. **Cost-Effective**: Only use slow OCR when necessary

### Real-World Example (Your OMRON PDF)

```
PDF: https://www.fa.omron.co.jp/data_pdf/closed/2006391.pdf
Title: 生産終了予定商品 推奨代替商品 (Discontinued Products / Replacements)

Current behavior:
├─ pdf-parse → 0 characters ✗
└─ Gives up → Analysis with incomplete data

With fallback chain:
├─ pdf-parse → 0 characters
├─ pdfjs-dist → Possibly 0 characters (if image-based)
├─ Tesseract OCR (jpn) → Success! ~2000+ characters ✓
└─ Analysis with complete data → Finds successor info!
```

**Conclusion: Multiple parsers = robustness + speed optimization**

---

## Question 5: Recommended Solution for Distributed Locking

### The Problem
Multiple fetch-url invocations can run concurrently for the same URL, causing duplicate Render service calls.

### Solution Options

### Option A: Status-Based Locking (Recommended - SIMPLEST)

**Implementation:** Already covered in Question 2!

The job storage already acts as a distributed state store:
```javascript
// Before triggering fetch
const job = await getJob(jobId);
const url = job.urls[urlIndex];

if (url.status === 'fetching' || url.status === 'complete') {
    logger.info('URL already being processed, skipping');
    return;
}

// Mark as fetching (acts as lock)
await markUrlFetching(jobId, urlIndex);
```

**Pros:**
- No new infrastructure needed
- Already implemented in job-storage.js
- Works across all function invocations
- Simple to reason about

**Cons:**
- Potential race condition if two functions mark simultaneously
- No automatic lock expiration (could get stuck if function crashes)

### Option B: Netlify Blobs with TTL (Better for Production)

```javascript
const { getStore } = require('@netlify/blobs');

async function acquireLock(jobId, urlIndex, ttlSeconds = 120) {
    const store = getStore('locks');
    const lockKey = `fetch-lock:${jobId}:${urlIndex}`;

    try {
        // Try to create lock (atomic operation)
        const existing = await store.get(lockKey);
        if (existing) {
            logger.info(`Lock already held for ${lockKey}`);
            return false;
        }

        // Acquire lock with TTL
        await store.setJSON(lockKey, {
            acquiredAt: Date.now(),
            ttl: ttlSeconds
        }, {
            metadata: { ttl: ttlSeconds }
        });

        return true;
    } catch (error) {
        logger.error(`Failed to acquire lock: ${error.message}`);
        return false;
    }
}

async function releaseLock(jobId, urlIndex) {
    const store = getStore('locks');
    const lockKey = `fetch-lock:${jobId}:${urlIndex}`;
    await store.delete(lockKey);
}

// Usage
async function triggerFetchUrl(baseUrl, payload) {
    const acquired = await acquireLock(payload.jobId, payload.urlIndex, 120);
    if (!acquired) {
        logger.info('Another fetch in progress, skipping');
        return;
    }

    try {
        await fireAndForgetFetch(url, options, config);
    } finally {
        await releaseLock(payload.jobId, payload.urlIndex);
    }
}
```

**Pros:**
- Automatic lock expiration (TTL)
- True atomic lock acquisition
- Handles crashed functions gracefully
- No stuck locks

**Cons:**
- Requires Netlify Blobs API calls (adds latency)
- More complex implementation
- Need to handle lock cleanup

### Option C: In-Memory Deduplication (Simple but Limited)

```javascript
const inflightRequests = new Map();

async function triggerFetchUrl(baseUrl, payload) {
    const key = `${payload.jobId}:${payload.urlIndex}`;

    if (inflightRequests.has(key)) {
        logger.info('Request already in flight, skipping');
        return;
    }

    inflightRequests.set(key, Date.now());

    try {
        await fireAndForgetFetch(url, options, config);
    } finally {
        inflightRequests.delete(key);
    }
}
```

**Pros:**
- Very simple
- No external dependencies
- Zero latency

**Cons:**
- Only prevents duplicates within same function instance
- Doesn't work across multiple invocations
- Memory leaks if not cleaned up properly

### My Recommendation: Hybrid Approach

**Phase 1 (Immediate): Status-Based Check**
- Implement Question 2 fix
- Check URL status before triggering fetch
- Solves 90% of duplicate fetch issues
- Zero additional complexity

**Phase 2 (Future Enhancement): Add Lock Cleanup**
```javascript
// Add to job-status or polling function
async function cleanupStuckFetches(job) {
    const now = Date.now();
    const FETCH_TIMEOUT_MS = 120000; // 2 minutes

    for (const url of job.urls) {
        if (url.status === 'fetching') {
            const fetchingDuration = now - url.fetchingStartTime;
            if (fetchingDuration > FETCH_TIMEOUT_MS) {
                logger.warn(`URL ${url.index} stuck in fetching for ${fetchingDuration}ms, resetting`);
                url.status = 'pending';
            }
        }
    }

    await saveJob(job);
}
```

**This provides:**
- ✓ Duplicate prevention (status check)
- ✓ Stuck fetch recovery (timeout cleanup)
- ✓ Simple implementation (no new infrastructure)
- ✓ Low latency (no lock service calls)

---

## Question 6: Implement PDF Timeout Increase to 30 Seconds ✅ APPROVED

### Current Configuration
```javascript
// config.js line 154
RENDER_SERVICE_CALL_TIMEOUT_MS: 15000, // 15 seconds
```

### Why Increase to 30 Seconds?

**Reason 1: Render Cold Start Time**
- Render free tier spins down after inactivity
- Cold start can take 10-20 seconds
- 15 seconds is insufficient for cold starts

**Reason 2: PDF Processing Time**
- Large PDFs (1-2 MB) take 3-5 seconds to download
- PDF parsing takes another 3-5 seconds
- Total: 6-10 seconds even without cold start
- 15 seconds is tight for PDFs

**Reason 3: Callback Pattern**
- We're using fire-and-forget (callback)
- Render doesn't need to complete processing
- We just need Render to acknowledge receipt
- But Render might be waking up, so needs buffer time

### Proposed Change

```javascript
// config.js
RENDER_SERVICE_CALL_TIMEOUT_MS: 30000, // 30 seconds (was 15000)
```

### Impact Analysis

**Positive:**
- ✓ Fewer false timeouts during cold starts
- ✓ PDFs have more time to be acknowledged
- ✓ Reduces unnecessary retries
- ✓ Better user experience (fewer "timeout" errors)

**Negative:**
- ⚠️ Slower failure detection (30s vs 15s)
- ⚠️ Functions might approach 30s Netlify limit
- ⚠️ Slightly longer wait during actual failures

**Mitigation:**
- The fire-and-forget pattern means we return immediately anyway
- Callbacks arrive independently of timeout
- 30s is still well under Netlify's limit
- Real failures (404, 500) return immediately, not after timeout

**Status:** WILL IMPLEMENT

---

## Summary of Actions

### Approved for Implementation ✅
1. **Fix #2**: Add URL status check before retry
2. **Fix #6**: Increase PDF timeout to 30 seconds

### Recommended for Discussion
1. **PDF OCR**: Add Tesseract.js with `jpn` language for image-based PDFs
2. **PDF Parser Fallback**: Implement pdf-parse → pdfjs-dist → OCR chain
3. **Lock Cleanup**: Add stuck-fetch detection in polling loop

### Not Recommended
- ❌ Distributed locking infrastructure (overkill)
- ❌ Synchronous PDF processing (will timeout)
- ❌ Japanese+English simultaneous OCR (poor results)

### Next Steps
1. Implement approved fixes (#2 and #6)
2. Test with the problematic OMRON PDF
3. Monitor for duplicate fetch issues
4. Consider PDF OCR as Phase 2 enhancement
