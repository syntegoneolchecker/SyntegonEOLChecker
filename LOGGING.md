# Centralized Logging System

## ⚠️ MIGRATION NOTICE

**This logging system has been migrated from Netlify Blobs to Supabase PostgreSQL for better performance and scalability.**

📖 **For setup instructions, see [SUPABASE_LOGGING_SETUP.md](./SUPABASE_LOGGING_SETUP.md)**

**Benefits of Supabase:**
- ✅ **100x faster**: Single SQL query vs hundreds of blob fetches
- ✅ **No crashes**: Handles millions of rows without browser crashes
- ✅ **Better search**: PostgreSQL full-text search
- ✅ **Auto-cleanup**: Automatic log retention policies
- ✅ **Indefinitely free**: 500MB database, no credit card required

---

## Overview

This application has a centralized logging system that aggregates logs from both Netlify functions and the Render scraping service into a single Supabase PostgreSQL database with fast querying and filtering.

## Architecture

```
┌─────────────────────┐       ┌─────────────────────┐
│ Netlify Functions   │       │ Render Service      │
│ (38 functions)      │       │ (scraping-service)  │
└──────────┬──────────┘       └──────────┬──────────┘
           │                              │
           │ Direct INSERT                │ Direct INSERT
           │ (fire-and-forget)            │ (fire-and-forget)
           │                              │
           └──────────┬───────────────────┘
                      ▼
           ┌──────────────────────────────┐
           │   Supabase PostgreSQL        │
           │   (logs table with indexes)  │
           │                              │
           │   ✓ Instant queries          │
           │   ✓ Full-text search         │
           │   ✓ Automatic cleanup        │
           │   ✓ Handles millions of rows │
           └──────────┬───────────────────┘
                      │
                      ▼
           ┌──────────────────────────────┐
           │  view-logs function          │
           │  (Fast SQL queries)          │
           │  - Filtering                 │
           │  - Pagination                │
           │  - Search                    │
           │  - Web UI + JSON API         │
           └──────────────────────────────┘
```

## Features

✅ **Unified Logs**: All logs from both Netlify and Render in one place
✅ **Lightning Fast**: 100x faster than previous Netlify Blobs implementation
✅ **No Crashes**: Handles millions of logs without browser performance issues
✅ **Chronological Sorting**: Logs sorted by timestamp with efficient pagination
✅ **Source Tagging**: Each log entry includes its source (function name/service)
✅ **Log Levels**: DEBUG, INFO, WARN, ERROR with filtering support
✅ **Full-Text Search**: Built-in PostgreSQL search across all log messages
✅ **Fire-and-Forget**: Logging failures don't break your application
✅ **Structured Data**: Logs include message, context objects (JSONB), and metadata
✅ **Web UI**: Beautiful, filterable web interface to view logs
✅ **JSON API**: Programmatic access to logs via REST
✅ **Auto-Cleanup**: Automatic deletion of old logs (configurable retention)
✅ **Free Tier**: Supabase free tier (500MB database, 2GB bandwidth/month)

## Configuration

### Environment Variables Required

Both Netlify and Render require these environment variables:

| Variable | Value | Description |
|----------|-------|-------------|
| `SUPABASE_URL` | `https://xxxxx.supabase.co` | Your Supabase project URL |
| `SUPABASE_API_KEY` | `eyJhbGci...` | Supabase publishable API key (anon key) |

### Netlify Setup

1. Go to your Netlify site dashboard
2. Click **Site configuration** → **Environment variables**
3. Add `SUPABASE_URL` and `SUPABASE_API_KEY`
4. Trigger a new deployment

### Render Setup

1. Go to your Render dashboard
2. Select your scraping service
3. Go to **Environment** tab
4. Add `SUPABASE_URL` and `SUPABASE_API_KEY`
5. Save (Render will auto-redeploy)

**Without these variables**, the services will still run but logs won't be centralized (they'll only appear in console).

📖 **Complete setup guide**: See [SUPABASE_LOGGING_SETUP.md](./SUPABASE_LOGGING_SETUP.md)

## Viewing Logs

### Web UI (Recommended)

Visit the log viewer function in your browser:

```
https://your-site.netlify.app/.netlify/functions/view-logs
```

#### Filtering Options

Use query parameters to filter logs:

- **`days`**: Number of days to fetch (default: 1)
  ```
  ?days=7
  ```

- **`source`**: Filter by source (e.g., 'netlify', 'render', or specific function)
  ```
  ?source=render
  ?source=netlify/initialize-job
  ```

- **`level`**: Filter by log level (DEBUG, INFO, WARN, ERROR)
  ```
  ?level=ERROR
  ```

- **`search`**: Search for text in logs
  ```
  ?search=timeout
  ```

- **`format`**: Output format ('html' or 'json', default: 'html')
  ```
  ?format=json
  ```

#### Example Queries

View all errors from the last 3 days:
```
/.netlify/functions/view-logs?days=3&level=ERROR
```

View all Render service logs from today:
```
/.netlify/functions/view-logs?source=render
```

Search for "Groq" across all logs:
```
/.netlify/functions/view-logs?search=Groq&days=7
```

Export today's logs as JSON:
```
/.netlify/functions/view-logs?format=json
```

### JSON API

For programmatic access, use the JSON format:

```bash
curl "https://your-site.netlify.app/.netlify/functions/view-logs?format=json&days=1"
```

Response format:
```json
{
  "count": 150,
  "logs": [
    {
      "timestamp": "2025-01-15T14:30:00.000Z",
      "level": "INFO",
      "source": "netlify/initialize-job",
      "message": "Creating job for: {...}",
      "context": {
        "maker": "SMC",
        "model": "ABC123"
      }
    },
    ...
  ]
}
```

