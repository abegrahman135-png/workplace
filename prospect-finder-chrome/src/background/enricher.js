/**
 * enricher.js — Fetch, classify, score. One job at a time, fully durable.
 * Every outcome writes a terminal state; nothing is ever left dangling.
 */

import { db, STORES } from '../db/schema.js';
import { IG_APP_ID, STAGE, SCORE_VERSION, MSG } from '../lib/constants.js';
import { classifyTier2 } from '../engines/classifier/index.js';
import { putAvatar, hasFreshAvatar } from '../db/repo.avatars.js';
import { scoreProspect } from '../engines/scoring.js';
import { classifyAccountType, qualifyTier2 } from '../engines/qualification.js';
import { buildSearchTokens } from '../search/text_index.js';
import { bumpStats } from './stats.js';
import { log } from '../lib/logger.js';
import { hashStr } from '../lib/utils.js';

/**
 * ── Proxy configuration ───────────────────────────────────────────────────
 *
 * When PROXY_URL is set (via chrome.storage.local key 'pf-proxy-url'),
 * enrichment requests go through a Cloudflare Worker that provides:
 *   - KV-cached profiles (24h TTL) — cached profiles cost zero IG requests
 *   - Request coalescing — N concurrent jobs for the same username = 1 IG fetch
 *   - Server-side rate limiting across all extension instances
 *   - A stable endpoint that survives MV3 worker eviction
 *
 * When the proxy is unreachable or returns a non-IG error, we fall back to
 * the original direct fetch path transparently.
 *
 * Set it in the extension's settings or via:
 *   chrome.storage.local.set({ 'pf-proxy-url': 'https://pf-profile-proxy.YOUR_SUBDOMAIN.workers.dev' })
 */

const PROXY_STORAGE_KEY = 'pf-proxy-url';
let cachedProxyUrl = null;
let proxyUrlLoaded = false;

async function getProxyUrl() {
  if (proxyUrlLoaded) return cachedProxyUrl;
  try {
    const o = await chrome.storage.local.get(PROXY_STORAGE_KEY);
    cachedProxyUrl = o?.[PROXY_STORAGE_KEY] || null;
  } catch (_) {
    cachedProxyUrl = null;
  }
  proxyUrlLoaded = true;
  return cachedProxyUrl;
}

/** Allow settings UI to update the proxy URL at runtime. */
export function setProxyUrl(url) {
  cachedProxyUrl = url || null;
  proxyUrlLoaded = true;
  try { chrome.storage.local.set({ [PROXY_STORAGE_KEY]: cachedProxyUrl }); } catch (_) {}
}

export function normalizeEnriched(user) {
  if (!user) return null;
  return {
    username: user.username,
    full_name: user.full_name ?? '',
    biography: user.biography ?? '',
    profile_pic_url: user.profile_pic_url_hd ?? user.profile_pic_url ?? '',
    external_url: user.external_url ?? '',
    category_name: user.category_name ?? null,
    post_count: user.post_count ?? user.media_count ?? user.edge_owner_to_timeline_media?.count ?? 0,
    follower_count: user.follower_count ?? user.edge_followed_by?.count ?? 0,
    following_count: user.following_count ?? user.edge_follow?.count ?? 0,
    is_private: Boolean(user.is_private),
    is_verified: Boolean(user.is_verified),
    is_business_account: Boolean(user.is_business_account || user.is_professional_account),
    highlight_reel_count: user.highlight_reel_count ?? 0,
    has_story: Boolean(user.has_story || user.latest_reel_media),
    fetchedAt: Date.now(),
  };
}

/**
 * A fetch with no timeout can hang indefinitely. Instagram will happily hold a
 * throttled connection open, and because this await sat inside the pump's
 * Promise.all, ONE stuck request froze the whole drain loop: no error, no
 * retry, just a permanently "running" pump. Always bound the wait.
 */
const FETCH_TIMEOUT_MS = 15_000;
const PROXY_TIMEOUT_MS = 20_000; // Proxy has its own 12s IG timeout + overhead

