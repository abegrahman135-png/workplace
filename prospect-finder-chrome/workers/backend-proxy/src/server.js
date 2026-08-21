/**
 * ProspectFinder Backend Proxy — Tier 3 with IP Rotation
 *
 * Routes Instagram requests through rotating residential proxies.
 * When the extension hits a 429, it switches to this backend which
 * uses different IPs for each request.
 */

import { createServer } from 'http';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { HttpsProxyAgent } from 'https-proxy-agent';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ──────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);
const CACHE_TTL = parseInt(process.env.CACHE_TTL || '86400', 10) * 1000;
const RATE_LIMIT = parseInt(process.env.RATE_LIMIT_PER_SESSION || '20', 10);
const API_KEY = process.env.API_KEY || '';

// Residential proxy pool (comma-separated)
// Format: http://user:pass@host1:port,http://user:pass@host2:port
const PROXY_URLS = (process.env.PROXY_URLS || process.env.PROXY_URL || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Instagram sessions (comma-separated)
const SESSIONS = (process.env.IG_SESSIONS || '').split(',').map(s => s.trim()).filter(Boolean);

if (!SESSIONS.length) {
  console.error('❌ IG_SESSIONS is required. Set it in .env');
  process.exit(1);
}

console.log(`📦 ${SESSIONS.length} session(s), ${RATE_LIMIT} req/min/session`);
if (PROXY_URLS.length) {
  console.log(`🔀 ${PROXY_URLS.length} residential proxy endpoint(s) configured`);
}

// ── Proxy Agent Pool ────────────────────────────────────────────────────────
class ProxyPool {
  constructor(urls) {
    this.agents = urls.map(url => ({
      url,
      agent: new HttpsProxyAgent(url),
      errors: 0,
      cooldownUntil: 0,
    }));
    this.index = 0;
  }

  /** Get next available proxy agent, or null for direct connection */
  next() {
    if (!this.agents.length) return null;
    const now = Date.now();

    for (let i = 0; i < this.agents.length; i++) {
      const idx = (this.index + i) % this.agents.length;
      const p = this.agents[idx];
      if (p.cooldownUntil > now) continue;
      this.index = (idx + 1) % this.agents.length;
      return p;
    }

    // All in cooldown — pick the one that expires soonest
    return this.agents.reduce((min, p) =>
      p.cooldownUntil < min.cooldownUntil ? p : min, this.agents[0]);
  }

  reportError(proxy) {
    if (!proxy) return;
    proxy.errors++;
    // Exponential cooldown: 30s, 60s, 120s, max 5min
    proxy.cooldownUntil = Date.now() + Math.min(300_000, 30_000 * Math.pow(2, Math.min(proxy.errors, 4)));
  }

  reportSuccess(proxy) {
    if (!proxy) return;
    proxy.errors = Math.max(0, proxy.errors - 1);
    proxy.cooldownUntil = 0;
  }

  stats() {
    const now = Date.now();
    return {
      total: this.agents.length,
      active: this.agents.filter(p => p.cooldownUntil <= now).length,
    };
  }
}

const proxyPool = new ProxyPool(PROXY_URLS);

// ── Session Pool ────────────────────────────────────────────────────────────
class SessionPool {
  constructor(sessions, rateLimit) {
    this.sessions = sessions.map(s => ({
      id: s,
      window: [],
      errors: 0,
      cooldownUntil: 0,
    }));
    this.rateLimit = rateLimit;
    this.index = 0;
  }

  next() {
    const now = Date.now();
    const windowMs = 60_000;

    for (let i = 0; i < this.sessions.length; i++) {
      const idx = (this.index + i) % this.sessions.length;
      const s = this.sessions[idx];
      if (s.cooldownUntil > now) continue;
      s.window = s.window.filter(t => now - t < windowMs);
      if (s.window.length < this.rateLimit) {
        this.index = (idx + 1) % this.sessions.length;
        s.window.push(now);
        return s;
      }
    }
    return null;
  }

  nextSlotIn() {
    const now = Date.now();
    let min = Infinity;
    for (const s of this.sessions) {
      if (s.cooldownUntil > now) { min = Math.min(min, s.cooldownUntil - now); continue; }
      s.window = s.window.filter(t => now - t < 60_000);
      if (s.window.length < this.rateLimit) return 0;
      const oldest = Math.min(...s.window);
      min = Math.min(min, 60_000 - (now - oldest));
    }
    return min === Infinity ? 60_000 : min;
  }

  reportError(id, status) {
    const s = this.sessions.find(x => x.id === id);
    if (!s) return;
    s.errors++;
    if (status === 429) s.cooldownUntil = Date.now() + Math.min(300_000, 30_000 * Math.pow(2, Math.min(s.errors, 4)));
    else if (status === 401 || status === 403) s.cooldownUntil = Date.now() + 120_000;
  }

  reportSuccess(id) {
    const s = this.sessions.find(x => x.id === id);
    if (s) { s.errors = Math.max(0, s.errors - 1); s.cooldownUntil = 0; }
  }

  stats() {
    const now = Date.now();
    return {
      total: this.sessions.length,
      active: this.sessions.filter(s => s.cooldownUntil <= now).length,
      rateLimit: this.rateLimit,
    };
  }
}

const sessionPool = new SessionPool(SESSIONS, RATE_LIMIT);

// ── Cache ───────────────────────────────────────────────────────────────────
const CACHE_DIR = join(__dirname, '..', '.cache');
const cache = new Map();

async function loadCache() {
  try {
    if (!existsSync(CACHE_DIR)) await mkdir(CACHE_DIR, { recursive: true });
    const idx = join(CACHE_DIR, 'index.json');
    if (existsSync(idx)) {
      const data = JSON.parse(await readFile(idx, 'utf8'));
      for (const [k, v] of Object.entries(data)) {
        if (Date.now() - v.fetchedAt < CACHE_TTL) cache.set(k, v);
      }
      console.log(`📂 Loaded ${cache.size} cached profiles`);
    }
  } catch (_) {}
}

async function saveCache() {
  try {
    if (!existsSync(CACHE_DIR)) await mkdir(CACHE_DIR, { recursive: true });
    const obj = {};
    for (const [k, v] of cache) {
      if (Date.now() - v.fetchedAt < CACHE_TTL) obj[k] = v;
    }
    await writeFile(join(CACHE_DIR, 'index.json'), JSON.stringify(obj));
  } catch (_) {}
}

setInterval(saveCache, 5 * 60_000);
process.on('SIGTERM', async () => { await saveCache(); process.exit(0); });
process.on('SIGINT', async () => { await saveCache(); process.exit(0); });

// ── Stats ───────────────────────────────────────────────────────────────────
let stats = { totalRequests: 0, cacheHits: 0, coalesced: 0, proxyUsed: 0, directUsed: 0, errors: 0 };

// ── In-flight coalescing ───────────────────────────────────────────────────
const inflight = new Map();

// ── IG Fetch ────────────────────────────────────────────────────────────────
async function fetchFromIG(username, session, useProxy) {
  const url = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;

  const headers = {
    'X-IG-App-ID': '936619743392459',
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'X-Requested-With': 'XMLHttpRequest',
    'Referer': `https://www.instagram.com/${username}/`,
    'Cookie': `sessionid=${session.id};`,
  };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15_000);

  const fetchOpts = { headers, signal: ac.signal, redirect: 'follow' };

  // Route through residential proxy if requested and available
  let proxyEntry = null;
  if (useProxy && PROXY_URLS.length) {
    proxyEntry = proxyPool.next();
    if (proxyEntry) {
      fetchOpts.agent = proxyEntry.agent;
    }
  }

  let res;
  try {
    res = await fetch(url, fetchOpts);
  } catch (e) {
    clearTimeout(timer);
    if (proxyEntry) proxyPool.reportError(proxyEntry);
    sessionPool.reportError(session.id, 0);
    return { ok: false, status: 0, error: 'network_error', retryAfterMs: 0 };
  }
  clearTimeout(timer);

  if (!res.ok) {
    const ra = Number(res.headers.get('retry-after') || 0);
    sessionPool.reportError(session.id, res.status);
    if (proxyEntry && (res.status === 429 || res.status === 403)) {
      proxyPool.reportError(proxyEntry);
    }
    return {
      ok: false,
      status: res.status,
      retryAfterMs: ra > 0 ? Math.min(ra, 3600) * 1000 : 0,
    };
  }

  const body = await res.json();
  const user = body?.data?.user;
  if (!user) return { ok: false, status: 404 };

  sessionPool.reportSuccess(session.id);
  if (proxyEntry) proxyPool.reportSuccess(proxyEntry);

  // Cache
  cache.set(username.toLowerCase(), { user, fetchedAt: Date.now() });

  return { ok: true, user, cached: false, viaProxy: !!proxyEntry };
}

