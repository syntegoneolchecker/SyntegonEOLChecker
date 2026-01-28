# Utility Usage Guide

This guide shows how to use the new centralized utilities in the codebase.

## 1. Centralized Logger

**Location:** `netlify/functions/lib/logger.js` and `scraping-service/utils/logger.js`

### Usage:

```javascript
const logger = require('./lib/logger'); // or './utils/logger' for scraping service

// Debug-level (most verbose)
logger.debug('Detailed diagnostic info:', someVariable);

// Info-level (general flow)
logger.info('Job created successfully:', jobId);

// Warning-level (potential issues)
logger.warn('BrowserQL API key not configured');

// Error-level (errors)
logger.error('Failed to fetch URL:', error.message);
```

### Setting Log Level:

Set the `LOG_LEVEL` environment variable:
- `DEBUG` - All logs (development)
- `INFO` - Important events only (default, staging)
- `WARN` - Warnings and errors (production)
- `ERROR` - Errors only (production)
- `NONE` - Silent

**Example:**
```bash
# In .env or Netlify/Render dashboard
LOG_LEVEL=ERROR
```

### Migration Pattern:

```javascript
// Before:
console.log('Job initialized:', jobId);
console.error('Failed:', error);

// After:
logger.info('Job initialized:', jobId);
logger.error('Failed:', error);
```

---

## 2. Standardized Response Builders

**Location:** `netlify/functions/lib/response-builder.js`

### Usage:

```javascript
const {
    successResponse,
    errorResponse,
    validationErrorResponse,
    notFoundResponse,
    methodNotAllowedResponse,
    rateLimitResponse
} = require('./lib/response-builder');

// Success response (200)
return successResponse({ jobId, status: 'complete' });

// Custom success with different status code
return successResponse({ message: 'Created' }, 201);

// Error response (500)
return errorResponse('Something went wrong');

// Error with details
return errorResponse('Job failed', { reason: 'timeout' }, 500);

// Validation error (400)
return validationErrorResponse(['Name is required', 'Email invalid']);

// Not found (404)
return notFoundResponse('Job');

// Method not allowed (405)
return methodNotAllowedResponse('POST, GET');

// Rate limit (429)
return rateLimitResponse('Too many requests', 60); // retry after 60s
```

### Response Format:

All responses follow this consistent structure:

**Success:**
```json
{
  "success": true,
  "data": { /* your data */ }
}
```

**Error:**
```json
{
  "success": false,
  "error": {
    "message": "Job not found",
    "timestamp": "2025-01-15T10:30:00.000Z",
    "details": { /* optional */ }
  }
}
```

### Migration Pattern:

```javascript
// Before:
return {
    statusCode: 404,
    headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: 'Job not found' })
};

// After:
return notFoundResponse('Job');
```

---

## 3. Content Truncator (for analyze-job)

**Location:** `netlify/functions/lib/content-truncator.js`

### Usage:

```javascript
const {
    processTablesInContent,
    filterIrrelevantTables,
    smartTruncate
} = require('./lib/content-truncator');

// Step 1: Mark tables with delimiters
let content = processTablesInContent(rawHtml);

// Step 2: Remove tables without product mention
content = filterIrrelevantTables(content, productModel);

// Step 3: Smart truncation preserving product mentions
content = smartTruncate(content, 6500, productModel);
```

---

## 4. Fire-and-Forget Helpers

**Location:** `netlify/functions/lib/fire-and-forget.js`

### Usage:

```javascript
const { triggerFetchUrl, triggerAnalyzeJob } = require('./lib/fire-and-forget');

// Trigger next URL fetch (with automatic retry)
await triggerFetchUrl(baseUrl, {
    jobId,
    urlIndex: 0,
    url: 'https://example.com'
});

// Trigger analysis (with automatic retry)
await triggerAnalyzeJob(baseUrl, jobId);
```

Benefits:
- Automatic retry (2 retries by default)
- Exponential backoff
- 10-second timeout
- Detailed error logging

---

## 5. Environment Validators

**Location:** `netlify/functions/lib/env-validator.js`

### Usage:

```javascript
const {
    validateCommonEnvVars,
    validateBlobsToken,
    validateScrapingServiceUrl
} = require('./lib/env-validator');

// Validate all common env vars
// Throws error if SITE_ID or GROQ_API_KEY missing
validateCommonEnvVars();

// Validate specific vars
validateBlobsToken(); // Throws if NETLIFY_BLOBS_TOKEN missing
validateScrapingServiceUrl(); // Throws if URL invalid
```

Call these at function startup for fail-fast behavior.

---

## Example: Complete Function Update

**Before:**
```javascript
exports.handler = async function(event, context) {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const job = await getJob(jobId, context);
        if (!job) {
            return {
                statusCode: 404,
                body: JSON.stringify({ error: 'Job not found' })
            };
        }

        console.log('Job found:', jobId);
        return {
            statusCode: 200,
            body: JSON.stringify({ success: true, data: job })
        };
    } catch (error) {
        console.error('Error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};
```

**After:**
```javascript
const { successResponse, notFoundResponse, errorResponse, methodNotAllowedResponse } = require('./lib/response-builder');
const logger = require('./lib/logger');

exports.handler = async function(event, context) {
    if (event.httpMethod !== 'POST') {
        return methodNotAllowedResponse('POST');
    }

    try {
        const job = await getJob(jobId, context);
        if (!job) {
            logger.warn(`Job not found: ${jobId}`);
            return notFoundResponse('Job');
        }

        logger.info('Job found:', jobId);
        return successResponse(job);
    } catch (error) {
        logger.error('Error:', error);
        return errorResponse(error.message);
    }
};
```

---
