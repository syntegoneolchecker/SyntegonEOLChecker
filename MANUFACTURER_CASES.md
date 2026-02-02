# Manufacturer Cases Documentation

This document describes the flow for all manufacturer-specific URL strategies implemented in the EOL Checker application. The main logic is in `netlify/functions/initialize-job.js` with scraping implementations in `netlify/functions/fetch-url.js`.

## Overview

When a job is initialized, the system checks if the manufacturer has a specific URL strategy via `getManufacturerUrl()`. If a strategy exists, it bypasses the SerpAPI search and uses a direct URL approach. If no strategy exists, it falls back to SerpAPI search.

---

## Manufacturer Cases

### 1. SMC

**Strategy Type:** Direct URL with Render scraping

**URL Pattern:**
```
https://www.smcworld.com/webcatalog/s3s/ja-jp/detail/?partNumber={model}
```

**Flow:**
1. Job initialized → direct URL constructed with encoded model number
2. URL saved to job with `scrapingMethod: 'render'`
3. `fetch-url` sends request to Render service (Puppeteer-based)
4. Render service scrapes page and sends result via callback
5. Content analyzed by LLM

**Notes:** Simple direct product page lookup. No validation required.

---

### 2. ORIENTAL MOTOR

**Strategy Type:** Direct URL with BrowserQL scraping (Cloudflare-protected)

**URL Pattern:**
```
https://www.orientalmotor.co.jp/ja/products/products-search/replacement?hinmei={model}
```

**Flow:**
1. Job initialized → direct URL constructed with encoded model number
2. URL saved to job with `scrapingMethod: 'browserql'`
3. `fetch-url` routes to `handleBrowserQL()` function
4. Uses `scrapeWithBrowserQL()` from `lib/browserql-scraper.js`
5. BrowserQL bypasses Cloudflare protection via Browserless stealth mode
6. Content saved and analyzed by LLM

**Notes:** Site is Cloudflare-protected, requiring BrowserQL instead of standard Render service.

---

### 3. MISUMI

**Strategy Type:** Direct URL with Render scraping

**URL Pattern:**
```
https://jp.misumi-ec.com/vona2/result/?Keyword={model}
```

**Flow:**
1. Job initialized → search URL constructed with encoded model number
2. URL saved to job with `scrapingMethod: 'render'`
3. `fetch-url` sends request to Render service
4. Render service scrapes search results page
5. Content analyzed by LLM

**Notes:** Uses MISUMI's search endpoint rather than a direct product page.

---

### 4. NTN

**Strategy Type:** Validation required with BrowserQL scraping

**URL Pattern:**
```
https://www.motion.com/products/search;q={model};facet_attributes.MANUFACTURER_NAME=NTN
```

**Flow:**
1. Job initialized → search URL constructed with model and NTN manufacturer filter
2. `requiresValidation: true` triggers validation before saving
3. `handleStandardValidationStrategy()` scrapes page with BrowserQL
4. Checks for "no results" patterns via `hasNoSearchResults()`:
   - Pattern checked: `"no results for:"`
5. **If results found:** URL saved with scraped content already attached (status: `ready_for_analysis`)
6. **If no results:** Falls back to SerpAPI search
7. Content analyzed by LLM

**Notes:** Uses motion.com for NTN product searches. Validation ensures results exist before committing to this URL.

---

### 5. KEYENCE

**Strategy Type:** Interactive search via Render service (special endpoint)

**URL Pattern:**
```
https://www.keyence.co.jp/ (base URL only)
```

**Scraping Method:** `keyence_interactive`

**Flow:**
1. Job initialized → base URL saved with `scrapingMethod: 'keyence_interactive'`
2. Model number passed separately in `model` field
3. `fetch-url` routes to `handleKeyenceInteractive()` function
4. Calls Render service's `/scrape-keyence` endpoint with:
   - `model`: Product model to search
   - `callbackUrl`: Callback for results
   - `jobId`, `urlIndex`: Job tracking
5. Render service performs interactive search:
   - Navigates to KEYENCE site
   - Performs search interaction with model number
   - Scrapes resulting product page
6. Results returned via callback
7. Content analyzed by LLM

**Notes:** KEYENCE requires interactive browser automation because the search is not accessible via direct URL parameters.

---

### 6. TAKIGEN

**Strategy Type:** Validation with URL extraction from search results

**URL Pattern (Search):**
```
https://www.takigen.co.jp/search?k={model}&d=0
```

**Flow:**
1. Job initialized → search URL constructed
2. `requiresValidation: true` and `requiresExtraction: true` triggers extraction strategy
3. `handleExtractionStrategy()` fetches search HTML via `fetchHtml()` (simple HTTP, no JavaScript)
4. `extractTakigenProductUrl()` parses HTML:
   - Looks for: `<div class="p-4 flex flex-wrap flex-col md:flex-row">`
   - Extracts first product href matching `/products/detail/*`
5. **If product found:** Constructs full URL: `https://www.takigen.co.jp{productPath}`
   - Saves extracted URL to job
   - Returns status: `takigen_extracted_url`
6. **If no product found:** Falls back to SerpAPI search
7. Content scraped via Render and analyzed by LLM

