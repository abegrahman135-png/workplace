# Cloudflare Worker Deployment — Complete Guide

## What you're deploying

A Cloudflare Worker that sits between your Chrome extension and Instagram:

```
Extension → Cloudflare Worker → Instagram
                ↓
           R2 Cache (24h)
```

**Benefits:**
- Cached profiles = zero IG requests (instant)
- Request coalescing (5 jobs for same username = 1 IG fetch)
- ~30 Cloudflare edge IPs
- Free tier covers 210+ full scans per day

---

## Prerequisites

- A Cloudflare account (free: https://dash.cloudflare.com/sign-up)
- Node.js installed on your computer (https://nodejs.org)
- Your Instagram `sessionid` cookie

---

## Step 1: Get your Instagram sessionid

1. Open **instagram.com** in Chrome (make sure you're **logged in**)
2. Press **F12** to open DevTools
3. Go to **Application** tab → **Cookies** → `https://www.instagram.com`
4. Find the row named **`sessionid`**
5. Copy its **Value** (it looks like `123456789%3AAbcdefghijklmnop%3A28`)

> ⚠️ This is your login session. Don't share it publicly. It stays in Cloudflare's encrypted secrets.

---

## Step 2: Install Wrangler (Cloudflare CLI)

Open Terminal / Command Prompt / PowerShell:

```bash
npm install -g wrangler
```

Verify:
```bash
wrangler --version
```

---

## Step 3: Login to Cloudflare

```bash
wrangler login
```

This opens your browser. Click **Authorize**.

---

## Step 4: Download the worker code

```bash
git clone -b arena/01a02494-workplace https://github.com/abegrahman135-png/workplace.git
cd workplace/prospect-finder-chrome/workers/profile-proxy
```

---

## Step 5: Create R2 bucket

```bash
wrangler r2 bucket create pf-profile-cache
```

You should see: `✅ Created R2 bucket 'pf-profile-cache'`

---

## Step 6: Update wrangler.toml

The `wrangler.toml` file should already have the R2 binding. Verify it looks like this:

```toml
name = "pf-profile-proxy"
main = "src/index.js"
compatibility_date = "2024-01-01"

[[r2_buckets]]
binding = "PROFILE_CACHE"
bucket_name = "pf-profile-cache"
```

No changes needed — it's already configured.

---

## Step 7: Add your Instagram session as a secret

```bash
echo "YOUR_SESSIONID_HERE" | wrangler secret put IG_SESSION_1
```

Replace `YOUR_SESSIONID_HERE` with the value you copied in Step 1.

**Example:**
```bash
echo "123456789%3AAbcdefghijklmnop%3A28" | wrangler secret put IG_SESSION_1
```

> Optional: Add more sessions (different IG accounts) for higher throughput:
> ```bash
> echo "SESSION_2_VALUE" | wrangler secret put IG_SESSION_2
> echo "SESSION_3_VALUE" | wrangler secret put IG_SESSION_3
> ```

---

## Step 8: Deploy

```bash
wrangler deploy
```

You should see something like:
```
✨ Successfully published your script to
   https://pf-profile-proxy.YOUR_SUBDOMAIN.workers.dev
```

**Copy that URL** — you'll need it next.

---

## Step 9: Test the worker

```bash
# Health check
curl https://pf-profile-proxy.YOUR_SUBDOMAIN.workers.dev/health
```

Expected response:
```json
{"ok":true,"ts":1234567890,"sessions":1,"cache":"r2"}
```

```bash
# Test a profile fetch
curl "https://pf-profile-proxy.YOUR_SUBDOMAIN.workers.dev/profile?username=instagram"
```

Expected response (large JSON with user data):
```json
{"ok":true,"user":{...},"cached":false,"fetchedAt":1234567890}
```

If you get `{"ok":false,"status":0,"error":"network_error"}`, your sessionid may be expired. Get a fresh one from Instagram.

---

## Step 10: Connect the Chrome extension

1. Open Chrome → load the extension (if not already loaded)
2. Click the extension icon → **Open Dashboard**
3. Go to **Settings** tab
4. Scroll down to **Enrichment proxy**
5. Paste your worker URL (e.g., `https://pf-profile-proxy.YOUR_SUBDOMAIN.workers.dev`)
6. Click **Test connection** — should show ✅
7. Click **Save settings**

---

## Step 11: Run a scan

1. Go to any Instagram profile
2. Click the extension icon
3. Click **▶ Scan followers**
4. Watch the dashboard — enrichment now goes through the proxy

---

## What happens now

| Request | Path | IG cost |
|---------|------|---------|
| First scan, new profile | Extension → Worker → IG → R2 | 1 IG request |
| First scan, same profile again (coalesced) | Extension → Worker → R2 (in-flight shared) | 0 IG requests |
| Second scan, same profile | Extension → Worker → R2 (cached) | 0 IG requests |
| Proxy down | Extension → direct IG fallback | 1 IG request |

---

## Monitoring

### Worker logs (live)
```bash
wrangler tail
```

### R2 bucket contents
```bash
wrangler r2 object list pf-profile-cache
```

### Usage dashboard
Go to https://dash.cloudflare.com → Workers & Pages → pf-profile-proxy → Analytics

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `network_error` on profile fetch | Your sessionid is expired. Get a fresh one from instagram.com cookies |
| `401` or `403` from IG | Session expired or IG flagged it. Use a different account |
| Test connection fails in extension | Check the URL has no trailing slash. Try the health endpoint in browser |
| `wrangler deploy` fails | Run `wrangler login` again |
| Worker URL changed after deploy | Update the URL in extension Settings |

---

## Renewing your session

Instagram sessions expire after ~90 days of inactivity, or sooner if you log out. When it expires:

1. Log in to instagram.com again
2. Get the new `sessionid` from cookies
3. Run: `echo "NEW_SESSIONID" | wrangler secret put IG_SESSION_1`
4. Run: `wrangler deploy` (redeploys with new secret)

---

## Cost summary

| Resource | Free Tier | Your Usage | Cost |
|----------|-----------|------------|------|
| Workers requests | 100,000/day | ~474/scan | $0 |
| R2 storage | 10 GB | ~2 MB | $0 |
| R2 reads | 10M/month | ~14K/month | $0 |
| R2 writes | 1M/month | ~14K/month | $0 |
| R2 egress | $0 always | $0 | **$0** |
| **Total** | | | **$0/month** |
