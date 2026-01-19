# Authentication System Documentation

## Overview

The EOL Checker now includes a secure email-domain-based authentication system that restricts access to employees with company email addresses.

## Security Features

✅ **Email Domain Validation** - Only @syntegon.com (configurable) emails can register
✅ **Email Verification** - Confirmation link required to activate accounts
✅ **Password Hashing** - bcrypt with cost factor 12
✅ **JWT Sessions** - Secure, httpOnly cookies with 7-day expiration
✅ **Account Lockout** - 5 failed login attempts = 15 minute lock
✅ **Protected Endpoints** - All user-facing APIs require authentication
✅ **HTTPS Only** - Secure cookies in production

## Architecture

### Frontend
- **`/auth.html`** - Login & Registration page
- **`/verify.html`** - Email verification page
- **`/index.html`** - Main app (protected, requires login)
- **`/script.js`** - Auth check on page load, logout function

### Backend Functions
#### Auth Endpoints (Public)
- **`auth-register.js`** - Create new account
- **`auth-verify.js`** - Verify email token
- **`auth-login.js`** - Login and get JWT
- **`auth-check.js`** - Check if authenticated
- **`auth-logout.js`** - Logout

#### Protected Endpoints
- `get-csv.js` - ✅ Protected
- `save-csv.js` - ✅ Protected
- `view-logs.js` - ✅ Protected
- `job-status.js` - ✅ Protected
- Additional endpoints pending

### Libraries
- **`lib/user-storage.js`** - User CRUD operations in Netlify Blobs
- **`lib/auth-manager.js`** - Password hashing, JWT, registration logic
- **`lib/auth-middleware.js`** - `requireAuth()` wrapper for endpoints

## Environment Variables Required

Add these to your Netlify site configuration:

```bash
# REQUIRED - Authentication
JWT_SECRET=your-random-secret-key-min-32-characters
ALLOWED_EMAIL_DOMAIN=syntegon.com

# OPTIONAL - Email Verification (Gmail SMTP)
EMAIL_USER=your-gmail-account@gmail.com
EMAIL_PASSWORD=your-app-specific-password
FROM_EMAIL=your-gmail-account@gmail.com  # Optional, defaults to EMAIL_USER
```

### Generating JWT_SECRET

```bash
# Generate a secure random secret
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

## Email Verification Setup

### Gmail SMTP (Current Implementation)

**Why Gmail SMTP?**
- ✅ FREE indefinitely (no time limits)
- ✅ No credit card required
- ✅ No personal domain required
- ✅ Reliable and simple
- ✅ 500 emails/day (more than enough)

**Setup (5 minutes):**

1. **Enable 2-Step Verification** on your Gmail account:
   - Go to [Google Account Security](https://myaccount.google.com/security)
   - Enable "2-Step Verification"

2. **Create App Password**:
   - Go to [App Passwords](https://myaccount.google.com/apppasswords)
   - Select app: "Mail"
   - Select device: "Other (Custom name)" → Enter "EOL Checker"
   - Click "Generate"
   - Copy the 16-character password (format: `xxxx xxxx xxxx xxxx`)

3. **Set environment variables in Netlify**:
   ```bash
   EMAIL_USER=your-gmail-account@gmail.com  # ⚠️ Mark as SECRET
   EMAIL_PASSWORD=xxxx xxxx xxxx xxxx       # ⚠️ Mark as SECRET (app password)
   FROM_EMAIL=your-gmail-account@gmail.com  # Optional
   ```

**Important Notes:**
- Never use your regular Gmail password - only use App Passwords
- App Passwords can be revoked anytime from Google Account settings
- Gmail SMTP uses TLS encryption (port 587)

**Free Tier Limits:**
- 500 emails/day - Perfect for small teams
- No time limit - Free forever

### Manual Mode (Development Only)

If no email service is configured:
- Registration returns verification URL in response (dev mode only)
- Copy the URL and manually send it to users
- Production mode won't expose the verification URL

## User Flow

### Registration
1. User goes to `/auth.html`
2. Clicks "Register" tab
3. Enters company email + password
4. System validates:
   - Email format
   - Email domain (@syntegon.com)
   - Password strength (8+ chars, upper/lower/number)
5. Account created (unverified)
6. Verification email sent (or URL shown in dev)

### Email Verification
1. User clicks link in email (`/verify?token=...`)
2. System validates token
3. Account activated
4. User redirected to login

### Login
1. User enters email + password
2. System validates credentials
3. JWT token generated and stored in cookie
4. User redirected to main app

### Accessing Protected Pages
1. Main app checks authentication on load
2. If not authenticated → redirect to `/auth.html`
3. If authenticated → allow access

## Protecting Additional Endpoints

To protect a Netlify Function with authentication:

### 1. Import the middleware

```javascript
const { requireAuth } = require('./lib/auth-middleware');
```

### 2. Rename your handler

```javascript
// Before:
exports.handler = async (event, context) => {
  // your code
};

// After:
const myFunctionHandler = async (event, context) => {
  // your code
  // Access authenticated user via: event.user
};
```

### 3. Wrap with requireAuth

```javascript
// At the end of the file
exports.handler = requireAuth(myFunctionHandler);
```

### Complete Example

```javascript
// my-function.js
const { requireAuth } = require('./lib/auth-middleware');

