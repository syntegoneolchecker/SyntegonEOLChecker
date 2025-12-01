# Deploying Scraping Service to Render.com

## Step 1: Push Scraping Service to GitHub

The scraping service needs to be in a Git repository (can be the same repo or separate).

### Option A: Same Repository (Recommended)
The `scraping-service/` folder is already in your repository. Just commit and push:

```bash
git add scraping-service/
git commit -m "Add Puppeteer scraping service for Render.com"
git push
```

### Option B: Separate Repository
If you prefer a separate repo:

```bash
cd scraping-service/
git init
git add .
git commit -m "Initial commit: Puppeteer scraping service"
# Create a new repo on GitHub, then:
git remote add origin https://github.com/yourusername/eol-scraping-service.git
git push -u origin main
```

---

## Step 2: Create Render.com Account

1. Go to https://render.com/
2. Click **"Get Started"** or **"Sign Up"**
3. Sign up with GitHub (easiest for deployment)
4. **No credit card required** for free tier

---

## Step 3: Create New Web Service

1. In Render dashboard, click **"New +"** → **"Web Service"**
2. Connect your GitHub account if prompted
3. Select your repository:
   - If same repo: Select `SyntegonEOLChecker`
   - If separate: Select `eol-scraping-service`
4. Click **"Connect"**

---

## Step 4: Configure Web Service

Fill in the following settings:

**Name:** `eol-scraping-service` (or any name you prefer)

**Region:** Choose closest to you (e.g., Frankfurt, Oregon)

**Branch:** `main` (or your branch name)

**Root Directory:**
- If same repo: `scraping-service`
- If separate repo: leave blank

**Runtime:** `Docker`

**Instance Type:** `Free` ✅

**Advanced Settings:**
- **Auto-Deploy:** Yes (deploys on git push)
- **Health Check Path:** `/health`

Leave everything else as default.

---

## Step 5: Deploy

1. Click **"Create Web Service"**
2. Render will start building your Docker container
3. This takes **5-10 minutes** on first deploy
4. Watch the logs for any errors

You'll see logs like:
```
==> Building...
==> Deploying...
==> Starting service...
Scraping service running on port 3000
```

---

## Step 6: Get Your Service URL

Once deployed, Render gives you a URL like:
```
https://eol-scraping-service.onrender.com
```

**Copy this URL** - you'll need it for the Netlify integration.

---

## Step 7: Test Your Service

Test the health endpoint:
```bash
curl https://eol-scraping-service.onrender.com/health
```

Should return:
```json
{"status":"ok","timestamp":"2025-12-01T..."}
```

Test scraping:
```bash
curl -X POST https://eol-scraping-service.onrender.com/scrape \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}'
```

---

## Step 8: Add Environment Variable to Netlify

1. Go to Netlify dashboard
2. Select your EOL Database site
3. Go to **Site settings** → **Environment variables**
4. Add new variable:
   - **Key:** `SCRAPING_SERVICE_URL`
   - **Value:** `https://eol-scraping-service.onrender.com`
5. Click **Save**

---

## Important Notes

### Free Tier Limitations
- **Spin down after 15 minutes** of inactivity
- First request after spin-down takes **30-60 seconds** (cold start)
- **750 free hours/month** (enough for moderate use)

### Cold Start Warning
When the service spins down, the first scrape will be slow. Subsequent scrapes are fast.

### Keeping Service Warm (Optional)
To avoid cold starts, you can ping the health endpoint every 10 minutes using:
- Cron-job.org (free, no signup)
- UptimeRobot (free tier available)
- Your own scheduled task

Just ping: `https://your-service.onrender.com/health`

### Monitoring
- View logs in Render dashboard: **Dashboard → Your Service → Logs**
- Check metrics: **Dashboard → Your Service → Metrics**

---

## Troubleshooting

### Build Fails
Check the build logs in Render dashboard. Common issues:
- Missing `package.json`
- Wrong root directory setting
- Dockerfile errors

### Service Won't Start
Check runtime logs. Common issues:
- Port binding (must use `process.env.PORT`)
- Missing dependencies

### Scraping Fails
Check logs for specific errors:
- Timeout → Increase timeout in code
- Memory error → Optimize Puppeteer settings
- 403/bot detection → Adjust user agent or headers

---

## Next Steps

After deployment, integrate the scraping service with your Netlify function. See `INTEGRATION.md` for details.
