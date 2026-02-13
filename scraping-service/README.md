# EOL Scraping Service

Puppeteer-based web scraping service for the EOL Database Manager.

## Purpose

This service handles dynamic website scraping for general websites, PDFs and Javascript-heavy websites. It runs on Render.com's free tier.

## Endpoints

### `GET /health`

Health check endpoint.

**Response:**

```json
{
	"status": "ok",
	"timestamp": "2025-12-01T10:00:00.000Z"
}
```

### `POST /scrape`

Scrape a single URL. Uses an async callback pattern - the service accepts the request, scrapes in the background, and sends results to the provided callback URL.

**Request:**

```json
{
	"url": "https://example.com/product-page",
	"callbackUrl": "https://your-site.netlify.app/.netlify/functions/scraping-callback",
	"jobId": "job-123",
	"urlIndex": 0
}
```

**Immediate Response (202 Accepted):**

```json
{
	"success": true,
	"message": "Scraping started"
}
```

Results are sent asynchronously to the `callbackUrl` when scraping completes.

### `POST /scrape-keyence`

Interactive search scraping for Keyence products. Same callback pattern as `/scrape`.

**Request:**

```json
{
	"model": "XG-8000",
	"callbackUrl": "https://your-site.netlify.app/.netlify/functions/scraping-callback",
	"jobId": "job-456",
	"urlIndex": 0
}
```

## Deployment to Render.com

See main documentation for deployment steps.

## Local Testing

```bash
npm install
npm start
```

Test with curl:

```bash
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
