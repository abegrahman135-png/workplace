/**
 * Cloudflare Worker — Instagram Profile Proxy
 *
 * Uses R2 for profile caching (no egress fees, cheaper than KV).
 *
 * Setup:
 *   1. npx wrangler r2 bucket create pf-profile-cache
 *   2. echo "YOUR_SESSIONID" | npx wrangler secret put IG_SESSION_1
 *   3. npx wrangler deploy
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(request.headers.get('Origin')) });
    }

    if (url.pathname === '/health') return handleHealth(env);
    if (url.pathname === '/stats') return handleStats(env);
    if (url.pathname === '/profile') return handleProfile(request, env, url);
    if (url.pathname === '/profiles') return handleBatch(request, env);

    return json({ error: 'not_found' }, 404);
  },
};

// ── Session pool ───────────────────────────────────────────────────────────
function getSessions(env) {
  const sessions = [];
  for (let i = 1; i <= 10; i++) {
    const s = env[`IG_SESSION_${i}`];
    if (s) sessions.push(s);
  }
  return sessions;
}

let sessionIndex = 0;
function nextSession(env) {
  const sessions = getSessions(env);
  if (!sessions.length) return null;
  const s = sessions[sessionIndex % sessions.length];
  sessionIndex++;
  return s;
}

// ── In-flight coalescing ───────────────────────────────────────────────────
const inflight = new Map();
let coalescedCount = 0;
let missCount = 0;
let hitCount = 0;
let totalRequests = 0;

async function handleHealth(env) {
  const sessions = getSessions(env);
  return json({
    ok: true,
    ts: Date.now(),
    sessions: sessions.length,
    cache: 'r2',
  });
}

async function handleStats(env) {
  return json({
    totalRequests,
    coalesced: coalescedCount,
    cacheHits: hitCount,
    cacheMisses: missCount,
    sessions: getSessions(env).length,
  });
}

async function handleProfile(request, env, url) {
  const username = url.searchParams.get('username')?.trim()?.toLowerCase();
  if (!username || !/^[a-zA-Z0-9._]{1,30}$/.test(username)) {
    return json({ error: 'invalid_username' }, 400);
  }

  const origin = request.headers.get('Origin');
  totalRequests++;

  // 1. Check R2 cache (24h TTL)
  const cacheKey = `profiles/${username}.json`;
  try {
    const cached = await env.PROFILE_CACHE?.get(cacheKey);
    if (cached) {
      const data = await cached.json();
      if (data.fetchedAt && Date.now() - data.fetchedAt < 24 * 3600_000) {
        hitCount++;
        return json({
          ok: true, user: data.user, cached: true, fetchedAt: data.fetchedAt,
        }, 200, origin);
      }
    }
  } catch (_) {}

  // 2. Coalesce
  if (inflight.has(username)) {
    coalescedCount++;
    const result = await inflight.get(username);
    return json(result.body, result.status, origin);
  }

  // 3. Fetch from IG
  missCount++;
  const promise = doFetch(username, env);
  inflight.set(username, promise);

  try {
    const result = await promise;
    return json(result.body, result.status, origin);
  } finally {
    inflight.delete(username);
  }
}

async function doFetch(username, env) {
  const sessionId = nextSession(env);
  const igUrl = `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;

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
  };

  if (sessionId) {
    headers['Cookie'] = `sessionid=${sessionId};`;
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12_000);

  let res;
  try {
    res = await fetch(igUrl, { headers, signal: ac.signal, redirect: 'follow' });
  } catch (e) {
    clearTimeout(timer);
    return { body: { ok: false, status: 0, error: 'network_error' }, status: 502 };
  }
  clearTimeout(timer);

  if (!res.ok) {
    const ra = Number(res.headers.get('retry-after') || 0);
    return {
      body: {
        ok: false,
        status: res.status,
        retryAfterMs: ra > 0 ? Math.min(ra, 3600) * 1000 : 0,
      },
      status: res.status,
    };
  }

  const body = await res.json();
  const user = body?.data?.user;
  if (!user) return { body: { ok: false, status: 404 }, status: 404 };

  // Cache in R2 (no egress fees!)
  try {
    const cacheData = JSON.stringify({ user, fetchedAt: Date.now() });
    await env.PROFILE_CACHE?.put(`profiles/${username}.json`, cacheData, {
      httpMetadata: { contentType: 'application/json' },
      customMetadata: { fetchedAt: String(Date.now()) },
    });
  } catch (_) {}

  return {
    body: { ok: true, user, cached: false, fetchedAt: Date.now() },
    status: 200,
  };
}

async function handleBatch(request, env) {
  let usernames;
  try {
    const body = await request.json();
    usernames = body.usernames || [];
  } catch (_) {
    return json({ error: 'invalid_json' }, 400);
  }

  if (!Array.isArray(usernames) || usernames.length > 20) {
    return json({ error: 'max_20_usernames' }, 400);
  }

  const origin = request.headers.get('Origin');
  const results = await Promise.all(
    usernames.map(async (username) => {
      const cacheKey = `profiles/${username.toLowerCase()}.json`;
      try {
        const cached = await env.PROFILE_CACHE?.get(cacheKey);
        if (cached) {
          const data = await cached.json();
          if (data.fetchedAt && Date.now() - data.fetchedAt < 24 * 3600_000) {
            return { username, ok: true, user: data.user, cached: true };
          }
        }
      } catch (_) {}
      return { username, ok: false, cached: false, status: 404 };
    })
  );

  return json({ results }, 200, origin);
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-IG-App-ID',
    'Access-Control-Max-Age': '86400',
  };
}

function json(data, status = 200, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(origin ? corsHeaders(origin) : {}),
    },
  });
}
