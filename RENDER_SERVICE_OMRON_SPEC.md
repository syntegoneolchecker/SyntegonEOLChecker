# Omron Dual-Page Scraping Specification for Render Service

## Overview
The Render service needs to implement a new endpoint `scrape-omron-dual` to handle Omron's dual-page scraping strategy with Japanese proxy support.

## Endpoint
**POST** `/scrape-omron-dual`

## Why Proxy is Required
Omron's website (`fa.omron.co.jp`) returns 403 Forbidden errors when accessed from non-Japanese regions. The Japanese proxy (`JP_PROXY`) must be used to successfully scrape the content.

## Request Payload
```json
{
  "callbackUrl": "https://your-site.netlify.app/.netlify/functions/scraping-callback",
  "jobId": "job_123456789_abc123",
  "urlIndex": 0,
  "title": "オムロン E6F-AG5C-C 360P/R 2M Product Page",
  "snippet": "Direct product page for オムロン E6F-AG5C-C 360P/R 2M",
  "extractionMode": "omron_dual_page",
  "jpProxyUrl": "http://your-japanese-proxy.com",
  "primaryUrl": "https://www.fa.omron.co.jp/product/item/E6F-AG5C-C_360P_R_2M",
  "fallbackUrl": "https://www.fa.omron.co.jp/product/closed/search?keyword=E6F-AG5C-C%20360P%2FR%202M"
}
```

## Implementation Logic

### Step 1: Scrape Primary URL
1. Use Puppeteer to launch browser with the Japanese proxy (`jpProxyUrl`)
2. Navigate to `primaryUrl`
3. Wait for page to load completely
4. Extract the full page HTML content

### Step 2: Check for Error Message
Check if the scraped content contains the following error message:
```
大変申し訳ございませんお探しのページが見つかりませんでした
```

### Step 3: Fallback Logic
- **If error message is NOT found**:
  - Primary URL is successful
  - Proceed to Step 4 with the primary URL content

- **If error message IS found**:
  - Primary URL failed (product page not found)
  - Use Puppeteer to scrape `fallbackUrl` through the same Japanese proxy
  - Extract the full page HTML content from fallback URL
  - Proceed to Step 4 with the fallback URL content

### Step 4: Send Callback
Send the successful page content back to the callback URL:

```json
{
  "jobId": "job_123456789_abc123",
  "urlIndex": 0,
  "url": "https://www.fa.omron.co.jp/product/item/E6F-AG5C-C_360P_R_2M",
  "title": "オムロン E6F-AG5C-C 360P/R 2M Product Page",
  "snippet": "Direct product page for オムロン E6F-AG5C-C 360P/R 2M",
  "fullContent": "<html>... scraped content ...</html>"
}
```

**Note**: The `url` field in the callback should reflect which URL was ultimately successful (primary or fallback).

## Proxy Configuration
- Use the same proxy configuration approach as the existing IDEC dual-site implementation
- The proxy should be configured in Puppeteer's launch options
- Ensure proper error handling if the proxy fails

## Error Handling
- If both primary and fallback URLs fail due to proxy/network issues, send error callback
- Log all scraping attempts for debugging
- Use retry logic for transient network errors

## Example Puppeteer Code Structure
```javascript
const browser = await puppeteer.launch({
  args: [`--proxy-server=${jpProxyUrl}`],
  // ... other options
});

const page = await browser.newPage();

// Try primary URL
await page.goto(primaryUrl, { waitUntil: 'networkidle0' });
const primaryHtml = await page.content();

// Check for error message
const hasError = primaryHtml.includes('大変申し訳ございませんお探しのページが見つかりませんでした');

let finalUrl = primaryUrl;
let finalContent = primaryHtml;

if (hasError) {
  // Try fallback URL
  await page.goto(fallbackUrl, { waitUntil: 'networkidle0' });
  finalContent = await page.content();
  finalUrl = fallbackUrl;
}

await browser.close();

// Send callback with finalContent and finalUrl
```

## Environment Variables
The Render service should expect these environment variables:
- `JP_PROXY`: Japanese proxy URL (format: `http://proxy-host:port`)
- `US_PROXY`: US proxy URL (for IDEC, not used by Omron)

## Testing
Test with the following product model:
- **Model**: `E6F-AG5C-C 360P/R 2M`
- **Primary URL**: Should be preprocessed to `E6F-AG5C-C_360P_R_2M` (spaces and `/` replaced with `_`)
- Expected to work with Japanese proxy
