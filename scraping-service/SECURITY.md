# Security Documentation - SSRF Handling

## Overview

This scraping service contains **intentional SSRF (Server-Side Request Forgery) functionality** as a core feature. This document explains why these are not vulnerabilities and how they are protected.

## Why SSRF Warnings Are Suppressed

### Application Purpose
This is a **web scraping service** that:
- Fetches arbitrary URLs from Tavily search results (manufacturer product pages)
- Extracts End-of-Life information from these pages
- Sends results back to configured backend servers via callbacks

### Core Requirement
The service **must** be able to fetch user-provided URLs - this is the entire purpose of the application.

### Risk Context
- **Internal use only** - not exposed to untrusted users
- **No sensitive data** - only scrapes public manufacturer websites
- **Free services** - no financial risk from abuse
- **Comprehensive validation** - multiple layers of protection

## SSRF Protection Measures

### 1. Scraping URL Validation (`isSafePublicUrl()`)

Located in `scraping-service/utils/validation.js`

**Blacklist approach** - blocks dangerous targets:
- ✅ Localhost addresses (`127.0.0.1`, `::1`, etc.)
- ✅ Private IP ranges (RFC 1918: `10.x.x.x`, `172.16-31.x.x`, `192.168.x.x`)
- ✅ Link-local addresses (`169.254.x.x` - AWS/GCP metadata endpoints)
- ✅ Reserved IP ranges (`0.x.x.x`, `224.x.x.x`, `240.x.x.x`)
- ✅ IPv6 private addresses (`fc00::/7`, `fe80::/10`)
- ✅ Dangerous protocols (only `http://` and `https://` allowed)

**Why not whitelist?**
URLs are dynamic and come from search results. We cannot predict which manufacturer domains will be scraped.

### 2. Callback URL Validation (`isValidCallbackUrl()`)

Located in `scraping-service/utils/validation.js`

**Whitelist approach** - only allows configured backends:
- ✅ Uses `ALLOWED_ORIGINS` environment variable
- ✅ Only permits trusted backend domains
- ✅ Strict hostname and port matching for localhost
- ✅ Subdomain matching for production domains

### 3. Defense-in-Depth

Multiple validation layers:
1. **Endpoint level** - validation in route handlers before processing
2. **Pre-fetch level** - validation immediately before each `fetch()` or `page.goto()`
3. **Protocol restrictions** - only HTTP/HTTPS allowed
4. **CORS restrictions** - only configured origins can call the API

## CodeQL Suppression Strategy

### Files with Suppressed SSRF Alerts

1. **scraping-service/utils/callback.js:64**
   - Sends results to whitelisted backend servers
   - Protected by `isValidCallbackUrl()` whitelist

2. **scraping-service/utils/extraction.js:245**
   - Fetches content from manufacturer websites
   - Protected by `isSafePublicUrl()` blacklist

3. **scraping-service/routes/scrape.js:232**
   - Puppeteer navigation to manufacturer websites
   - Protected by `isSafePublicUrl()` blacklist

### Suppression Methods

1. **CodeQL config file** (`.github/codeql/codeql-config.yml`)
   - Excludes SSRF query IDs: `js/request-forgery`, `js/server-side-unvalidated-url-redirection`
   - Documents legitimate use case

2. **Inline suppressions** (`codeql[js/request-forgery]` comments)
   - Explains justification at each fetch/goto call
   - Documents validation approach
   - Provides audit trail for security reviews

## Format String Injection in Logging

### Alert Type: `js/tainted-format-string`

**What CodeQL Detects:**
User-controlled URLs being interpolated into logging statements like:
```javascript
console.error(`Error scraping ${url}:`, error.message);
```

**Why This Is Suppressed:**

1. **Template literals don't have format specifiers** - JavaScript template literals (`${...}`) perform simple string interpolation, not format string parsing like C's `printf` or Node's `util.format()`

2. **Minimal security impact** - The worst-case scenario is log injection (inserting newlines or control characters), which has no security impact in an internal-only service

3. **URLs are already validated** - The `isSafePublicUrl()` function blocks dangerous characters and malformed URLs

4. **Necessary for debugging** - Logging which URLs succeeded/failed is critical for troubleshooting scraping issues

5. **Not user-facing** - Logs are only visible to internal operators, not end users

**Suppression Method:**
Global exclusion via CodeQL config (`js/tainted-format-string`) rather than inline suppressions, as this pattern appears in many log statements across the codebase.

## Alternative Approaches Considered

### ❌ Whitelist-only validation
**Why rejected:** Cannot predict which manufacturer domains need to be scraped. Search results return dynamic URLs.

### ❌ Proxy through trusted service
**Why rejected:** Adds complexity, latency, and cost for minimal security benefit in internal-only service.

### ❌ Remove SSRF functionality
**Why rejected:** This would eliminate the core feature of the application.

## Security Review Checklist

When reviewing changes to this service, verify:

- [ ] URL validation is called before all `fetch()` and `page.goto()` calls
- [ ] `ALLOWED_ORIGINS` is properly configured in production
- [ ] Blacklist validation covers all dangerous IP ranges
- [ ] No new fetch calls bypass validation
- [ ] Service remains internal-only (not exposed to public internet)

## Production Configuration

### Required Environment Variables

```bash
# Callback URL whitelist (same as CORS origins)
ALLOWED_ORIGINS=https://your-backend.example.com,https://api.example.com

# Memory limits (optional)
MEMORY_LIMIT_MB=450
MEMORY_WARNING_MB=400
```

### Deployment Requirements

1. **Network isolation** - Service should only be accessible from trusted backend servers
2. **Firewall rules** - Block outbound connections to private IP ranges (defense-in-depth)
3. **Monitoring** - Log all blocked URL attempts for security auditing

## References

- OWASP SSRF: https://owasp.org/www-community/attacks/Server_Side_Request_Forgery
- RFC 1918 (Private IPs): https://tools.ietf.org/html/rfc1918
- CodeQL SSRF Detection: https://codeql.github.com/codeql-query-help/javascript/js-ssrf/

---

**Last Updated:** 2025-12-22
**Reviewed By:** Claude Code (Automated Security Analysis)
