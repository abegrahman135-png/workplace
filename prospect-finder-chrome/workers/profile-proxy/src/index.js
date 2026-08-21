/**
 * Cloudflare Worker — Instagram Profile Cache (push-based)
 *
 * Architecture:
 *   Extension fetches profile from IG (same-origin, authenticated)
 *   → pushes result to Worker → Worker caches in R2
 *   → Next request for same username → Worker serves from R2 (instant)
 *
 * This avoids the "cloud IP blocked by IG" problem entirely.
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(request.headers.get('Origin')) });
    }

    if (url.pathname === '/health') return handleHealth(request, env);
    if (url.pathname === '/stats') return handleStats(request, env);

    // GET /profile?username=xxx — check R2 cache
    if (url.pathname === '/profile' && request.method === 'GET') {
      return handleGetProfile(request, env, url);
    }

    // POST /profile — push a fetched profile into R2 cache
    if (url.pathname === '/profile' && request.method === 'POST') {
      return handlePushProfile(request, env);
    }

    // POST /profiles/batch — check multiple usernames against cache
    if (url.pathname === '/profiles/batch' && request.method === 'POST') {
      return handleBatch(request, env);
    }

    // POST /profiles/push — push multiple profiles into cache
    if (url.pathname === '/profiles/push' && request.method === 'POST') {
      return handleBatchPush(request, env);
    }

    return json({ error: 'not_found' }, 404);
  },
};

// ── Stats ───────────────────────────────────────────────────────────────────
let stats = { cacheHits: 0, cacheMisses: 0, pushes: 0, totalRequests: 0 };

// ── Health ──────────────────────────────────────────────────────────────────
async function handleHealth(request, env) {
  const origin = request.headers.get('Origin');
  return json({
    ok: true,
    ts: Date.now(),
    cache: 'r2',
    mode: 'push-based',
    ...stats,
  }, 200, origin);
}

async function handleStats(request, env) {
  const origin = request.headers.get('Origin');
  return json(stats, 200, origin);
}

// ── GET /profile — read from R2 cache ───────────────────────────────────────
async function handleGetProfile(request, env, url) {
  const username = url.searchParams.get('username')?.trim()?.toLowerCase();
  if (!username || !/^[a-zA-Z0-9._]{1,30}$/.test(username)) {
    return json({ error: 'invalid_username' }, 400);
  }

  const origin = request.headers.get('Origin');
  stats.totalRequests++;

  const cacheKey = `profiles/${username}.json`;
  try {
    const cached = await env.PROFILE_CACHE?.get(cacheKey);
    if (cached) {
      const data = await cached.json();
      // 24h TTL
      if (data.fetchedAt && Date.now() - data.fetchedAt < 24 * 3600_000) {
        stats.cacheHits++;
        return json({
          ok: true,
          user: data.user,
          cached: true,
          fetchedAt: data.fetchedAt,
        }, 200, origin);
      }
    }
  } catch (_) {}

  stats.cacheMisses++;
  return json({ ok: false, cached: false, status: 404 }, 200, origin);
}

// ── POST /profile — push profile into R2 cache ─────────────────────────────
async function handlePushProfile(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: 'invalid_json' }, 400);
  }

  const { username, user } = body;
  if (!username || !user) {
    return json({ error: 'missing username or user' }, 400);
  }

  const key = username.toLowerCase();
  const cacheKey = `profiles/${key}.json`;

  try {
    await env.PROFILE_CACHE?.put(cacheKey, JSON.stringify({
      user,
      fetchedAt: Date.now(),
    }), {
      httpMetadata: { contentType: 'application/json' },
    });
    stats.pushes++;
    return json({ ok: true, cached: true });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}

// ── POST /profiles/batch — check multiple against cache ─────────────────────
async function handleBatch(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: 'invalid_json' }, 400);
  }

  const usernames = body.usernames || [];
  if (!Array.isArray(usernames) || usernames.length > 50) {
    return json({ error: 'max_50_usernames' }, 400);
  }

  const origin = request.headers.get('Origin');
  const results = [];

  for (const username of usernames) {
    const cacheKey = `profiles/${username.toLowerCase()}.json`;
    try {
      const cached = await env.PROFILE_CACHE?.get(cacheKey);
      if (cached) {
        const data = await cached.json();
        if (data.fetchedAt && Date.now() - data.fetchedAt < 24 * 3600_000) {
          stats.cacheHits++;
          results.push({ username, ok: true, user: data.user, cached: true });
          continue;
        }
      }
    } catch (_) {}
    stats.cacheMisses++;
    results.push({ username, ok: false, cached: false });
  }

  return json({ results }, 200, origin);
}

// ── POST /profiles/push — push multiple profiles ────────────────────────────
async function handleBatchPush(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: 'invalid_json' }, 400);
  }

  const profiles = body.profiles || [];
  if (!Array.isArray(profiles) || profiles.length > 50) {
    return json({ error: 'max_50_profiles' }, 400);
  }

  let pushed = 0;
  for (const { username, user } of profiles) {
    if (!username || !user) continue;
    const cacheKey = `profiles/${username.toLowerCase()}.json`;
    try {
      await env.PROFILE_CACHE?.put(cacheKey, JSON.stringify({
        user,
        fetchedAt: Date.now(),
      }), {
        httpMetadata: { contentType: 'application/json' },
      });
      pushed++;
    } catch (_) {}
  }

  stats.pushes += pushed;
  return json({ ok: true, pushed });
}

// ── Helpers ─────────────────────────────────────────────────────────────────
function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
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
