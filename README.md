# Syntegon EOL Checker
 
An automated End-of-Life (EOL) status checker for machine parts. The system uses web search in combination with AI analysis to determine if products are discontinued and identifies direct successor products.

Why may the repository be public?
-> In order to use SonarCloud for free, the repository must be public.

## Security Notice

**This repository is safe to be public.** All sensitive data is properly secured:

- **API Keys**: Stored in Netlify environment variables (never committed to repo)
- **Database**: SAP part numbers and product data stored in Netlify Blobs (not in repo)
- **Important**: Never commit sensitive information to this repository

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
- **Smart Content Extraction**: Table detection and product mention extraction with advanced truncation logic to fit token limits

## Web Services
For the website to work consistently, the following web services need to be set up and monitored:

### 1. Netlify (Main website deployment)
- Log in with Google account
- Netlify hosts the Syntegon EOL Checker via deployment from GitHub
- Netlify Blobs store account data, background check state information, recent EOL jobs, and the EOL part database
- Environment variables can be viewed and changed in the project configuration
- **Monitor the credit balance** under "Usage & billing"
**Important**: Don't push code to the main branch often. The main branch triggers a production deploy on Netlify which costs a large amount of Netlify tokens.

### 2. Render (Scraping service deployment)
- Log in with Google account
- Render hosts the scraping service used during most EOL checks
- Environment variables can be viewed and changed in the "Environment" tab of the web service
- **Monitor the monthly included usage** under "Billing" in the account settings
**Important**: The service will spin down after 15 minutes of inactivity. Cold starts take around 1 minute.

#### Testing Scraping Service

```bash
# Health check
curl https://your-service.onrender.com/health

# Test scraping
curl -X POST http://localhost:3000/scrape \
  -H "Content-Type: application/json" \
  -H "X-API-Key: your-scraping-api-key" \
  -d '{
    "url": "https://example.com",
    "callbackUrl": "http://localhost:8888/.netlify/functions/scraping-callback",
    "jobId": "test-123",
    "urlIndex": 0
  }'
```

### 3. SerpAPI (Web search API)
- Log in with Google account
- SerpAPI is the web search API used during EOL checks without a normalized manufacturer case
- **Monitor the searches per month** on the top right of the dashboard

### 4. Groq (LLM provider)
- Log in with Google account
- Groq provides the GPT OSS 120B LLM model used during EOL checks to infer EOL information from sources
- **Monitor the usage** on the dashbaord

### 5. Browserless (Cloudflare bypass)
- Log in with Google account
- Browserless is used to bypass Cloudflare protection during certain manufacturer cases
- **Monitor the unit usage** on the dashboard

### 6. Gmail Account for SMTP (Sender for account related emails)
- Log in with Google account
- Gmail is used to send emails with registration confirmation and account deletion links (and is the Google account used to sign in to many other services)
- **Monitor the inbox** for information on maintenance periods of web services or other relevant information

### 7. SupaBase (Centralized log database) - optional
- Log in with GitHub account
- SupaBase hosts the PostGreSQL database which collects logs from Netlify and Render and allows displaying them on the log viewing page
- The log level set in environment variables decides which logs are being created
- Nothing to monitor, look at the logs for debugging and to check that everything works as intended

### 8. SonarCloud (Code quality metrics) - optional
- Log in with GitHub account
- SonarCloud is the web interface showing code quality metrics and issues that were detected in recent commits
- **Monitor the metrics after each push** to fix issues and security hotspots as soon as they appear

## Environment Variables

### Netlify

Set these in the Netlify project under Project configuration > Environment variables:

