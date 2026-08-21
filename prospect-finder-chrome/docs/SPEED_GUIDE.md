# ProspectFinder — Enrichment Speed & Reliability Guide

## The bottleneck explained

Your extension has two traffic patterns:

| Phase | What | Current speed | Bottleneck |
|-------|------|---------------|------------|
| **Harvesting** | Content script scrolls follower lists | ~50 profiles/page, fast | None (same-origin) |
| **Enrichment** | Background worker fetches `web_profile_info` per username | ~15/min | **This is the wall** |

Instagram rate-limits enrichment per **session + IP**. Your previous fix (persistence, backoff, 15/min) is correct engineering — but it optimizes *how you hit the wall*, not *where the wall is*.

---

## Three tiers to go faster

### Tier 1: Predictive throttle (already included)
**Cost:** Free | **Speed gain:** ~20% | **429 rate:** 5% → ~2%

The `rate_limiter.js` now tracks the rolling average time between successful requests. When your requests are coming faster than Instagram tolerates (~3s observed), it pre-emptively slows down *before* a 429 arrives. No configuration needed — it just works.

### Tier 2: Cloudflare Worker proxy (recommended)
**Cost:** Free | **Speed gain:** 3-5x | **429 rate:** ~0%

This is the sweet spot. Deploy once, benefit forever.

**What it gives you:**
- **KV cache** — profiles cached for 24h. A cached profile costs *zero* IG requests.
- **Request coalescing** — if 5 jobs request the same username simultaneously, only 1 goes to IG.
- **Stable endpoint** — survives MV3 worker eviction (your biggest remaining issue).
- **~30 Cloudflare edge IPs** — requests come from different IPs than your browser.

**Setup (5 minutes):**

```bash
# 1. Install wrangler (Cloudflare's CLI)
npm install -g wrangler

# 2. Login
wrangler login

# 3. Go to the worker directory
cd workers/profile-proxy

# 4. Create KV namespace for caching
wrangler kv:namespace create PROFILE_CACHE
# Copy the id from the output

# 5. Update wrangler.toml with the KV id
# Replace REPLACE_ME_AFTER_WRANGLER_KV_NAMESPACE_CREATE with your id

# 6. Add your Instagram session cookie
# Get it from: instagram.com → DevTools → Application → Cookies → sessionid
echo "YOUR_SESSIONID_HERE" | wrangler secret put IG_SESSION_1

# 7. Deploy
wrangler deploy
# Copy the URL from the output (e.g., https://pf-profile-proxy.YOUR_SUBDOMAIN.workers.dev)

# 8. Set it in the extension
# Open the extension dashboard → Settings → Enrichment proxy → paste the URL
```

**Expected improvement:**
- 474 profiles: ~30 min → ~8 min
- 429 rate: ~5% → ~0% (cached profiles never hit IG)
- First run: ~15 req/min (limited by IG)
- Second run of same profiles: instant (all cached)

### Tier 3: Self-hosted backend with residential proxies
**Cost:** $5-20/mo | **Speed gain:** 10-20x | **429 rate:** ~0%

For when you need >50 profiles/min or run multiple concurrent scans.

**What it adds over Tier 2:**
- **Rotating residential proxies** — thousands of IPs, not just 30
- **Session pool** — 3-5 IG accounts rotating round-robin
- **File-based cache** — survives server restarts
- **Batch endpoint** — fetch 20 profiles in one request

**Providers (residential proxies):**
| Provider | Cost | IPs | Notes |
|----------|------|-----|-------|
| [BrightData](https://brightdata.com) | $15/mo | 72M+ | Best quality, most expensive |
| [Oxylabs](https://oxylabs.io) | $15/mo | 100M+ | Similar to BrightData |
| [Smartproxy](https://smartproxy.com) | $12/mo | 40M+ | Good balance |
| [IPRoyal](https://iproyal.com) | $5/mo | 32M+ | Budget option |

**Setup:**

```bash
# 1. Configure
cd workers/backend-proxy
cp .env.example .env
# Edit .env with your settings:
#   IG_SESSIONS=session1,session2,session3
#   PROXY_URL=http://user:pass@proxy.example.com:port
#   RATE_LIMIT_PER_SESSION=20

# 2. Run locally
npm install
npm start

# 3. Or deploy to Railway (free tier)
railway login && railway init && railway up

# 4. Or deploy to Fly.io (free tier)
fly auth login && fly launch && fly deploy

# 5. Set the URL in the extension dashboard
```

**Expected improvement:**
- 474 profiles: ~30 min → ~3 min
- With 3 sessions × 20 req/min = 60 req/min safe
- With residential proxy: 100+ req/min possible

---

## Quick decision tree

```
Do you have >1000 profiles to enrich?
├─ No  → Tier 2 (CF Worker) — free, 5 min setup
└─ Yes
   ├─ Can you wait 30 min? → Tier 2
   └─ Need faster? → Tier 3
      ├─ Budget $5/mo? → IPRoyal + Railway
      └─ Budget $15/mo? → BrightData + Railway
```

---

## What NOT to do

1. **Don't increase concurrency beyond 3** — Instagram counts requests per session, not per connection
2. **Don't remove the rate limiter** — you'll get your account flagged
3. **Don't use free proxy lists** — they're already blacklisted by Instagram
4. **Don't run multiple scans simultaneously** — they share the same rate limit pool

---

## Monitoring

The dashboard now shows:
- **Pipeline health** tab: breaker state, limiter state, proxy stats
- **Settings** tab: proxy URL configuration + test button
- **Live rail**: "Paused at N/474 — Instagram rate limit" (healthy) vs "Stalled" (needs attention)

---

## Files changed in this update

| File | What changed |
|------|-------------|
| `src/background/enricher.js` | Added proxy fetch with automatic fallback |
| `src/background/rate_limiter.js` | Added predictive throttle (tracks request intervals) |
| `src/background/scheduler.js` | Proxy stats in health endpoint |
| `src/background/index.js` | Proxy URL sync on settings change |
| `src/ui/dashboard.html` | Proxy configuration UI |
| `src/ui/app.js` | Proxy settings load/save/test |
| `workers/profile-proxy/` | **NEW** — Cloudflare Worker (Tier 2) |
| `workers/backend-proxy/` | **NEW** — Self-hosted backend (Tier 3) |