**Notes:** Two-step process: first searches, then extracts and uses the actual product page URL.

---

### 7. NISSIN ELECTRONIC

**Strategy Type:** Validation with 404 page check

**URL Pattern:**
```
https://nissin-ele.co.jp/product/{model}
```

**Flow:**
1. Job initialized → direct product URL constructed
2. `requiresValidation: true` and `requires404Check: true` triggers 404 check strategy
3. `handle404CheckStrategy()` fetches page via `fetchHtml()`
4. `is404Page()` checks for 404 patterns:
   - `"page not found"`
   - `"ページが見つかりません"`
   - `"404 not found"`
   - `"404 error"`
5. **If valid page:** URL saved to job, returns status: `nissin_validated_url`
6. **If 404 detected:** Falls back to SerpAPI search
7. Content scraped via Render and analyzed by LLM

**Notes:** NISSIN uses predictable product URLs, but not all models exist. 404 check prevents wasting resources on non-existent pages.

---

### 8. MURR (Murrelektronik)

**Strategy Type:** Direct URL with Render scraping

**URL Pattern:**
```
https://shop.murrinc.com/index.php?lang=1&cl=search&searchparam={model}
```

**Flow:**
1. Job initialized → search URL constructed with encoded model number
2. URL saved to job with `scrapingMethod: 'render'`
3. `fetch-url` sends request to Render service
4. Render service scrapes search results page
5. Content analyzed by LLM

**Notes:** Uses MURR's US shop search endpoint.

---

### 9. NBK

**Strategy Type:** Two-step BrowserQL interactive search

**URL Pattern (Search):**
```
https://www.nbk1560.com/search/?q={preprocessedModel}&SelectedLanguage=ja-JP&page=1&imgsize=1&doctype=all&sort=0&pagemax=10&htmlLang=ja
```

**Scraping Method:** `nbk_interactive`

**Model Preprocessing:** Removes lowercase `x` and `-` characters from model name

**Flow:**
1. Job initialized → search URL constructed with preprocessed model
2. `scrapingMethod: 'nbk_interactive'` set
3. `fetch-url` routes to `handleNbkInteractive()` function
4. **Step 1 - Search:** `scrapeNBKSearchWithBrowserQL(model)`:
   - Preprocesses model: removes `x` and `-`
   - Uses BrowserQL GraphQL mutation to:
     - Navigate to search URL
     - Extract search results from `.topListSection-body ._item`
     - Get first product link from `a._link`
   - Returns `hasResults` and `productUrl`
5. **If no results:** Saves "no results" message, continues pipeline
6. **Step 2 - Product Page:** `scrapeNBKProductWithBrowserQL(productUrl)`:
   - Appends `?SelectedLanguage=ja-JP` to force Japanese version
   - Uses shared BrowserQL scraper (`scrapeWithBrowserQL()`)
   - Extracts full product page content
7. Content saved and analyzed by LLM

**Notes:** NBK uses Cloudflare protection, requiring BrowserQL. The two-step process first finds the product URL, then scrapes the product page separately. Model preprocessing handles NBK's naming conventions.

---

## Default Case (SerpAPI Search)

When no manufacturer strategy matches, the system falls back to SerpAPI search:

**Flow:**
1. Constructs search query: `{maker} {model} site:site1 OR site:site2 OR ...`
2. Calls SerpAPI Google search
3. Prioritizes URLs with `prioritizeUrls()`:
   - Exact model matches in URL path come first
   - Regular URLs follow in search result order
4. Screens URLs with `screenAndSelectUrls()`:
   - HTML pages pass automatically
   - PDFs are validated for text extraction
   - Requires minimum character count
5. Up to 2 valid URLs saved to job
6. URLs scraped via Render service
7. Content analyzed by LLM

---

## Summary Table

| Manufacturer | Strategy Type | Scraping Method | Validation | Notes |
|--------------|---------------|-----------------|------------|-------|
| SMC | Direct URL | render | No | Simple product page |
| ORIENTAL MOTOR | Direct URL | browserql | No | Cloudflare-protected |
| MISUMI | Direct URL | render | No | Search endpoint |
| NTN | Validation | browserql | Yes - no results check | motion.com search |
| KEYENCE | Interactive | keyence_interactive | No | Render special endpoint |
| TAKIGEN | Extraction | render | Yes - URL extraction | Two-step: search → product |
| NISSIN ELECTRONIC | 404 Check | render | Yes - 404 check | Direct product URL |
| MURR | Direct URL | render | No | US shop search |
| NBK | Interactive | nbk_interactive | No | Two-step BrowserQL |
| (default) | SerpAPI | render | PDF screening | Fallback for unknown makers |

---

## Scraping Methods Reference

| Method | Handler | Description |
|--------|---------|-------------|
| `render` | `handleRenderDefault()` | Standard Puppeteer via Render service |
| `browserql` | `handleBrowserQL()` | Browserless stealth mode for Cloudflare sites |
| `keyence_interactive` | `handleKeyenceInteractive()` | Render service `/scrape-keyence` endpoint |
| `nbk_interactive` | `handleNbkInteractive()` | Full BrowserQL with custom DOM extraction |
