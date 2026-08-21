# Enrichment Architecture Upgrade

## Tier 1: Predictive Rate Limiting (current code, smarter)
**Effort:** Low | **Speed gain:** ~30% | **Reliability:** Moderate

Instead of reacting to 429s, predict them by tracking request patterns.

## Tier 2: Cloudflare Worker Proxy
**Effort:** Medium | **Speed gain:** 3-5x | **Reliability:** High

Route enrichment through a Cloudflare Worker that:
- Caches profile responses (profiles don't change minute-to-minute)
- Implements server-side coalescing (deduplicates in-flight requests)
- Varies request timing to stay under IG's radar
- Provides a stable endpoint even when the MV3 worker restarts

## Tier 3: Full Backend with Session Pool
**Effort:** High | **Speed gain:** 10-20x | **Reliability:** Very High

A dedicated backend (Fly.io / Railway / Vercel Edge) that:
- Maintains a pool of 3-5 Instagram session cookies
- Rotates through them per-request
- Uses residential proxy rotation (BrightData, Oxylabs)
- Distributes requests across multiple IPs
- Proper distributed rate limiting across all sessions
- Response caching with configurable TTL (default 24h)
- Priority queue (high_score prospects enriched first)
- Achievable: 60-100 profiles/min safely, vs current 15/min

## Recommended Path

For your use case (474 profiles, personal use), **Tier 2 is the sweet spot**:
- 3-5x speed improvement from caching alone
- No proxy service costs
- Deploys in 5 minutes on Cloudflare (free tier covers it)
- Zero maintenance

If you need to scale beyond ~2000 profiles or run multiple scans concurrently, upgrade to Tier 3.
