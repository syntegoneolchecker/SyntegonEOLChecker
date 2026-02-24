# Centralized Logging System

## Overview

This application has a centralized logging system that aggregates logs from both Netlify functions and the Render scraping service into a single Supabase PostgreSQL database with fast querying and filtering.

**Benefits of Supabase PostgreSQL:**

- **Fast queries**: Single SQL query instead of hundreds of blob fetches
- **Scalable**: Handles millions of rows without browser crashes
- **Better search**: PostgreSQL full-text search
- **Auto-cleanup**: Automatic log retention policies
- **Free tier**: 500MB database, 2GB bandwidth/month, no credit card required

## Architecture

```
+---------------------+        +---------------------+
| Netlify Functions   |        | Render Service      |
|                     |        | (scraping-service)  |
+----------+----------+        +----------+----------+
           |                              |
           | Direct INSERT                | Direct INSERT
           | (fire-and-forget)            | (fire-and-forget)
           |                              |
           +----------+-------------------+
                      v
           +------------------------------+
           |   Supabase PostgreSQL        |
           |   (logs table with indexes)  |
           +----------+-------------------+
                      |
                      v
           +------------------------------+
           |  view-logs function          |
           |  (Fast SQL queries)          |
           |  - Filtering                 |
           |  - Pagination                |
           |  - Search                    |
           |  - Web UI + JSON API         |
           +------------------------------+
```

## Supabase Setup

Creation of the logs table:

```sql
-- Create logs table
CREATE TABLE logs (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL,
  level TEXT NOT NULL,
  source TEXT NOT NULL,
  message TEXT,
  context JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for fast queries
CREATE INDEX idx_logs_timestamp ON logs(timestamp DESC);
CREATE INDEX idx_logs_level ON logs(level);
CREATE INDEX idx_logs_source ON logs(source);
CREATE INDEX idx_logs_message_search ON logs USING gin(to_tsvector('english', message));

-- Add comment for documentation
COMMENT ON TABLE logs IS 'Centralized application logs from Netlify Functions and Render service';
```

Creation of automatic cleanup function:

```sql
-- Enable RLS (required by Supabase security advisor)
ALTER TABLE logs ENABLE ROW LEVEL SECURITY;

-- Function to delete old logs (with fixed search_path for security)
CREATE OR REPLACE FUNCTION cleanup_old_logs()
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  DELETE FROM public.logs WHERE timestamp < NOW() - INTERVAL '7 days';
END;
$$;

COMMENT ON FUNCTION cleanup_old_logs() IS 'Deletes logs older than 7 days to save storage';
```

Schedule automatic cleanup with pg_cron:

```sql
SELECT cron.schedule(
  'daily-log-cleanup',
  '0 2 * * *',
  $$SELECT cleanup_old_logs()$$
);
```

## Configuration

### Environment Variables

| Variable           | Required | Where            | Description                                                |
| ------------------ | -------- | ---------------- | ---------------------------------------------------------- |
| `SUPABASE_URL`     | Yes      | Netlify + Render | Your Supabase project URL                                  |
| `SUPABASE_API_KEY` | Yes      | Netlify + Render | Supabase secret API key (`sb_secret_...`)                  |
| `LOG_LEVEL`        | No       | Netlify + Render | Filter log level: DEBUG, INFO, WARN, ERROR (default: INFO) |

### Log Levels

Control log verbosity with the `LOG_LEVEL` environment variable:

- **DEBUG**: Most verbose, all logs (development)
- **INFO**: General informational messages (default, recommended for staging)
- **WARN**: Warnings and errors only (production)
- **ERROR**: Errors only (strict production)
- **NONE**: Silent (not recommended)

## Viewing Logs

### Web UI

Visit the log viewer through the "View Logs" button on the main application website

### API Endpoints

| Endpoint                                    | Method | Description                    |
| ------------------------------------------- | ------ | ------------------------------ |
| `/.netlify/functions/view-logs`             | GET    | View and filter logs (HTML UI) |
| `/.netlify/functions/view-logs?format=json` | GET    | Get logs as JSON               |
| `/.netlify/functions/clear-logs`            | POST   | Delete all logs                |

## Log Entry Format

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

## Implementation

### Logger Utilities

- **Netlify**: `netlify/functions/lib/logger.js`
- **Render**: `scraping-service/utils/logger.js`
- **Shared**: `shared/logger-factory.js`

Both loggers send logs to console (for immediate debugging) and POST to Supabase (for aggregation). Logging is fire-and-forget and non-blocking - failures don't break the application.

## Manual Cleanup

```sql
-- Delete logs older than 7 days
DELETE FROM logs WHERE timestamp < NOW() - INTERVAL '7 days';

-- Check table size
SELECT pg_size_pretty(pg_total_relation_size('logs')) AS table_size;

-- Get row count
SELECT COUNT(*) FROM logs;
```

You can also use the "Clear Logs" button in the log viewer UI, which calls `/.netlify/functions/clear-logs` (POST).