const myFunctionHandler = async (event, context) => {
    // Authenticated user is available in event.user
    const userEmail = event.user.email;

    // Your function logic here
    return {
        statusCode: 200,
        body: JSON.stringify({ message: 'Success', user: userEmail })
    };
};

// Protect with authentication
exports.handler = requireAuth(myFunctionHandler);
```

## Endpoints That Should NOT Be Protected

These endpoints are called by external services and use different security mechanisms:

- **`scraping-callback.js`** - Called by Render scraping service
- **`analyze-job.js`** - Internal job processing
- **`fetch-url.js`** - Internal job processing
- **`auto-eol-check-background.js`** - Background job
- **`scheduled-eol-check.js`** - Netlify cron trigger

## Storage

User data is stored in Netlify Blobs in the `auth-data` store:

- **`users`** - Array of user objects
- **`verification-tokens`** - Token → user data mapping
- **`login-attempts`** - Email → failed attempt tracking

### User Object Structure

```json
{
  "id": "unique-user-id",
  "email": "user@syntegon.com",
  "hashedPassword": "bcrypt-hash",
  "verified": true,
  "createdAt": "2025-12-25T12:00:00.000Z",
  "failedLoginAttempts": 0,
  "lockedUntil": null
}
```

## Security Considerations

### ✅ What's Secure

- Passwords never stored in plaintext (bcrypt)
- JWTs signed and verified
- Secure, httpOnly cookies (prevents XSS)
- Email domain validation
- Account lockout (brute force protection)
- Email verification (prevents fake registrations)
- HTTPS in production

### ⚠️ Limitations

- Small user base (<10) - Netlify Blobs suitable
- No OAuth integration (Google/Microsoft)
- No password reset flow (can be added)
- No session revocation list (tokens valid until expiry)
- Email verification relies on configured email service

### 🔐 Best Practices

1. **Never commit secrets** - Use Netlify environment variables
2. **Regular JWT_SECRET rotation** - Change periodically
3. **Monitor failed logins** - Check for brute force attempts
4. **Keep dependencies updated** - `npm audit` regularly
5. **Use strong passwords** - Enforce in registration

## Testing

### Local Development

```bash
# Start Netlify Dev
netlify dev

# Navigate to:
# http://localhost:8888/auth.html - Login/Register
# http://localhost:8888 - Main app (will redirect if not logged in)
```

### Test User Registration

1. Go to `/auth.html`
2. Register with your company email
3. Check console for verification URL (if no email service)
4. Visit verification URL
5. Login with credentials
6. Should see main app

### Test Authentication Protection

```bash
# Without auth (should fail)
curl http://localhost:8888/.netlify/functions/get-csv

# With auth (should succeed)
curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
     http://localhost:8888/.netlify/functions/get-csv
```

## Troubleshooting

### "Invalid email domain" error
- Check `ALLOWED_EMAIL_DOMAIN` environment variable
- Ensure using correct company email

### "Email verification failed"
- Token may be expired (48 hour limit)
- Re-register to get new verification link

### "Account locked" message
- Wait 15 minutes after 5 failed login attempts
- Or contact admin to reset lock

### Verification email not received
- Check spam folder
- Verify `EMAIL_SERVICE` and `EMAIL_API_KEY` are set
- Check Netlify function logs for errors
- In development, get URL from function response

### Can't access main app
- Check browser console for auth errors
- Clear cookies and try logging in again
- Verify JWT_SECRET is set in Netlify

## Maintenance

### Add New Admin User (Emergency)

If you need to manually add a user without email verification:

```javascript
// Create temporary function: create-admin.js
const { createUser } = require('./lib/user-storage');
const { hashPassword } = require('./lib/auth-manager');

exports.handler = async () => {
    const hashedPassword = await hashPassword('YourSecurePassword123');

    const user = await createUser({
        email: 'admin@syntegon.com',
        hashedPassword
    });

    // Manually set verified
    await updateUser(user.email, { verified: true });

    return { statusCode: 200, body: 'Admin created' };
};
```

### Reset User Password

Currently not implemented. To add:
1. Create `auth-forgot-password.js` endpoint
2. Generate reset token
3. Send email with reset link
4. Create `auth-reset-password.js` endpoint
5. Validate token and update password

### View All Users

```javascript
// Temporary function
const { getUsers } = require('./lib/user-storage');

exports.handler = async () => {
    const users = await getUsers();
    const safeUsers = users.map(u => ({
        email: u.email,
        verified: u.verified,
        createdAt: u.createdAt
    }));

    return {
        statusCode: 200,
        body: JSON.stringify(safeUsers, null, 2)
    };
};
```

## Migration Guide

If you need to migrate to a proper database later (Supabase, etc.):

1. Export users from Netlify Blobs
2. Set up new database
3. Import users
4. Update `lib/user-storage.js` to use new database
5. Update environment variables
6. Test thoroughly before deploying

## Support

For issues or questions:
1. Check Netlify function logs
2. Review browser console errors
3. Verify all environment variables are set
4. Check this documentation
5. Review the code in `/netlify/functions/lib/auth-*.js`

## License

Same as main project.