// Last upstream fault, so a tripped breaker can explain itself.
let lastFault = null;
export function lastUpstreamFault() { return lastFault; }

// Proxy stats for the dashboard
let proxyStats = { hits: 0, misses: 0, fallbacks: 0, errors: 0, cached: 0 };
export function getProxyStats() { return { ...proxyStats }; }

/**
 * Try fetching from the Cloudflare Worker cache.
 * Returns null if proxy is not configured or cache miss.
 */
async function fetchFromCache(username) {
  const proxyUrl = await getProxyUrl();
  if (!proxyUrl) return null;

  const url = `${proxyUrl.replace(/\/$/, '')}/profile?username=${encodeURIComponent(username)}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 8_000);

  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: ac.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return null;
    const body = await res.json();
    if (!body.ok || !body.cached || !body.user) return null;

    proxyStats.cached++;
    log.info('enricher', `cache hit: ${username}`);
    return { ok: true, status: 200, user: body.user };
  } catch (_) {
    clearTimeout(timer);
    return null;
  }
}

/**
 * Push a successfully fetched profile to the Worker cache for future requests.
 * Fire-and-forget — never blocks enrichment.
 */
function pushToCache(username, user) {
  getProxyUrl().then(proxyUrl => {
    if (!proxyUrl) return;
    const url = `${proxyUrl.replace(/\/$/, '')}/profile`;
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, user }),
    }).catch(() => {}); // fire-and-forget
  }).catch(() => {});
}

/**
 * Ask a live instagram.com tab to run the request for us.
 *
 * ROOT CAUSE of "N discovered / 0 enriched": a fetch issued from the MV3
 * service worker is cross-origin. Chrome attaches `Origin: chrome-extension://`
 * and withholds the first-party sessionid cookie, so Instagram's private API
 * answers 401/403 for EVERY profile - while harvesting (which runs in the
 * content script, on instagram.com) keeps working. Hence a full queue that
 * never enriches.
 */
async function fetchViaTab(url) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: 'https://www.instagram.com/*' });
  } catch (_) { return null; }
  for (const tab of tabs) {
    if (tab.discarded || tab.status === 'unloaded') continue;
    try {
      const r = await new Promise((resolve) => {
        let settled = false;
        const done = (v) => { if (!settled) { settled = true; resolve(v); } };
        setTimeout(() => done(null), FETCH_TIMEOUT_MS);
        chrome.tabs.sendMessage(tab.id, { type: MSG.PROXY_FETCH, url }, (resp) => {
          void chrome.runtime.lastError;   // no receiver on this tab
          done(resp || null);
        });
      });
      if (r && r.ok) return r;
      if (r && (r.status === 429 || r.status === 404)) return r;  // real answer
    } catch (_) { /* try the next tab */ }
  }
  return null;
}

export async function fetchProfile(username) {
  const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;

  // ── 1. Try the Worker cache (instant, zero IG cost) ───────────────────
  const fromCache = await fetchFromCache(username);
  if (fromCache) return fromCache;

  // ── 2. Try the authenticated same-origin tab path ────────────────────
  const viaTab = await fetchViaTab(url);
  if (viaTab && viaTab.ok) {
    const user = viaTab.body?.data?.user;
    if (!user) return { ok: false, status: 404 };
    // Push to cache for next time
    pushToCache(username, user);
    return { ok: true, status: 200, user };
  }
  if (viaTab && (viaTab.status === 404 || viaTab.status === 429)) {
    return {
      ok: false,
      status: viaTab.status,
      retryAfterMs: viaTab.retryAfterMs || 0,
    };
  }

  // ── 3. Direct fetch fallback ─────────────────────────────────────────
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      headers: { 'X-IG-App-ID': IG_APP_ID, 'Accept': 'application/json' },
      credentials: 'include',
      signal: ac.signal,
    });
  } catch (e) {
    return { ok: false, status: e?.name === 'AbortError' ? 408 : 0 };
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const ra = Number(res.headers?.get?.('retry-after') || 0);
    return {
      ok: false,
      status: res.status,
      retryAfterMs: Number.isFinite(ra) && ra > 0 ? Math.min(ra, 3600) * 1000 : 0,
      noAuth: res.status === 401 || res.status === 403,
    };
  }
  let body;
  try { body = await res.json(); } catch { return { ok: false, status: 502 }; }
  const user = body?.data?.user;
  if (!user) return { ok: false, status: 404 };
  // Push to cache
  pushToCache(username, user);
  return { ok: true, status: 200, user };
}

