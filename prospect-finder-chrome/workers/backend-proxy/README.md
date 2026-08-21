# ProspectFinder Backend Proxy (Tier 3)

A self-hosted enrichment backend with rotating residential proxies and session pooling.

## When to use this instead of the CF Worker

| | CF Worker (Tier 2) | Backend (Tier 3) |
|---|---|---|
| Speed | 30-45 profiles/min | 60-100+ profiles/min |
| IP rotation | ~30 CF edge IPs | Thousands of residential IPs |
| Session pool | 1-3 manual sessions | Auto-managed pool |
| Cost | Free | $5-20/mo (proxy) + $0-5/mo (hosting) |
| Setup | 5 min | 15 min |
| Maintenance | Zero | Zero once running |

Use this if you need >50 profiles/min or run multiple concurrent scans.

## Quick start

```bash
cd workers/backend-proxy
npm install

# Configure
cp .env.example .env
# Edit .env with your settings

# Run
npm start          # production
npm run dev        # development with auto-reload
```

## Deploy to Railway

```bash
# Install Railway CLI: npm i -g @railway/cli
railway login
railway init
railway up
```

## Deploy to Fly.io

```bash
fly auth login
fly launch
fly deploy
```

## Deploy to any VPS

```bash
# Just push and run
scp -r . user@your-vps:~/pf-proxy
ssh user@your-vps "cd ~/pf-proxy && npm install && npm start"
```

## Environment variables

See `.env.example` for all options. Key ones:

- `IG_SESSIONS` — Comma-separated Instagram session IDs (minimum 1)
- `PROXY_URL` — Rotating residential proxy URL (optional but recommended)
- `CACHE_TTL` — Profile cache TTL in seconds (default: 86400 = 24h)
- `RATE_LIMIT` — Requests per minute per session (default: 20)
- `PORT` — Server port (default: 3000)
