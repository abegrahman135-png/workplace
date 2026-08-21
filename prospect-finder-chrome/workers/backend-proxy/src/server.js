/**
 * ProspectFinder Backend Proxy — Tier 3
 *
 * A Node.js server that proxies Instagram profile requests with:
 *   - Session pool rotation (multiple IG accounts)
 *   - Residential proxy support (BrightData, Oxylabs, etc.)
 *   - In-memory + file-based profile caching
 *   - Request coalescing
 *   - Per-session rate limiting
 */

import { createServer } from 'http';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { HttpProxyAgent } from 'http-proxy-agent';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Config ──────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);
const CACHE_TTL = parseInt(process.env.CACHE_TTL || '86400', 10) * 1000;
const RATE_LIMIT = parseInt(process.env.RATE_LIMIT_PER_SESSION || '20', 10);
const API_KEY = process.env.API_KEY || '';
const PROXY_URL = process.env.PROXY_URL || '';
const SESSIONS = (process.env.IG_SESSIONS || '').split(',').map(s => s.trim()).filter(Boolean);

if (!SESSIONS.length) {
  console.error('❌ IG_SESSIONS is required. Set it in .env');
  console.error('   Get your sessionid from: instagram.com → DevTools → Application → Cookies → sessionid');
  process.exit(1);
}

console.log(`📦 ${SESSIONS.length} session(s), ${RATE_LIMIT} req/min/session`);
if (PROXY_URL) {
  const masked = PROXY_URL.replace(/\/\/([^@]*?)@/, '//***@');
  console.log(`🔀 Residential proxy: ${masked}`);
}

// ── Proxy agents ────────────────────────────────────────────────────────────
let proxyAgent = null;
if (PROXY_URL) {
  try {
    proxyAgent = new HttpsProxyAgent(PROXY_URL);
    console.log('✅ Proxy agent initialized');
  } catch (e) {
    console.error(`⚠️  Proxy agent init failed: ${e.message}. Falling back to direct.`);
  }
}

// ── Cache ───────────────────────────────────────────────────────────────────
const CACHE_DIR = join(__dirname, '..', '.cache');
const cache = new Map(); // username → { user, fetchedAt }

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

// Save cache periodically (every 5 min)
setInterval(saveCache, 5 * 60_000);
process.on('SIGTERM', async () => { await saveCache(); process.exit(0); });
process.on('SIGINT', async () => { await saveCache(); process.exit(0); });