| Variable               | Description                                             | Example                                   | Secret/Public |
| ---------------------- | ------------------------------------------------------- | ----------------------------------------- | ------------- |
| `ALLOWED_EMAIL_DOMAIN` | Allowed email domain for registration                   | `syntegon.com`                            | Public        |
| `BROWSERQL_API_KEY`    | Browserless.io API key (for Cloudflare bypass)          | `abc123...`                               | Secret        |
| `EMAIL_PASSWORD`       | Gmail app password for SMTP                             | `xxxx xxxx xxxx xxxx`                     | Secret        |
| `EMAIL_USER`           | Gmail account for sending emails                        | `your-account@gmail.com`                  | Public        |
| `GROQ_API_KEY`         | Groq LLM API key                                        | `gsk_abc123...`                           | Secret        |
| `INTERNAL_API_KEY`     | Internal API key to protect backend endpoints           | `your-secret-key`                         | Secret        |
| `JWT_SECRET`           | Secret key for JWT tokens                               | `your-random-64-char-hex`                 | Secret        |
| `LOG_LEVEL`            | Logging level                                           | `info`                                    | Public        |
| `NETLIFY_TOKEN`        | Token for Netlify Blobs access                          | Provided by Netlify                       | Secret        |
| `SCRAPING_API_KEY`     | API key for authenticating with Render scraping service | `your-secret-key`                         | Secret        |
| `SCRAPING_SERVICE_URL` | URL of Render scraping service                          | `https://eolscrapingservice.onrender.com` | Public        |
| `SERPAPI_API_KEY`      | SerpAPI web search API key                              | `abc123...`                               | Secret        |
| `SUPABASE_URL`         | Supabase project URL (for logging)                      | `https://xxxxx.supabase.co`               | Public        |
| `SUPABASE_API_KEY`     | Supabase secret key (for logging)                       | `sb_secret_abc...`                        | Secret        |

### Render

Set these in the Web Service page under Environment > Environment Variables:

| Variable               | Description                                             | Example                                   | Secret/Public |
| ---------------------- | ------------------------------------------------------- | ----------------------------------------- | ------------- |
| `ALLOWED_ORIGINS`      | Allowed origins that can send requests                  | `netlify-deploy-url.netlify.app`          | Public        |
| `LOG_LEVEL`            | Logging level                                           | `info`                                    | Public        |
| `SCRAPING_API_KEY`     | API key for authenticating requests from Netlify        | `your-secret-key`                         | Secret        |
| `SUPABASE_API_KEY`     | Supabase secret key (for logging)                       | `sb_secret_abc...`                        | Secret        |
| `SUPABASE_URL`         | Supabase project URL (for logging)                      | `https://xxxxx.supabase.co`               | Public        |

## API Rate Limits

- **SerpAPI**: 250 searches/month (free tier)
- **Groq**: 8000 tokens/minute, 200000 tokens/day (rolling window)
- **BrowserQL**: 1000 credits/month (1 credit = 30 seconds)
- **Render**: 750 instance hours/month (free tier)

## Scheduled Background Checks

The system includes a Netlify scheduled function that runs daily at **21:00 GMT+9 (12:00 UTC)**.

**To enable**:

1. Deploy to Netlify
2. Netlify automatically detects and registers the scheduled function
3. Toggle the auto-check slider in the UI

**Configuration**:

- Max 20 checks per day (fits within SerpAPI searches per month and Groq LLM tokens per day)
- Runs at 21:00 GMT+9 daily
- Auto-disables if SerpAPI credits < 30
- Chain-based execution (avoids 15min function timeout)
- Scheduled functions only trigger on the production deploy on netlify (currently the branch named "main")

## Database Schema

The CSV database has 13 columns:

| Column               | Index | Description                                              | EOL Check Usage                |
| -------------------- | ----- | -------------------------------------------------------- | ------------------------------ |
| SAP Part Number      | 0     | Primary identifier                                       | None                           |
| Legacy Part Number   | 1     | Old part number                                          | None                           |
| Designation          | 2     | Product designation                                      | None                           |
| Model                | 3     | Product model name (used for EOL check)                  | Read                           |
| Manufacturer         | 4     | Manufacturer name (used for EOL check)                   | Read                           |
| Status               | 5     | ACTIVE / DISCONTINUED / UNKNOWN                          | Write                          |
| Status Comment       | 6     | Explanation from LLM                                     | Write                          |
| Successor Model      | 7     | Replacement product model                                | Write                          |
| Successor Comment    | 8     | Explanation about successor                              | Write                          |
| Successor SAP Number | 9     | SAP number of replacement                                | None                           |
| Stock                | 10    | Current stock level                                      | None                           |
| Information Date     | 11    | Last check timestamp                                     | Write                          |
| Auto Check           | 12    | Enable/disable automatic EOL check (put "NO" to disable) | Read (during background check) |

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

- Netlify: Free (300 credits/month)
- Render: Free (512MB RAM, 750 instance hours/month)
- SerpAPI: Free (250 searches/month)
- Groq: Free (8000 tokens/minutes, 200000 tokens/day)
- BrowserQL: Free (1000 credits/month)
- Supabase: Free (500MB database, 2GB bandwidth/month)
