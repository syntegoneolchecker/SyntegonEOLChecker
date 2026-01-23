# Syntegon EOL Checker

An automated End-of-Life (EOL) status checker for industrial products. The system uses AI-powered web scraping to determine if products are discontinued and identify their successors.

Why is the repository public? 
  -> In order to use SonarCloud for free, the repository must be public.

## 🔒 Security Notice

**This repository is safe to be public.** All sensitive data is properly secured:

- ✅ **API Keys**: Stored in Netlify environment variables (never committed to repo)
- ✅ **Database**: SAP part numbers and product data stored in Netlify Blobs (not in repo)
- ⚠️ **Important**: Never commit `.env` files or API keys to this repository

If you're forking this project, make sure to set up your own environment variables (see setup instructions below).

## Architecture

- **Frontend**: Static HTML/CSS/JavaScript hosted on Netlify
- **Backend**: Netlify Functions (serverless)
- **Scraping Service**: Node.js + Puppeteer service deployed on Render
- **Storage**: Netlify Blobs (for database and job state)
- **Logging**: Supabase PostgreSQL (centralized logging)
- **APIs**:
  - SerpAPI (web search)
  - Groq (LLM analysis)
  - BrowserQL/Browserless (Cloudflare bypass)

## Key Features

- **Manual EOL Checks**: Check individual products on-demand
- **Automated Daily Checks**: Schedule up to 20 automatic EOL checks per day (21:00 GMT+9)
- **Multiple Scraping Methods**:
  - Fast fetch (PDFs)
  - Puppeteer (General websites, Javascript-heavy sites supported)
  - BrowserQL (Cloudflare-protected sites)
  - Interactive search (manufacturer-specific)
- **Excel Import/Export**: Bulk manage product database
- **Smart Content Extraction**: AI-powered table detection and product mention extraction with advanced truncation logic to fit token limits

## Environment Variables

### **Netlify Functions**

Set these in your Netlify dashboard under Site Settings > Environment Variables:

| Variable | Description | Example | Secret/Public |
|----------|-------------|---------|---------------|
| `ALLOWED_EMAIL_DOMAIN` | Allowed email domain for registration | `syntegon.com` | Public |
| `BROWSERQL_API_KEY` | Browserless.io API key (for Cloudflare bypass) | `abc123...` | Secret |
| `EMAIL_PASSWORD` | Gmail app password for SMTP | `xxxx xxxx xxxx xxxx` | Secret |
| `EMAIL_USER` | Gmail account for sending emails | `your-account@gmail.com` | Public |
| `GROQ_API_KEY` | Groq LLM API key | `gsk_abc123...` | Secret |
| `JWT_SECRET` | Secret key for JWT tokens (REQUIRED) | `your-random-64-char-hex` | Secret |
| `LOG_LEVEL` | Logging level | `info` | Public |
| `NETLIFY_TOKEN` | Token for Netlify Blobs access | Provided by Netlify | Secret |
| `SCRAPING_API_KEY` | API key for authenticating with Render scraping service | `your-secret-key` | Secret |
| `SCRAPING_SERVICE_URL` | URL of Render scraping service | `https://eolscrapingservice.onrender.com` | Public |
| `SERPAPI_API_KEY` | SerpAPI web search API key | `abc123...` | Secret |
| `SUPABASE_URL` | Supabase project URL (for logging) | `https://xxxxx.supabase.co` | Public |
| `SUPABASE_API_KEY` | Supabase anon key (for logging) | `eyJhbGci...` | Secret |

## API Rate Limits

- **SerpAPI**: 250 searches/month (free tier)
- **Groq**: 8000 tokens/minute, 200000 tokens/day (rolling window)
- **BrowserQL**: 1000 credits/month (1 credit = 30 seconds)
- **Render**: 750 instance hours/month (free tier)

## Setup Instructions

### 1. Netlify Deployment

```bash
# Install Netlify CLI
npm install -g netlify-cli

# Login to Netlify
netlify login

# Initialize site
netlify init

# Set environment variables
netlify env:set SERPAPI_API_KEY "your-key"
netlify env:set GROQ_API_KEY "your-key"
netlify env:set BROWSERQL_API_KEY "your-key"
netlify env:set SCRAPING_API_KEY "your-secret-key"
netlify env:set SCRAPING_SERVICE_URL "https://your-render-url.onrender.com"
netlify env:set SUPABASE_URL "https://xxxxx.supabase.co"
netlify env:set SUPABASE_API_KEY "your-supabase-anon-key"

# Deploy
netlify deploy --prod
```

