/**
 * content/index.js — Instagram harvester (classic content script, no imports).
 *
 * ── Why this was rewritten ────────────────────────────────────────────────
 * v2.0 scrolled the followers dialog and waited for Instagram to fetch the
 * next page, capturing it via the MAIN-world network tap. That stopped after
 * one page (~24 profiles) because:
 *
 *   1. The scroller selector list ended in '[role="dialog"] ul'. A <ul> is not
 *      the overflow container in IG's current dialog, so `scrollTop = …` was a
 *      silent no-op — the list never moved, IG never requested page 2.
 *   2. Staleness was measured on `box.scrollHeight`. The dialog is virtualised
 *      (rows are recycled), so that number barely moves even when loading
 *      works. With the wrong scroller it never moves at all → 7 stale ticks →
 *      "Done. All processed." after ~17 s.
 *   3. Assigning scrollTop doesn't always trip React's infinite-scroll
 *      sentinel; it usually wants real wheel/scroll events.
 *
 * ── The fix: stop depending on the DOM ────────────────────────────────────
 * We already know the pagination cursor and the IG app id, so we now call the
 * same paginated endpoint Instagram itself calls, following `next_max_id`
 * until the list is exhausted. This is the PRIMARY engine: no dialog, no
 * scrolling, no virtualisation guesswork.
 *
 * DOM scrolling is kept as a hardened FALLBACK for when the API shape changes:
 * it finds the real overflow container, dispatches genuine wheel events, and
 * measures progress by *usernames harvested* rather than scrollHeight.
 *
 * "Sticky": transient failures back off and retry rather than ending the run.
 * The harvest stops only on a true end-of-list, the configured cap, an explicit
 * stop, or repeated hard failures.
 */