// ── Main fetch logic ────────────────────────────────────────────────────────
async function getProfile(username, useProxy = false) {
  stats.totalRequests++;
  const key = username.toLowerCase();

  // 1. Cache
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    stats.cacheHits++;
    return { ok: true, user: cached.user, cached: true, fetchedAt: cached.fetchedAt };
  }

  // 2. Coalesce
  if (inflight.has(key)) {
    stats.coalesced++;
    return inflight.get(key);
  }

  // 3. Get session
  const session = sessionPool.next();
  if (!session) {
    return { ok: false, status: 429, retryAfterMs: sessionPool.nextSlotIn(), reason: 'all_sessions_rate_limited' };
  }

  // 4. Fetch
  const promise = fetchFromIG(username, session, useProxy);
  inflight.set(key, promise);

  try {
    const result = await promise;
    if (result.viaProxy) stats.proxyUsed++;
    else stats.directUsed++;
    return result;
  } finally {
    inflight.delete(key);
  }
}

// ── Batch ───────────────────────────────────────────────────────────────────
async function getBatch(usernames, useProxy = false) {
  const results = [];
  for (const username of usernames) {
    const key = username.toLowerCase();
    const cached = cache.get(key);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
      stats.cacheHits++;
      results.push({ username, ok: true, user: cached.user, cached: true });
      continue;
    }

    const session = sessionPool.next();
    if (!session) {
      results.push({ username, ok: false, status: 429, retryAfterMs: sessionPool.nextSlotIn() });
      continue;
    }

    const result = await fetchFromIG(username, session, useProxy);
    results.push({ username, ...result });
    if (usernames.length > 1) await sleep(500);
  }
  return results;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── HTTP Server ─────────────────────────────────────────────────────────────
