# Security Measures Analysis

This document provides a comprehensive analysis of all security measures implemented in the EOL Checker application, their limitations, and references to existing documentation.

## Table of Contents

1. [Authentication Systems](#1-authentication-systems)
2. [Authorization & Access Control](#2-authorization--access-control)
3. [Input Validation & Sanitization](#3-input-validation--sanitization)
4. [Rate Limiting](#4-rate-limiting)
5. [SSRF Protection](#5-ssrf-protection)
6. [Session Management](#6-session-management)
7. [Secrets Management](#7-secrets-management)
8. [CORS & Security Headers](#8-cors--security-headers)
9. [Recognized Limitations](#9-recognized-limitations)
10. [Security Documentation References](#10-security-documentation-references)

---

## 1. Authentication Systems

### 1.1 User Authentication (JWT-based)

**Location:** `netlify/functions/lib/auth-manager.js`

| Feature                  | Implementation | Details                                       |
| ------------------------ | -------------- | --------------------------------------------- |
| Password Hashing         | bcryptjs       | Cost factor 12 (secure against brute force)   |
| Token Type               | JWT            | Signed with `JWT_SECRET` environment variable |
| Token Expiration         | 7 days         | Configurable via `JWT_EXPIRES_IN`             |
| Email Verification       | Required       | 48-hour token expiration                      |
| Email Domain Restriction | Configurable   | Default: `@syntegon.com` only                 |

**Password Requirements:**

- Minimum 8 characters
- At least one uppercase letter
- At least one lowercase letter
- At least one number

**Email Validation:**

- Uses RE2 regex library (prevents ReDoS attacks)
- Domain-specific validation
- Multiple @ symbol detection
- Email normalization (lowercase, removes + aliases)

### 1.2 API Key Authentication

**Scraping Service:** `scraping-service/index.js:96-119`

- `X-API-Key` header required for `/scrape` and `/scrape-keyence` endpoints
- Validates against `SCRAPING_API_KEY` environment variable
- Health/status endpoints remain public for monitoring

**Internal API Key:** `netlify/functions/lib/auth-middleware.js:135-142`

- `x-internal-key` header for server-to-server calls
- Used by background functions and scheduled tasks
- Separate from scraping API key

### 1.3 Account Lockout Protection

**Location:** `netlify/functions/lib/auth-manager.js:220-227`

| Setting             | Value             |
| ------------------- | ----------------- |
| Max Failed Attempts | 5                 |
| Lock Duration       | 15 minutes        |
| Tracking            | Per email address |
| Clear Condition     | Successful login  |

**Limitation:** Lock state is stored per email, not per IP+email combination. An attacker could lock out legitimate users by repeatedly failing login attempts.

---

## 2. Authorization & Access Control

### 2.1 Authentication Middleware Types

**Location:** `netlify/functions/lib/auth-middleware.js`

| Middleware            | Use Case                     | Auth Methods            |
| --------------------- | ---------------------------- | ----------------------- |
| `requireAuth`         | Frontend-only endpoints      | JWT only                |
| `requireHybridAuth`   | Frontend + Backend endpoints | JWT OR Internal API Key |
| `requireInternalAuth` | Backend-only endpoints       | Internal API Key only   |

### 2.2 Protected Endpoints

**JWT Only (Frontend):**

- `get-csv.js` - Read database
- `save-csv.js` - Write database
- `view-logs.js` - View job logs
- `job-status.js` - Check job status

**Hybrid (Frontend OR Backend):**

- `initialize-job.js` - Start EOL check jobs
- `fetch-url.js` - URL scraping orchestration
- `analyze-job.js` - LLM analysis processing
- `set-auto-check-state.js` - Modify auto-check settings
- `get-auto-check-state.js` - Read auto-check settings
- `get-groq-usage.js` - Read Groq API usage
- `get-serpapi-usage.js` - Read SerpAPI usage

**Internal Only (Backend):**

- `auto-eol-check-background.js` - Scheduled background checks

**Special Cases:**

- `scraping-callback.js` - Uses separate `SCRAPING_API_KEY` validation
- `scheduled-eol-check.js` - Invoked by Netlify scheduler (no HTTP auth needed)

**Limitation:** No role-based access control (RBAC). All authenticated users have the same permissions.

---

## 3. Input Validation & Sanitization

### 3.1 General Input Validation

**Location:** `netlify/functions/lib/validators.js`

| Function                  | Purpose              | Validation                          |
| ------------------------- | -------------------- | ----------------------------------- |
| `validateInitializeJob()` | Job initialization   | Model/maker strings, max 200 chars  |
| `validateCsvData()`       | CSV data validation  | Array structure, column consistency |
| `sanitizeString()`        | Injection prevention | Trim, truncate, remove null bytes   |

### 3.2 Authentication Input Validation

**Location:** `netlify/functions/lib/auth-helpers.js`

- JSON parsing validation
- Required field presence (email, password)
- CORS preflight handling
- HTTP method validation (POST only)

### 3.3 URL Validation

**Location:** `scraping-service/utils/validation.js`

See [Section 5: SSRF Protection](#5-ssrf-protection) for details.

**Limitation:** The `sanitizeString()` function is basic - it only removes null bytes and truncates. It does not handle HTML entities, SQL injection patterns, or other attack vectors. However, the application uses Netlify Blobs (not SQL), which mitigates SQL injection risk.

---

## 4. Rate Limiting

**Location:** `netlify/functions/lib/rate-limiter.js`

### 4.1 Rate Limit Configuration

| Endpoint       | Max Attempts | Time Window |
| -------------- | ------------ | ----------- |
| Login          | 5            | 15 minutes  |
| Register       | 3            | 1 hour      |
| Password Reset | 1            | 15 minutes  |

### 4.2 Implementation Details

- **Storage:** Netlify Blobs (`auth-data` store)
- **Tracking:** Per IP address (via `x-forwarded-for` header)
- **Cleanup:** `cleanupExpiredRecords()` function available for maintenance

**Limitations:**

1. IP-based rate limiting can be bypassed with proxies/VPNs
2. Shared IP addresses (corporate NAT, mobile carriers) may cause legitimate users to be rate limited
3. No distributed rate limiting - each function invocation reads from blob storage independently (potential race conditions under high load)

---

## 5. SSRF Protection

**Location:** `scraping-service/utils/validation.js`

### 5.1 Scraping URL Validation (`isSafePublicUrl`)

Uses **blacklist approach** - blocks dangerous targets while allowing any public website:

| Blocked Category          | IP Ranges/Addresses                        |
| ------------------------- | ------------------------------------------ |
| Localhost                 | `127.0.0.1`, `::1`, `localhost`, `0.0.0.0` |
| Private IPs (RFC 1918)    | `10.x.x.x`, `172.16-31.x.x`, `192.168.x.x` |
| Link-local (AWS metadata) | `169.254.x.x`                              |
| CGNAT                     | `100.64-127.x.x`                           |
| Multicast                 | `224.x.x.x`                                |
| Reserved                  | `0.x.x.x`, `240.x.x.x`                     |
| IPv6 Private              | `fc00::/7`, `fe80::/10`                    |
| Dangerous Protocols       | `file://`, `ftp://`, `data://`, etc.       |

### 5.2 Callback URL Validation (`isValidCallbackUrl`)

Uses **whitelist approach** - only allows configured backend domains:

- Validates against `ALLOWED_ORIGINS` environment variable
- Strict hostname + port matching for localhost
- Subdomain matching for production domains

**Documented in:** `scraping-service/SECURITY.md`

---

## 6. Session Management

### 6.1 Cookie Security

**Location:** `netlify/functions/lib/auth-middleware.js:88-105`

| Attribute  | Value           | Purpose                                     |
| ---------- | --------------- | ------------------------------------------- |
| `HttpOnly` | Yes             | Prevents JavaScript access (XSS protection) |
| `SameSite` | Strict          | CSRF protection                             |
| `Secure`   | Production only | HTTPS enforcement                           |
| `Max-Age`  | 7 days          | Session expiration                          |
| `Path`     | `/`             | Available to entire site                    |

### 6.2 Token Handling

- Tokens extracted from Authorization header (Bearer) or cookies
- JWT verification on every protected request
- User data attached to request object for downstream handlers

**Limitations (documented in AUTHENTICATION.md):**

1. No session revocation list - tokens remain valid until expiration
2. Cannot force logout users server-side
3. If JWT_SECRET is compromised, all tokens must be invalidated by rotating the secret

---

## 7. Secrets Management

### 7.1 Required Environment Variables

**Netlify Functions:**
| Variable | Purpose | Generation |
|----------|---------|------------|
| `JWT_SECRET` | JWT signing | `crypto.randomBytes(64).toString('hex')` |
| `INTERNAL_API_KEY` | Server-to-server auth | `crypto.randomBytes(32).toString('hex')` |
| `SCRAPING_API_KEY` | Scraping service auth | Manual configuration |
| `ALLOWED_EMAIL_DOMAIN` | Email domain restriction | Configuration |
| `EMAIL_USER` | Gmail SMTP sender | Gmail account |
| `EMAIL_PASSWORD` | Gmail SMTP auth | Gmail App Password |

**Scraping Service:**
| Variable | Purpose |
|----------|---------|
| `SCRAPING_API_KEY` | API authentication |
| `ALLOWED_ORIGINS` | CORS whitelist |

### 7.2 Environment Validation

**Locations:**

- `netlify/functions/lib/env-validator.js` - Validates required Netlify vars
- `scraping-service/utils/env-validator.js` - Validates required scraping vars

Both validators fail fast on startup if required variables are missing.

### 7.3 Git Ignore Protection

**Location:** `.gitignore`

- All `.env` files excluded from git
- Prevents accidental secret commits

**Limitation:** No automatic secret rotation mechanism. Secrets must be manually rotated.

---

## 8. CORS & Security Headers

### 8.1 CORS Configuration

**Netlify Functions:** `netlify/functions/lib/response-builder.js`

- Uses `ALLOWED_ORIGINS` environment variable
- Falls back to `*` in development

**Scraping Service:** `scraping-service/index.js:43-62`

- Configured via `ALLOWED_ORIGINS`
- Origin validation at middleware level
- Credentials support enabled

### 8.2 Security Headers

| Header         | Implementation | Location         |
| -------------- | -------------- | ---------------- |
| `X-Powered-By` | Disabled       | Scraping service |
| CORS headers   | Dynamic origin | Response builder |

**Limitation:** No CSP (Content Security Policy), HSTS, or other advanced security headers implemented. The application relies on Netlify's default headers.

---

## 9. Recognized Limitations

### 9.1 Documented in AUTHENTICATION.md (Lines 311-317)

> ### ⚠️ Limitations
>
> - Small user base (<10) - Netlify Blobs suitable
> - No OAuth integration (Google/Microsoft)
> - No session revocation list (tokens valid until expiry)
> - Email verification relies on configured email service

### 9.2 Documented in SECURITY.md (Scraping Service)

> ### Risk Context (Lines 17-22)
>
> - **Internal use only** - not exposed to untrusted users
> - **No sensitive data** - only scrapes public manufacturer websites
> - **Free services** - no financial risk from abuse
> - **Comprehensive validation** - multiple layers of protection

### 9.3 Additional Identified Limitations

| Limitation                        | Impact                          | Mitigation                      |
| --------------------------------- | ------------------------------- | ------------------------------- |
| No RBAC                           | All users have same permissions | Acceptable for small team (<10) |
| IP-based rate limiting            | Bypassable with proxies         | Combined with account lockout   |
| No 2FA/MFA                        | Single factor authentication    | Domain-restricted emails        |
| No audit logging                  | Cannot track user actions       | Function logs available         |
| No CSRF tokens                    | Relies on SameSite cookies      | Modern browsers protected       |
| Basic input sanitization          | Limited attack prevention       | No SQL database used            |
| Password reset = account deletion | Non-standard flow               | Documented design choice        |

---

## 10. Security Documentation References

### 10.1 Existing Documentation Files

| File                           | Content                                                |
| ------------------------------ | ------------------------------------------------------ |
| `AUTHENTICATION.md`            | Complete auth system documentation, setup, limitations |
| `scraping-service/SECURITY.md` | SSRF protection rationale, CodeQL suppression strategy |

### 10.2 Inline Code Documentation

**Security-related comments found in:**

- `auth-manager.js` - Password strength, token generation
- `auth-middleware.js` - Cookie security attributes
- `validation.js` - SSRF protection explanations
- `rate-limiter.js` - Rate limit configurations

### 10.3 CodeQL Configuration

**Location:** `.github/codeql/codeql-config.yml`

- Documents intentional SSRF functionality
- Excludes `js/request-forgery` and `js/tainted-format-string`
- Provides audit trail for security reviews

---

## Summary

The EOL Checker implements a **defense-in-depth security model** appropriate for an internal corporate tool with a small user base. Key security measures include:

**Strong Points:**

- Industry-standard password hashing (bcrypt, cost factor 12)
- Secure session management (HttpOnly, SameSite, Secure cookies)
- Comprehensive SSRF protection (blacklist + whitelist validation)
- Multi-layer authentication (JWT, API keys, hybrid modes)
- Rate limiting on authentication endpoints
- ReDoS protection via RE2 regex library
- Email domain restriction prevents external access
- Fail-fast environment validation

**Areas for Improvement (if scaling beyond 10 users):**

- Implement OAuth/SSO integration
- Add role-based access control
- Implement session revocation mechanism
- Add audit logging
- Consider distributed rate limiting
- Implement CSP and additional security headers
- Add 2FA/MFA support

The current implementation is well-suited for its documented use case as an internal tool for a small team, with security trade-offs explicitly documented and acknowledged.
