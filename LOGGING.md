# Centralized Logging System

## Overview

This application has a centralized logging system that aggregates logs from both Netlify functions and the Render scraping service into a single Supabase PostgreSQL database with fast querying and filtering.

**Benefits of Supabase PostgreSQL:**

- **Fast queries**: Single SQL query vs hundreds of blob fetches
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

## Supabase Setup Guide

### Step 1: Create Supabase Account and Project

1. Go to [https://supabase.com](https://supabase.com)
2. Click "Start your project"
3. Sign in with GitHub (recommended) or email
4. Click "New Project" in your organization
5. Fill in:
    - **Name**: `eol-checker-logs` (or your preference)
    - **Database Password**: Generate a strong password
    - **Region**: Choose closest to your Netlify deployment
    - **Pricing Plan**: **Free** (500MB database)
6. Click "Create new project" and wait for initialization

### Step 2: Create Logs Table

Open the **SQL Editor** in your Supabase project dashboard and run:

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

Verify with: `SELECT * FROM logs LIMIT 1;` (should return empty result with correct columns).

### Step 3: Set Up Automatic Log Cleanup (Optional but Recommended)

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

> **Note**: No RLS policies are needed because we use a secret key (`sb_secret_...`) or
> `service_role` key, which bypasses RLS. This satisfies security requirements while
> allowing full server-side access.

Schedule automatic cleanup with pg_cron:

1. In Supabase dashboard, go to **Database** > **Extensions**
2. Search for `pg_cron` and click **Enable**
3. Run in SQL Editor:

```sql
SELECT cron.schedule(
  'daily-log-cleanup',
  '0 2 * * *',
  $$SELECT cleanup_old_logs()$$
);
```

### Step 4: Get API Credentials

1. In Supabase dashboard, click **Settings** > **API**
2. Copy the **Project URL** (format: `https://xxxxx.supabase.co`)
3. Copy the **Secret key** (starts with `sb_secret_...`)
    - This is a server-side only key - never expose it in client-side code
    - The secret key bypasses Row Level Security (RLS) and is intended for backend use
    - If you don't have the new key format yet, you can use the legacy `service_role` key instead

### Step 5: Configure Environment Variables

#### Netlify

1. Go to your Netlify site dashboard
2. Click **Site configuration** > **Environment variables**
3. Add:

| Key                | Value                             |
| ------------------ | --------------------------------- |
| `SUPABASE_URL`     | `https://xxxxx.supabase.co`       |
| `SUPABASE_API_KEY` | `sb_secret_...` (your secret key) |

#### Render

1. Go to your Render dashboard > select your scraping service
2. Go to **Environment** tab
3. Add the same `SUPABASE_URL` and `SUPABASE_API_KEY` variables
4. Save (Render will auto-redeploy)

**Without these variables**, the services will still run but logs won't be centralized (they'll only appear in console output).

### Step 6: Verify Setup

1. Trigger any action in the application (e.g., check EOL status for a product)
2. Check the logs table in Supabase dashboard > **Table Editor**
3. View logs in the application: `https://your-site.netlify.app/.netlify/functions/view-logs`

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

Visit the log viewer in your browser:

```
https://your-site.netlify.app/.netlify/functions/view-logs
```

#### Filtering Options

| Parameter | Type   | Default | Description                               |
| --------- | ------ | ------- | ----------------------------------------- |
| `days`    | number | 1       | Number of days to show                    |
| `level`   | string | (all)   | Filter by level: DEBUG, INFO, WARN, ERROR |
| `source`  | string | (all)   | Filter by source (partial match)          |
| `search`  | string | (all)   | Search in message text                    |
| `limit`   | number | 100     | Logs per page (max 1000)                  |
| `offset`  | number | 0       | Pagination offset                         |
| `format`  | string | html    | Output format: html or json               |

#### Example Queries

```
# View all errors from the last 3 days
/.netlify/functions/view-logs?days=3&level=ERROR

# View all Render service logs from today
/.netlify/functions/view-logs?source=render

# Search for "Groq" across all logs
/.netlify/functions/view-logs?search=Groq&days=7

# Export today's logs as JSON
/.netlify/functions/view-logs?format=json
```

### JSON API

```bash
curl "https://your-site.netlify.app/.netlify/functions/view-logs?format=json&days=1"
```

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

## Implementation Details

### Logger Utilities

- **Netlify**: `netlify/functions/lib/logger.js`
- **Render**: `scraping-service/utils/logger.js`
- **Shared**: `shared/logger-factory.js`

Both loggers send logs to console (for immediate debugging) and POST to Supabase (for aggregation). Logging is fire-and-forget and non-blocking - failures don't break the application.

## Storage and Retention

- **Storage**: Supabase PostgreSQL (500MB free tier)
- **Table**: `logs` table with indexed columns
- **Retention**: Automatic cleanup via pg_cron (configurable, default 7 days)
- **Size**: ~200-500 bytes per log entry

### Manual Cleanup

```sql
-- Delete logs older than 7 days
DELETE FROM logs WHERE timestamp < NOW() - INTERVAL '7 days';

-- Check table size
SELECT pg_size_pretty(pg_total_relation_size('logs')) AS table_size;

-- Get row count
SELECT COUNT(*) FROM logs;
```

You can also use the "Clear Logs" button in the log viewer UI, which calls `/.netlify/functions/clear-logs` (POST).

## Troubleshooting

### Logs not appearing

1. Check `SUPABASE_URL` and `SUPABASE_API_KEY` are set correctly in both Netlify and Render environment variables
2. Verify `SUPABASE_URL` doesn't have a trailing slash
3. Ensure the logger is imported (`const logger = require('./lib/logger')`) and used (`logger.info()`, not `console.log()`)
4. Check Supabase dashboard > Table Editor > logs table for rows
5. Check Netlify/Render function logs for errors

### "Supabase not configured" error

1. Environment variables are missing - add them in the Netlify/Render dashboard
2. Trigger a new deployment after adding environment variables
3. Verify variable names are exactly `SUPABASE_URL` and `SUPABASE_API_KEY` (case-sensitive)

### Permission errors

1. Verify you're using a secret key (`sb_secret_...`) or `service_role` key, not the `anon` key
2. The secret key bypasses RLS and has full access
3. Ensure RLS is enabled on the table (`ALTER TABLE logs ENABLE ROW LEVEL SECURITY;`) - the secret key bypasses it, so no policies are needed

### Storage limit reached

1. Free tier has 500MB limit - check current usage in dashboard
2. Run manual cleanup: `DELETE FROM logs WHERE timestamp < NOW() - INTERVAL '3 days';`
3. Reduce retention period in cleanup function if needed

### Slow queries

1. Verify indexes exist: `SELECT indexname FROM pg_indexes WHERE tablename = 'logs';`
2. Should show: `logs_pkey`, `idx_logs_timestamp`, `idx_logs_level`, `idx_logs_source`
3. If missing, recreate them (see Step 2 above)

## Security Notes

- Logs are written directly to Supabase from each service
- Logs may contain sensitive data - review what you log
- The log viewer is protected with authentication
- Logs are stored in Supabase with project-level access control