/**
 * Download and cache the profile picture WHILE THE SIGNED URL IS STILL VALID.
 *
 * Instagram CDN URLs embed an expiry (`?oe=`) and an HMAC (`?oh=`). Storing the
 * URL and rendering it later is why every dashboard card fell back to a plain
 * initial: by the time the user looked, the CDN answered 403.
 *
 * Downscaled to 96x96 WebP (~2-4 KB) so the cache stays small. Failures are
 * always non-fatal — a missing avatar must never fail an enrichment.
 */
async function cacheAvatar(username, url) {
  if (!username || !url) return;
  try {
    if (await hasFreshAvatar(username)) return;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8_000);
    let res;
    try {
      res = await fetch(url, { credentials: 'omit', signal: ac.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res?.ok) return;

    const blob = await res.blob();
    if (!blob.size || blob.size > 3_000_000) return;

    // Downscale in the worker via createImageBitmap + OffscreenCanvas. Both are
    // available in MV3 service workers; if not, fall back to the raw bytes.
    let out = blob;
    try {
      const bmp = await createImageBitmap(blob);
      const S = 96;
      const side = Math.min(bmp.width, bmp.height);
      const cnv = new OffscreenCanvas(S, S);
      const ctx = cnv.getContext('2d');
      ctx.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, S, S);
      bmp.close();
      out = await cnv.convertToBlob({ type: 'image/webp', quality: 0.82 });
    } catch (_) {
      // Keep the original blob.
    }

    await putAvatar(username, out, url);
  } catch (_) {
    // Never let avatar caching break enrichment.
  }
}

/**
 * Run a single enrich job.
 * @returns {{outcome:'done'|'retry'|'dead', after?:number, reason?:string}}
 */