(() => {
  if (window.__pfContent) return;
  window.__pfContent = true;

  const PORT_NAME = 'harvest-stream';
  const M = {
    FOLLOWER_BATCH: 'FOLLOWER_BATCH', BATCH_ACK: 'BATCH_ACK', BATCH_NACK: 'BATCH_NACK',
    HEARTBEAT: 'HEARTBEAT', SCRAPE_COMPLETE: 'SCRAPE_COMPLETE', SCRAPE_ERROR: 'SCRAPE_ERROR',
    CHECKPOINT: 'CHECKPOINT_DETECTED', PROGRESS: 'PROGRESS',
    START_DIG: 'START_DIG', PAUSE_DIG: 'PAUSE_DIG', RESUME_DIG: 'RESUME_DIG', STOP_DIG: 'STOP_DIG',
    PROFILE_DETECTED: 'PROFILE_DETECTED',
  };
  const IG_APP_ID = '936619743392459';
  const PAGE_SIZE = 50;
  const RESERVED = new Set(['explore','reels','stories','direct','accounts','p','tv','reel','live','tags','locations','about','legal','_u']);

  let port = null, digging = false, paused = false, sessionId = null;
  let currentProfile = null, seen = new Set(), cursor = null;
  let batchId = 0, pending = new Map(), maxProfiles = 1000, harvested = 0, expectedTotal = 0;
  // `harvested` counts worker-ACKed rows and can lag or stall if the port
  // drops. `collected` is what we actually pulled off the network — the only
  // safe basis for cap checks and for deciding whether the API path worked.
  let collected = 0;
  // User id observed on the wire; lets the DOM fallback escape back to the API.
  let rescueUserId = null;
  let hb = null, digType = 'followers';

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const jitter = (lo, hi) => lo + Math.random() * (hi - lo);

  // ── HUD ────────────────────────────────────────────────────────────────
  function hud(msg, color = '#8b5cf6') {
    let el = document.getElementById('__pf_hud');
    if (!el) {
      el = document.createElement('div');
      el.id = '__pf_hud';
      Object.assign(el.style, {
        position: 'fixed', bottom: '18px', right: '18px', zIndex: '2147483647',
        background: 'rgba(16,16,23,.96)', border: `1px solid ${color}`, borderRadius: '12px',
        padding: '11px 15px', color: '#f5f5f8', fontSize: '12.5px',
        fontFamily: 'system-ui,sans-serif', maxWidth: '320px',
        boxShadow: '0 12px 40px -12px rgba(0,0,0,.8)', lineHeight: '1.5',
        backdropFilter: 'blur(12px)',
      });
      document.body.appendChild(el);
    }
    el.style.borderColor = color;
    el.innerHTML = `<b style="color:${color}">✦ ProspectFinder</b><br>${msg}`;
  }
  function hudHide() { document.getElementById('__pf_hud')?.remove(); }

  function progressLine(extra = '') {
    const n = Math.max(harvested, collected);
    const pct = expectedTotal ? Math.min(100, Math.round((n / expectedTotal) * 100)) : 0;
    const of = expectedTotal ? ` / ${expectedTotal.toLocaleString()} (${pct}%)` : '';
    return `📥 <b>${n.toLocaleString()}</b>${of} collected${extra ? `<br><span style="color:#a6a6bd">${extra}</span>` : ''}`;
  }

  // ── Interceptor injection ──────────────────────────────────────────────
  function inject() {
    if (document.querySelector('script[data-pf]')) return;
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('public/interceptor.js');
    s.dataset.pf = '1';
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  }
  inject();

  // ── Profile detection ──────────────────────────────────────────────────
  function detect(url) {
    const m = String(url).match(/instagram\.com\/([^/?#]+)/);
    if (!m) return;
    const slug = m[1];
    if (RESERVED.has(slug)) return;
    if (slug !== currentProfile) {
      currentProfile = slug;
      try { chrome.runtime.sendMessage({ type: M.PROFILE_DETECTED, profile: slug }); } catch (_) {}
    }
  }
  detect(location.href);
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) { lastUrl = location.href; detect(location.href); }
  }).observe(document.body || document.documentElement, { subtree: true, childList: true });

  // ── Port ───────────────────────────────────────────────────────────────
  function connect() {
    try {
      port = chrome.runtime.connect({ name: PORT_NAME });
      port.onMessage.addListener((msg) => {
        if (msg.type === M.BATCH_ACK) {
          pending.delete(msg.batchId);
          const r = msg.result;
          if (r) {
            harvested += r.inserted + r.merged;
            hud(progressLine(`new ${r.inserted} · dup ${r.merged}`));
          }
        } else if (msg.type === M.BATCH_NACK) {
          // The transaction failed, so nothing was persisted — replay it.
          const b = pending.get(msg.batchId);
          if (b) setTimeout(() => sendBatch(b.users, b.cursor, msg.batchId), 1500);
        }
      });
      port.onDisconnect.addListener(() => {
        port = null;
        if (digging) setTimeout(connect, 1200);
      });
    } catch (_) {}
  }
  connect();

  function startHb() { if (!hb) hb = setInterval(() => { try { port?.postMessage({ type: M.HEARTBEAT }); } catch (_) {} }, 15000); }
  function stopHb() { if (hb) { clearInterval(hb); hb = null; } }

  // ── Payload handling ───────────────────────────────────────────────────
  // Still listen to the MAIN-world tap: it catches the first page Instagram
  // loads on its own, plus anything the user triggers by scrolling manually.
  window.addEventListener('message', (e) => {
    if (e.data?.source !== 'PF_TAP' || e.data.type !== 'LIST_DATA') return;
    if (!digging || paused) return;

    // Instagram's own list request carries the numeric user id in its URL.
    // Capturing it lets a stalled DOM run jump back onto the API engine.
    const idm = String(e.data.url || '').match(/friendships\/(\d+)\/(followers|following)/);
    if (idm && !rescueUserId) rescueUserId = idm[1];

    const { users, cursor: c, total } = extractUsers(e.data.payload);
    if (total && !expectedTotal) expectedTotal = total;
    if (c) cursor = c;
    if (!users.length) return;
    ingest(users);
  });

  /** Filter to unseen usernames and ship them. Returns how many were new. */
  function ingest(users) {
    const fresh = users.filter(u => u.username && !seen.has(u.username));
    fresh.forEach(u => seen.add(u.username));
    collected += fresh.length;
    if (fresh.length) sendBatch(fresh, cursor);
    return fresh.length;
  }

  function extractUsers(payload) {
    let users = [], c = null, total = 0;
    if (Array.isArray(payload?.users)) {
      users = payload.users;
      c = payload.next_max_id || null;
    } else if (payload?.data?.user?.edge_followed_by?.edges) {
      const e = payload.data.user.edge_followed_by;
      users = e.edges.map(x => x.node); c = e.page_info?.end_cursor || null; total = e.count || 0;
    } else if (payload?.data?.user?.edge_follow?.edges) {
      const e = payload.data.user.edge_follow;
      users = e.edges.map(x => x.node); c = e.page_info?.end_cursor || null; total = e.count || 0;
    }
    return {
      users: users.map(u => ({
        username: u.username || '', full_name: u.full_name || '',
        profile_pic_url: u.profile_pic_url || '',
        is_private: !!u.is_private, is_verified: !!u.is_verified,
        followed_by_viewer: !!u.followed_by_viewer,
        requested_by_viewer: !!u.requested_by_viewer,
        follows_viewer: !!u.follows_viewer,
      })).filter(u => u.username),
      cursor: c, total,
    };
  }

  function sendBatch(users, cur, replayId) {
    if (!port || !sessionId) return;
    // Replays must reuse their original id, otherwise the ack/nack bookkeeping
    // drifts and a failed batch can be dropped.
    const id = replayId != null ? replayId : ++batchId;
    pending.set(id, { users, cursor: cur });
    try {
      port.postMessage({
        type: M.FOLLOWER_BATCH, sessionId, batchId: id,
        batch: users, cursor: cur, sourceUsername: currentProfile,
      });
    } catch (_) {
      setTimeout(() => sendBatch(users, cur, id), 2000);
    }
  }

  // ── API layer ──────────────────────────────────────────────────────────
  const api = (path) => `https://www.instagram.com${path}`;

  async function igFetch(url) {
    const res = await fetch(url, {
      headers: { 'X-IG-App-ID': IG_APP_ID, 'Accept': 'application/json' },
      credentials: 'include',
      referrer: location.href,
    });
    return res;
  }

  /**
   * Last-resort user-id recovery when web_profile_info is unavailable
   * (403/429 on that one endpoint, or a shape change).
   *
   * Instagram embeds the viewed profile's numeric id in the page itself. If we
   * can find it we can still drive the API engine, instead of silently falling
   * back to DOM scrolling — which is what capped this run at 12.
   */
  function scrapeUserId() {
    // 1. Inline JSON blobs: "profile_id":"123", "owner_id":"123", "user_id":"123"
    const html = document.documentElement.innerHTML;
    const m = html.match(/"(?:profile_id|owner_id|user_id)"\s*:\s*"?(\d{4,})"?/);
    if (m) return m[1];
    // 2. Any profile picture URL carries the id in its path.
    const img = document.querySelector('header img[src*="/t51."], img[alt*="profile picture"]');
    const mm = img?.src?.match(/\/(\d{6,})_/);
    return mm ? mm[1] : null;
  }

  /** Resolve numeric user id + follower/following totals. */
  async function resolveUser(username) {
    const res = await igFetch(api(`/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`));
    if (!res.ok) throw new Error(`profile_info ${res.status}`);
    const j = await res.json();
    const u = j?.data?.user;
    if (!u?.id) throw new Error('no_user_id');
    return {
      id: u.id,
      followers: u.edge_followed_by?.count || 0,
      following: u.edge_follow?.count || 0,
      isPrivate: !!u.is_private,
      followedByViewer: !!u.followed_by_viewer,
    };
  }

  /**
   * PRIMARY ENGINE. Walk the friendships endpoint cursor-by-cursor until the
   * list is exhausted. No DOM involvement whatsoever.
   * @returns {Promise<{ok:boolean, reason?:string, pages:number}>}
   */
  async function apiHarvest(sid, userId) {
    const kind = digType === 'following' ? 'following' : 'followers';
    let next = null, pages = 0, softFails = 0, emptyStreak = 0;

    while (digging) {
      if (paused) {
        hud('⏸ Paused'); startHb();
        while (paused && digging) await sleep(500);
        stopHb();
        if (!digging) break;
        hud(progressLine('resumed'));
      }
      if (collected >= maxProfiles) return { ok: true, reason: 'cap', pages };

      const qs = new URLSearchParams({ count: String(PAGE_SIZE), search_surface: 'follow_list_page' });
      if (next) qs.set('max_id', next);

      let res;
      try {
        res = await igFetch(api(`/api/v1/friendships/${userId}/${kind}/?${qs}`));
      } catch (e) {
        // Network blip — sticky: back off and retry, don't end the run.
        if (++softFails > 6) return { ok: false, reason: 'network', pages };
        hud(`⚠️ Network hiccup — retrying (${softFails}/6)`, '#fbbf24');
        await sleep(2500 * softFails);
        continue;
      }

      if (res.status === 429 || res.status === 403) {
        if (++softFails > 8) return { ok: false, reason: 'rate_limited', pages };
        const wait = Math.min(90000, 15000 * softFails);
        hud(`🐢 Instagram is throttling — waiting ${Math.round(wait / 1000)}s`, '#fbbf24');
        try { port?.postMessage({ type: M.HEARTBEAT }); } catch (_) {}
        await sleep(wait);
        continue;
      }
      if (res.status === 401) return { ok: false, reason: 'not_logged_in', pages };
      if (!res.ok) {
        if (++softFails > 6) return { ok: false, reason: `http_${res.status}`, pages };
        await sleep(3000 * softFails);
        continue;
      }

      let json;
      try { json = await res.json(); }
      catch (_) {
        if (++softFails > 6) return { ok: false, reason: 'bad_json', pages };
        await sleep(2000);
        continue;
      }

      // A challenge can arrive as a 200 with a checkpoint body.
      if (json?.message === 'challenge_required' || json?.challenge) {
        port?.postMessage({ type: M.CHECKPOINT, sessionId: sid });
        hud('⚠️ Instagram verification required — solve it in this tab, I\'ll resume', '#fbbf24');
        paused = true;
        continue;
      }

      softFails = 0;
      pages++;

      const { users, cursor: c } = extractUsers(json);
      if (c) cursor = c;
      const added = ingest(users);

      // End-of-list detection: IG stops sending a cursor. Some responses also
      // return an empty page before the cursor disappears, so tolerate a couple.
      next = json?.next_max_id || null;
      if (!users.length) {
        if (++emptyStreak >= 3) return { ok: true, reason: 'end', pages };
      } else {
        emptyStreak = 0;
      }

      hud(progressLine(`page ${pages} · +${added} new`));
      try { port?.postMessage({ type: M.HEARTBEAT }); } catch (_) {}

      if (!next) return { ok: true, reason: 'end', pages };

      // Human-ish cadence. Slightly slower every 25 pages to avoid tripping
      // rate limits on very large accounts.
      const base = pages % 25 === 0 ? jitter(6000, 9000) : jitter(1500, 2900);
      await sleep(base);
    }
    return { ok: true, reason: 'stopped', pages };
  }

  // ── DOM fallback ───────────────────────────────────────────────────────
  /** Find the element that actually scrolls, by computed overflow. */
  function findScrollerSync() {
    const dlg = document.querySelector('[role="dialog"]');
    if (!dlg) return null;
    const cands = [...dlg.querySelectorAll('div, ul')].filter((el) => {
      const st = getComputedStyle(el);
      const scrolls = /(auto|scroll)/.test(st.overflowY);
      return scrolls && el.scrollHeight > el.clientHeight + 40 && el.clientHeight > 120;
    });
    // Deepest/tallest wins — outer wrappers often also report overflow.
    return cands.sort((a, b) =>
      (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0] || null;
  }

  async function findScroller(timeoutMs = 12000) {
    const dl = Date.now() + timeoutMs;
    while (Date.now() < dl) {
      const el = findScrollerSync();
      if (el) return el;
      await sleep(400);
    }
    return null;
  }

  /** Nudge a virtualised list: real events, not just a scrollTop write. */
  function kick(box) {
    box.scrollTop = box.scrollHeight;
    box.dispatchEvent(new WheelEvent('wheel', { deltaY: 1200, bubbles: true }));
    box.dispatchEvent(new Event('scroll', { bubbles: true }));
    const rows = box.querySelectorAll('li, [role="listitem"]');
    rows[rows.length - 1]?.scrollIntoView({ block: 'end' });
  }

  async function domHarvest(sid) {
    const box = await findScroller();
    if (!box) return { ok: false, reason: 'no_scroller' };

    hud('✅ Scrolling the list…', '#34d399');
    // Progress is measured by usernames harvested, NOT scrollHeight: the list
    // is virtualised, so scrollHeight is meaningless as a liveness signal.
    let stale = 0, lastCount = -1;
    const MAX_STALE = 25;

    while (digging && stale < MAX_STALE) {
      if (paused) {
        hud('⏸ Paused'); startHb();
        while (paused && digging) await sleep(500);
        stopHb();
        if (!digging) break;
      }
      if (collected >= maxProfiles) return { ok: true, reason: 'cap' };

      if (document.querySelector('form[action*="challenge"], [data-testid="login-verification"]')) {
        port?.postMessage({ type: M.CHECKPOINT, sessionId: sid });
        hud('⚠️ Instagram verification required — paused', '#fbbf24');
        paused = true;
        continue;
      }

      kick(box);
      try { port?.postMessage({ type: M.HEARTBEAT }); } catch (_) {}
      await sleep(jitter(1600, 2800));

      if (seen.size === lastCount) {
        stale++;
        // Scrolling is stuck, but the dialog's own request leaked a user id →
        // stop guessing at the DOM and resume on the API engine.
        if (rescueUserId && stale >= 3) {
          return { ok: false, reason: 'switch_to_api', userId: rescueUserId };
        }
        if (stale % 6 === 0) {
          // Jiggle: some builds only re-arm the sentinel after moving up.
          box.scrollTop = Math.max(0, box.scrollHeight - box.clientHeight * 2);
          await sleep(500);
        }
        hud(progressLine(`waiting for more… (${stale}/${MAX_STALE})`));
      } else {
        stale = 0;
        lastCount = seen.size;
        hud(progressLine('scrolling'));
      }
    }
    return { ok: true, reason: stale >= MAX_STALE ? 'end' : 'stopped' };
  }

  // ── Dig orchestration ──────────────────────────────────────────────────
  async function startDig(username, sid, limit, type) {
    if (!username) return;
    digging = true; paused = false; sessionId = sid;
    maxProfiles = limit || 1000;
    digType = type === 'following' ? 'following' : 'followers';
    seen.clear(); harvested = 0; collected = 0; expectedTotal = 0; cursor = null;
    rescueUserId = null;
    pending.clear();

    if (!port) connect();
    await sleep(200);

    hud('⏳ Resolving account…');

    let info = null;
    try {
      info = await resolveUser(username);
      expectedTotal = digType === 'following' ? info.following : info.followers;
    } catch (e) {
      const msg = String(e?.message || e);
      if (/401|not_logged_in/.test(msg)) {
        hud('❌ Not logged in to Instagram', '#f87171');
        port?.postMessage({ type: M.SCRAPE_ERROR, sessionId: sid, error: 'Not logged in' });
        digging = false;
        return;
      }
      // Before giving up on the API, try to recover the id from the page.
      const rescuedId = scrapeUserId();
      if (rescuedId) {
        info = { id: rescuedId, followers: 0, following: 0, isPrivate: false, followedByViewer: true };
        hud('⚠️ Profile API unavailable — using page data', '#fbbf24');
      } else {
        hud('⚠️ Could not read the profile — falling back to scrolling', '#fbbf24');
      }
    }

    // Private account we don't follow → the list is genuinely unavailable.
    if (info && info.isPrivate && !info.followedByViewer) {
      hud('🔒 This account is private and you don\'t follow it', '#fbbf24');
      port?.postMessage({ type: M.SCRAPE_ERROR, sessionId: sid, error: 'Private account' });
      digging = false;
      return;
    }

    let result = { ok: false, reason: 'no_user' };

    if (info?.id) {
      // Tell the interceptor to only capture requests for this specific user
      window.postMessage({ source: 'PF_CONTENT', type: 'SET_TARGET', userId: info.id }, '*');
      hud(progressLine(`starting · ~${expectedTotal.toLocaleString()} to scan`));
      result = await apiHarvest(sid, info.id);
    }

    // Fallback: only if the API produced nothing at all.
    if ((!result.ok || collected === 0) && digging && seen.size === 0) {
      hud('↩️ Switching to scroll mode…', '#fbbf24');
      const opened = await ensureDialogOpen(username);
      if (opened) result = await domHarvest(sid);
      else result = { ok: false, reason: result.reason || 'no_dialog' };
    }

    // The DOM path recovered a user id — finish the run on the API engine.
    if (result.reason === 'switch_to_api' && result.userId && digging) {
      hud('⚡ Recovered account id — resuming fast mode', '#34d399');
      document.querySelector('[role="dialog"]')
        ?.closest('div[role="presentation"]')
        ?.querySelector('svg[aria-label="Close"]')
        ?.closest('div[role="button"]')?.click();
      result = await apiHarvest(sid, result.userId);
    }

    finish(sid, result);
  }

  /** Open the followers/following dialog for the DOM fallback path. */
  async function ensureDialogOpen(username) {
    if (document.querySelector('[role="dialog"]')) return true;

    const base = `https://www.instagram.com/${username}/`;
    if (location.href.replace(/\/$/, '') !== base.replace(/\/$/, '')) {
      location.href = base;
      await sleep(3200);
    }
    const tryFind = () => {
      const a = document.querySelector(`a[href="/${username}/${digType}/"]`)
             || document.querySelector(`a[href$="/${digType}/"]`);
      if (a) return a;
      return [...document.querySelectorAll('button, a, div[role="button"], span[role="link"]')]
        .find(el => {
          const t = el.textContent.toLowerCase();
          return digType === 'following'
            ? t.includes('following')
            : t.includes('follower') && !t.includes('following');
        }) || null;
    };
    let el = tryFind();
    const dl = Date.now() + 8000;
    while (!el && Date.now() < dl) { await sleep(400); el = tryFind(); }
    if (el) { el.click(); }
    else hud('👆 <b>Open the followers list</b> — I\'ll take over', '#fbbf24');

    const dl2 = Date.now() + 30000;
    while (Date.now() < dl2 && !document.querySelector('[role="dialog"]')) await sleep(500);
    return !!document.querySelector('[role="dialog"]');
  }

  function finish(sid, result) {
    const done = Math.max(harvested, collected).toLocaleString();
    if (!result.ok && collected === 0) {
      const why = {
        not_logged_in: 'Not logged in to Instagram',
        rate_limited: 'Instagram is rate limiting — try again in a few minutes',
        no_scroller: 'Could not find the scrollable list',
        no_dialog: 'Could not open the followers list',
        network: 'Network error',
      }[result.reason] || `Failed (${result.reason})`;
      hud(`❌ ${why}`, '#f87171');
      try { port?.postMessage({ type: M.SCRAPE_ERROR, sessionId: sid, error: why }); } catch (_) {}
    } else {
      const partial = result.reason === 'cap'
        ? ` (reached your ${maxProfiles.toLocaleString()} cap)`
        : result.reason === 'rate_limited' ? ' (stopped early — rate limited)' : '';
      hud(`✅ Done — ${done} collected${partial}.<br><span style="color:#a6a6bd">Enrichment continues in the background.</span>`, '#34d399');
      setTimeout(hudHide, 9000);
    }
    try { port?.postMessage({ type: M.SCRAPE_COMPLETE, sessionId: sid, cursor }); } catch (_) {}
    digging = false; sessionId = null; stopHb();
  }

  // ── Messages ───────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _s, respond) => {
    // The service worker cannot fetch Instagram's private API: its requests
    // carry `Origin: chrome-extension://...` and no first-party session
    // cookie, so IG answers 401/403 for every profile. This tab IS
    // instagram.com, so the same request here is same-origin and authorised.
    if (msg && msg.type === 'PROXY_FETCH') {
      (async () => {
        try {
          const res = await fetch(msg.url, {
            headers: { 'X-IG-App-ID': IG_APP_ID, 'Accept': 'application/json' },
            credentials: 'include',
          });
          if (!res.ok) {
            const ra = Number(res.headers.get('retry-after') || 0);
            respond({
              ok: false,
              status: res.status,
              retryAfterMs: ra > 0 ? Math.min(ra, 3600) * 1000 : 0,
            });
            return;
          }
          respond({ ok: true, status: 200, body: await res.json() });
        } catch (e) {
          respond({ ok: false, status: 0, error: String(e && e.message || e) });
        }
      })();
      return true;   // async response
    }

    switch (msg.type) {
      case M.START_DIG:
        startDig(msg.username || currentProfile, msg.sessionId, msg.maxProfiles, msg.digType);
        respond({ ok: true });
        break;
      case M.PAUSE_DIG: paused = true; respond({ ok: true }); break;
      case M.RESUME_DIG: paused = false; respond({ ok: true }); break;
      case M.STOP_DIG:
        digging = false; paused = false;
        try { port?.postMessage({ type: M.SCRAPE_COMPLETE, sessionId, cursor }); } catch (_) {}
        hudHide(); respond({ ok: true });
        break;
      default: respond({ ok: false });
    }
    return false;
  });
})();