### 2. Render Scraping Service Deployment

1. Create new Web Service on Render
2. Connect GitHub repository
3. Root directory: `scraping-service`
4. Build command: `npm install`
5. Start command: `npm start`
6. Instance type: Free (512 MB RAM)
7. Set Environment Variables:
   - `SCRAPING_API_KEY`: Same secret key as set in Netlify (for authentication)
   - `ALLOWED_ORIGINS`: Your Netlify site URL (e.g., `https://your-site.netlify.app`)

**Important**: The service will spin down after 15 minutes of inactivity. Cold starts take ~1 minute.

### 3. Scheduled Background Checks

The system includes a Netlify scheduled function that runs daily at **21:00 GMT+9 (12:00 UTC)**.

**To enable**:
1. Deploy to Netlify
2. Netlify automatically detects and registers the scheduled function
3. Toggle the auto-check slider in the UI

**Configuration**:
- Max 20 checks per day (reduced to conserve SerpAPI credits)
- Runs at 21:00 GMT+9 daily
- Auto-disables if SerpAPI credits < 30
- Chain-based execution (avoids 15min function timeout)
- Scheduled functions only trigger on the production deploy on netlify (currently the branch named "main")

## Database Schema

The CSV database has 13 columns:

| Column | Index | Description |
|--------|-------|-------------|
| SAP Part Number | 0 | Primary identifier |
| Legacy Part Number | 1 | Old part number |
| Designation | 2 | Product name |
| Model | 3 | Model number (used for EOL check) |
| Manufacturer | 4 | Maker name (used for EOL check) |
| Status | 5 | ACTIVE / DISCONTINUED / UNKNOWN |
| Status Comment | 6 | Explanation from LLM |
| Successor Model | 7 | Replacement product model |
| Successor Comment | 8 | Explanation about successor |
| Successor SAP Number | 9 | SAP number of replacement |
| Stock | 10 | Current stock level |
| Information Date | 11 | Last check timestamp |
| Auto Check | 12 | Enable/disable for auto-check(put "NO" to disable) |

## Development

### Local Development

```bash
# Install dependencies
npm install

# Run Netlify dev server (includes functions)
netlify dev

# Or use Netlify CLI to test functions
netlify functions:serve
```

### Scraping Service Local Development

```bash
cd scraping-service
npm install

# Run with garbage collection enabled (recommended)
node --expose-gc index.js

# Or use npm start
npm start
```

### Testing Scraping Service

```bash
# Health check
curl https://your-service.onrender.com/health

# Test scraping
curl -X POST https://your-service.onrender.com/scrape \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com",
    "callbackUrl": "https://your-site.netlify.app/.netlify/functions/scraping-callback",
    "jobId": "test-123",
    "urlIndex": 0
  }'
```

## Troubleshooting

### Memory Issues (Render)

The scraping service monitors memory and automatically restarts when approaching the 512 MB limit. Current thresholds:

- **Warning**: 380 MB (logs detailed memory info)
- **Restart**: 450 MB (62 MB buffer before OOM)

Check logs for memory tracking:
```
Memory before scrape: RSS=250MB, Heap=180/220MB
⚠️  Memory approaching limit: 390MB RSS
```

### Groq Rate Limits

The system checks Groq token availability before analysis:
- Waits for token reset if < 500 tokens remain
- Max 3 retries with exponential backoff
- Logs token usage: `Groq tokens remaining: 1200, reset in: 7.5s`

### Job Timeouts

Jobs poll for 2 minutes (60 attempts × 2s):
```
Polling job abc123 (max 60 attempts, 2 minutes)
```

If a job times out:
1. Check Netlify function logs
2. Check Render scraping service logs
3. Verify scraping service is not in cold start
4. Check Groq token availability

### Cold Starts

Render free tier spins down after 15 minutes of inactivity:
- First request after spin-down: **~60 seconds**
- Subsequent requests: **~1-5 seconds**

The auto-check background function wakes up Render on the first daily check.

## Cost Breakdown

**Current monthly costs** (all free tiers):

- Netlify: Free (100GB bandwidth, 300 build minutes)
- Render: Free (512MB RAM, 750 instance hours/month)
- SerpAPI: Free (250 searches/month)
- Groq: Free (rate-limited but no hard cap)
- BrowserQL: Free (1000 credits/month)
- Supabase: Free (500MB database, 2GB bandwidth/month)

**Estimated capacity**:
- 10 products/day × 30 days = 300 products/month (limited by SerpAPI)
- Capacity much higher when using manufacturer-specific direct URL strategies (bypasses search)

## License

Internal use only.