export async function runEnrichJob(job, ctx) {
  const { limiter, breaker, settings, deadline = Infinity } = ctx;

  if (breaker.isOpen) {
    // Report the ORIGINAL fault, not just "breaker_open" - otherwise the UI
    // shows a generic stall and the actual 401/403 stays hidden.
    return {
      outcome: 'retry',
      after: Math.max(15_000, breaker.remaining()),
      reason: lastFault ? `breaker_open (${lastFault})` : 'breaker_open',
    };
  }

  const prospect = await db.get(STORES.PROSPECTS, job.username);
  if (!prospect) return { outcome: 'dead', reason: 'no_prospect' };

  // No slot before the pump's budget expires -> hand the job straight back so
  // the next alarm tick retries it with a fresh rate-limit window.
  //
  // Only an EXPLICIT `false` means "refused". A limiter returning undefined
  // (the old void signature, and any simple stub) must be treated as granted,
  // otherwise every job bails out before it ever reaches the network.
  const slot = await limiter.waitForSlot(deadline);
  if (slot === false) {
    return { outcome: 'retry', after: 1_000, reason: 'rate_budget_exhausted' };
  }

  let res;
  try {
    res = await fetchProfile(job.username);
  } catch (e) {
    breaker.fail();
    limiter.reportError(0);
    return { outcome: 'retry', reason: 'network' };
  }

  if (!res.ok) {
    if (res.status === 429 || res.status === 401 || res.status === 403) {
      lastFault = res.status === 429
        ? 'http_429 rate limited'
        : `http_${res.status} not authenticated - log in to instagram.com`;
      breaker.trip(res.retryAfterMs || 0);
      limiter.reportError(res.status);
      // Hand the job back no sooner than the breaker will actually reopen.
      return {
        outcome: 'retry',
        after: Math.max(60_000, breaker.remaining()),
        reason: lastFault,
      };
    }
    if (res.status === 404) {
      await markDead(job.username, 'not_found');
      return { outcome: 'dead', reason: 'not_found' };
    }
    limiter.reportError(res.status);
    breaker.fail();
    return { outcome: 'retry', reason: `http_${res.status}` };
  }

  // A success must NOT wipe an active cooldown. Jobs run concurrently, so a
  // sibling that started before the 429 can land just after it and reset a
  // breaker that Instagram has explicitly asked us to respect. That single
  // line let the pump re-probe immediately on every tick and kept the 429
  // rate pinned high. Only clear a breaker that is not currently open.
  if (!breaker.isOpen) breaker.reset();
  lastFault = null;
  limiter.reportSuccess();

  const enriched = normalizeEnriched(res.user);

  // Cache the picture BEFORE classification: the visual layer and the dashboard
  // both want it, and the signed URL is freshest right now.
  await cacheAvatar(job.username, enriched.profile_pic_url);

  const evidence = await classifyTier2(prospect.raw, enriched, settings, job.lane);
  const metrics = {
    posts: enriched.post_count,
    followers: enriched.follower_count,
    following: enriched.following_count,
  };
  const scored = scoreProspect(metrics, evidence, enriched, settings);
  const { warnings } = qualifyTier2(enriched, settings);

  await db.write([STORES.PROSPECTS], async (t) => {
    const S = t.store(STORES.PROSPECTS);
    const cur = await S.get(job.username);
    if (!cur) return;
    const next = {
      ...cur,
      enriched,
      metrics,
      evidence,
      scored,
      warnings,
      stage: STAGE.SCORED,
      label: scored.label,
      finalScore: scored.finalScore,
      femaleScore: evidence.female.value,
      femaleConfidence: evidence.female.confidence,
      accountType: classifyAccountType(enriched),
      attempts: job.attempts,
      lastError: null,
      enrichedAt: Date.now(),
      lastSeenAt: Date.now(),
      scoreVersion: SCORE_VERSION,
      bioHash: hashStr(enriched.biography || ''),
    };
    next.searchTokens = buildSearchTokens(next);
    await S.put(next);
  });

  await bumpStats({ enriched: 1 });
  return { outcome: 'done' };
}

async function markDead(username, reason) {
  await db.write([STORES.PROSPECTS], async (t) => {
    const S = t.store(STORES.PROSPECTS);
    const cur = await S.get(username);
    if (!cur) return;
    await S.put({ ...cur, stage: STAGE.DEAD, lastError: reason, lastSeenAt: Date.now() });
  });
  await bumpStats({ failed: 1 });
}

export async function markFailed(username, error) {
  await db.write([STORES.PROSPECTS], async (t) => {
    const S = t.store(STORES.PROSPECTS);
    const cur = await S.get(username);
    if (!cur) return;
    await S.put({ ...cur, stage: STAGE.FAILED, lastError: String(error || 'error'), lastSeenAt: Date.now() });
  });
}

/**
 * Re-score every record from stored `enriched` data. No network calls.
 * Replaces v1's destructive clearOldData() which soft-deleted valid records.
 */
export async function rescoreAll(settings) {
  const updates = [];
  await db.read([STORES.PROSPECTS], async (t) => {
    await t.store(STORES.PROSPECTS).cursor(null, 'next', (p) => {
      if (!p.enriched) return true;
      const metrics = p.metrics || {
        posts: p.enriched.post_count, followers: p.enriched.follower_count, following: p.enriched.following_count,
      };
      const scored = scoreProspect(metrics, p.evidence || {}, p.enriched, settings);
      updates.push({ ...p, scored, label: scored.label, finalScore: scored.finalScore, scoreVersion: SCORE_VERSION });
      return true;
    });
  });

  const CHUNK = 300;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const slice = updates.slice(i, i + CHUNK);
    await db.write([STORES.PROSPECTS], async (t) => {
      const S = t.store(STORES.PROSPECTS);
      for (const u of slice) await S.put(u);
    });
  }
  log.info('enricher', `rescored ${updates.length} prospects`);
  return updates.length;
}