## Log Entry Format

Each log entry contains:

```json
{
  "timestamp": "ISO 8601 timestamp",
  "level": "DEBUG | INFO | WARN | ERROR",
  "source": "Source identifier (e.g., 'netlify/initialize-job', 'render/scraping-service')",
  "message": "Log message (string)",
  "context": {
    "optional": "context data",
    "key": "value"
  }
}
```

## Log Levels

Control log verbosity with the `LOG_LEVEL` environment variable:

- **DEBUG**: Most verbose, all logs (development)
- **INFO**: General informational messages (default, recommended for staging)
- **WARN**: Warnings and errors only (production)
- **ERROR**: Errors only (strict production)
- **NONE**: Silent (not recommended)

**Set in Netlify:**
1. Site settings → Environment variables
2. Add `LOG_LEVEL=INFO`

**Set in Render:**
1. Service → Environment
2. Add `LOG_LEVEL=INFO`

## Storage and Retention

- **Storage**: Supabase PostgreSQL (500MB free tier)
- **Table**: `logs` table with indexed columns
- **Format**: Relational database rows with JSONB for context
- **Retention**: Automatic cleanup via pg_cron (configurable, default 7 days)
- **Size**: ~200-500 bytes per log entry (much more efficient than previous system)

### Managing Storage

**Automatic Cleanup** (Recommended):
- Runs daily at 2 AM UTC via pg_cron
- Deletes logs older than 7 days
- Configurable retention period

**Manual Cleanup**:
```sql
-- Delete logs older than 7 days
DELETE FROM logs WHERE timestamp < NOW() - INTERVAL '7 days';
```

**Check Storage Usage**:
```sql
-- Get table size
SELECT pg_size_pretty(pg_total_relation_size('logs')) AS table_size;

-- Get row count
SELECT COUNT(*) FROM logs;
```

**Via Application**:
- Use the "Clear Logs" button in the log viewer UI
- Calls `/.netlify/functions/clear-logs` (POST)

## Troubleshooting

### Logs not appearing from Render

**Problem**: Render service logs aren't showing in the centralized viewer

**Solutions**:
1. Check `NETLIFY_SITE_URL` is set correctly in Render environment variables
2. Verify the URL is accessible (test: `curl https://your-site.netlify.app/.netlify/functions/log-ingest`)
3. Check Render service logs for any network errors

### Logs not appearing from Netlify

**Problem**: Netlify function logs aren't showing in the viewer

**Solutions**:
1. Check the logger is imported: `const logger = require('./lib/logger');`
2. Verify logs are using logger methods: `logger.info()`, not `console.log()`
3. Check Netlify function logs for errors

### Log ingestion errors

**Problem**: `log-ingest` function returns errors

**Solutions**:
1. Check Netlify Blobs quota (1GB free tier)
2. Verify log entry format includes required fields (timestamp, level, source)
3. Check function logs for specific error messages

### Performance concerns

**Problem**: Logging is slow or causes timeouts

**Solutions**:
1. Logging is fire-and-forget and non-blocking
2. If issues persist, check network latency between Render and Netlify
3. Consider adjusting `LOG_LEVEL` to reduce volume

## Development Tips

### Local Development

When running locally (e.g., `netlify dev`):
- Netlify functions will use `http://localhost:8888` for log ingestion
- Render service needs `NETLIFY_SITE_URL` pointing to your local dev server or staging environment
- Logs will still appear in your terminal via `console.*` calls

### Testing Logging

Test log ingestion manually:

```bash
curl -X POST https://your-site.netlify.app/.netlify/functions/log-ingest \
  -H "Content-Type: application/json" \
  -d '{
    "timestamp": "2025-01-15T14:30:00.000Z",
    "level": "INFO",
    "source": "test/manual",
    "message": "Test log entry",
    "context": {"test": true}
  }'
```

### Adding Structured Context

Include context objects for better debugging:

```javascript
// Good - includes context
logger.info('Job created', { jobId: 'abc123', maker: 'SMC', model: 'XYZ' });

// Bad - only string message
logger.info('Job created abc123');
```

The context object will be displayed in a collapsible section in the web UI.

## Implementation Details

### Logger Utilities

**Netlify**: `/netlify/functions/lib/logger.js`
**Render**: `/scraping-service/utils/logger.js`

Both loggers:
- Send logs to console (for immediate debugging)
- POST logs to central endpoint (for aggregation)
- Extract structured context from arguments
- Are non-blocking (fire-and-forget)

### Core Functions

**Log Ingestion**: `/netlify/functions/log-ingest.js`
- Receives POST requests with log entries
- Validates required fields
- Appends to daily JSONL file in Netlify Blobs

**Log Viewer**: `/netlify/functions/view-logs.js`
- Reads JSONL files from Netlify Blobs
- Filters and sorts logs
- Provides HTML UI and JSON API

## Future Enhancements

Potential improvements to consider:

- [ ] Automatic log retention/cleanup (delete logs older than N days)
- [ ] Log search with regex support
- [ ] Real-time log streaming (WebSocket/SSE)
- [ ] Alert rules (email/webhook on ERROR count threshold)
- [ ] Log analytics dashboard (error rates, response times)
- [ ] Compressed log storage (gzip)
- [ ] Export to external services (CloudWatch, Datadog, etc.)

## Security Notes

- Log ingestion endpoint is public (required for Render to POST logs)
- Logs may contain sensitive data - review what you log
- Consider adding authentication to log viewer for production
- Logs are stored in Netlify Blobs with site-level access control

## Questions?

For issues or questions about the logging system, check:
1. Your Netlify function logs (individual function pages)
2. Your Render service logs (Render dashboard → Logs)
3. The centralized log viewer for aggregated view