function cors(res, origin) {
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key, X-Use-Proxy');
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = createServer(async (req, res) => {
  const origin = req.headers['origin'];
  cors(res, origin);

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (API_KEY && req.headers['x-api-key'] !== API_KEY) return json(res, { error: 'unauthorized' }, 401);

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const useProxy = req.headers['x-use-proxy'] === 'true' || url.searchParams.get('proxy') === 'true';

  // Health
  if (url.pathname === '/health') {
    return json(res, {
      ok: true,
      ts: Date.now(),
      cache: cache.size,
      sessions: sessionPool.stats(),
      proxies: proxyPool.stats(),
      stats: { ...stats },
    });
  }

  // Stats
  if (url.pathname === '/stats') {
    return json(res, {
      ...stats,
      cacheSize: cache.size,
      sessions: sessionPool.stats(),
      proxies: proxyPool.stats(),
    });
  }

  // Single profile
  if (url.pathname === '/profile') {
    const username = url.searchParams.get('username')?.trim();
    if (!username || !/^[a-zA-Z0-9._]{1,30}$/.test(username)) return json(res, { error: 'invalid_username' }, 400);
    const result = await getProfile(username, useProxy);
    return json(res, result);
  }

  // Batch
  if (url.pathname === '/profiles' && req.method === 'POST') {
    let body;
    try {
      body = await new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => data += chunk);
        req.on('end', () => resolve(JSON.parse(data)));
        req.on('error', reject);
      });
    } catch (_) { return json(res, { error: 'invalid_json' }, 400); }

    if (!Array.isArray(body.usernames) || body.usernames.length > 20) return json(res, { error: 'max_20' }, 400);
    const results = await getBatch(body.usernames, useProxy);
    return json(res, { results });
  }

  json(res, { error: 'not_found' }, 404);
});

await loadCache();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 ProspectFinder proxy listening on :${PORT}`);
  console.log(`   Cache: ${cache.size} profiles`);
  console.log(`   Sessions: ${SESSIONS.length}`);
  console.log(`   Proxies: ${PROXY_URLS.length} residential endpoint(s)`);
});