// ── Session pool with rate limiting ─────────────────────────────────────────
class SessionPool {
  constructor(sessions, rateLimit) {
    this.sessions = sessions.map(s => ({
      id: s,
      window: [],
      errors: 0,
      lastUsed: 0,
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

      // Skip sessions in cooldown (429/401/403 backoff)
      if (s.cooldownUntil > now) continue;

      s.window = s.window.filter(t => now - t < windowMs);

      if (s.window.length < this.rateLimit) {
        this.index = (idx + 1) % this.sessions.length;
        s.window.push(now);
        s.lastUsed = now;
        return s;
      }
    }

    return null;
  }

  nextSlotIn() {
    const now = Date.now();
    const windowMs = 60_000;
    let min = Infinity;

    for (const s of this.sessions) {
      if (s.cooldownUntil > now) {
        min = Math.min(min, s.cooldownUntil - now);
        continue;
      }
      s.window = s.window.filter(t => now - t < windowMs);
      if (s.window.length < this.rateLimit) return 0;
      const oldest = Math.min(...s.window);
      min = Math.min(min, windowMs - (now - oldest));
    }

    return min === Infinity ? 60_000 : min;
  }

  reportError(sessionId, status) {
    const s = this.sessions.find(x => x.id === sessionId);
    if (!s) return;
    s.errors++;
    // Exponential cooldown on repeated errors
    if (status === 429) {
      s.cooldownUntil = Date.now() + Math.min(300_000, 30_000 * Math.pow(2, Math.min(s.errors, 4)));
    } else if (status === 401 || status === 403) {
      s.cooldownUntil = Date.now() + 120_000;
    }
  }

  reportSuccess(sessionId) {
    const s = this.sessions.find(x => x.id === sessionId);
    if (s) { s.errors = Math.max(0, s.errors - 1); s.cooldownUntil = 0; }
  }

  stats() {
    const now = Date.now();
    return {
      total: this.sessions.length,
      active: this.sessions.filter(s => s.errors < 5 && s.cooldownUntil <= now).length,
      rateLimit: this.rateLimit,
      nextSlotMs: this.nextSlotIn(),
    };
  }
}

const pool = new SessionPool(SESSIONS, RATE_LIMIT);

// ── In-flight coalescing ───────────────────────────────────────────────────
const inflight = new Map();
let totalRequests = 0;
let cacheHits = 0;
let coalesced = 0;

// ── IG fetch ────────────────────────────────────────────────────────────────
async function fetchFromIG(username, session) {
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

  const fetchOpts = {
    headers,
    signal: ac.signal,
    redirect: 'follow',
  };

  // Route through residential proxy if configured
  if (proxyAgent) {
    fetchOpts.agent = proxyAgent;
  }

  let res;
  try {
    res = await fetch(url, fetchOpts);
  } catch (e) {
    clearTimeout(timer);
    pool.reportError(session.id, 0);
    return { ok: false, status: 0, error: 'network_error', retryAfterMs: 0 };
  }
  clearTimeout(timer);

  if (!res.ok) {
    const ra = Number(res.headers.get('retry-after') || 0);
    pool.reportError(session.id, res.status);
    return {
      ok: false,
      status: res.status,
      retryAfterMs: ra > 0 ? Math.min(ra, 3600) * 1000 : 0,
    };
  }

  const body = await res.json();
  const user = body?.data?.user;
  if (!user) return { ok: false, status: 404 };

  pool.reportSuccess(session.id);

  // Cache it
  const entry = { user, fetchedAt: Date.now() };
  cache.set(username.toLowerCase(), entry);

  return { ok: true, user, cached: false };
}

// ── Main fetch logic ────────────────────────────────────────────────────────
async function getProfile(username) {
  totalRequests++;
  const key = username.toLowerCase();

  // 1. Cache check
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    cacheHits++;
    return { ok: true, user: cached.user, cached: true, fetchedAt: cached.fetchedAt };
  }

  // 2. Coalesce in-flight requests
  if (inflight.has(key)) {
    coalesced++;
    return inflight.get(key);
  }

  // 3. Get a session
  const session = pool.next();
  if (!session) {
    const waitMs = pool.nextSlotIn();
    return {
      ok: false,
      status: 429,
      retryAfterMs: waitMs,
      reason: 'all_sessions_rate_limited',
    };
  }

  // 4. Fetch
  const promise = fetchFromIG(username, session);
  inflight.set(key, promise);

  try {
    return await promise;
  } finally {
    inflight.delete(key);
  }
}

// ── Batch fetch ─────────────────────────────────────────────────────────────
async function getBatch(usernames) {
  const results = [];

  for (const username of usernames) {
    const key = username.toLowerCase();

    const cached = cache.get(key);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
      cacheHits++;
      results.push({ username, ok: true, user: cached.user, cached: true });
      continue;
    }

    const session = pool.next();
    if (!session) {
      results.push({ username, ok: false, status: 429, retryAfterMs: pool.nextSlotIn() });
      continue;
    }

    const result = await fetchFromIG(username, session);
    results.push({ username, ...result });

    if (usernames.length > 1) await sleep(500);
  }

  return results;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── HTTP server ─────────────────────────────────────────────────────────────
function cors(res, origin) {
  res.setHeader('Access-Control-Allow-Origin', origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

const server = createServer(async (req, res) => {
  const origin = req.headers['origin'];
  cors(res, origin);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (API_KEY && req.headers['x-api-key'] !== API_KEY) {
    return json(res, { error: 'unauthorized' }, 401);
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/health') {
    return json(res, {
      ok: true,
      ts: Date.now(),
      cache: cache.size,
      sessions: pool.stats(),
      proxy: proxyAgent ? 'configured' : 'direct',
    });
  }

  if (url.pathname === '/stats') {
    return json(res, {
      totalRequests,
      cacheHits,
      coalesced,
      cacheSize: cache.size,
      sessions: pool.stats(),
    });
  }

  if (url.pathname === '/profile') {
    const username = url.searchParams.get('username')?.trim();
    if (!username || !/^[a-zA-Z0-9._]{1,30}$/.test(username)) {
      return json(res, { error: 'invalid_username' }, 400);
    }
    const result = await getProfile(username);
    return json(res, result);
  }

  if (url.pathname === '/profiles' && req.method === 'POST') {
    let body;
    try {
      body = await new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => data += chunk);
        req.on('end', () => resolve(JSON.parse(data)));
        req.on('error', reject);
      });
    } catch (_) {
      return json(res, { error: 'invalid_json' }, 400);
    }

    if (!Array.isArray(body.usernames) || body.usernames.length > 20) {
      return json(res, { error: 'max_20_usernames' }, 400);
    }

    const results = await getBatch(body.usernames);
    return json(res, { results });
  }

  json(res, { error: 'not_found' }, 404);
});

await loadCache();

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 ProspectFinder proxy listening on :${PORT}`);
  console.log(`   Cache: ${cache.size} profiles`);
  console.log(`   Sessions: ${SESSIONS.length}`);
  console.log(`   Rate: ${RATE_LIMIT * SESSIONS.length} req/min total`);
  console.log(`   Proxy: ${proxyAgent ? '✅ residential proxy active' : '⚪ direct (no proxy)'}`);
});
