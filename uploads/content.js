/**
 * content.js — Instagram Content Script
 *
 * Runs in Chrome's isolated extension world on instagram.com pages.
 * Responsibilities:
 *  1. Injects interceptor.js into the page's MAIN world so it can observe network calls
 *  2. Listens for intercepted follower/profile data via window.postMessage
 *  3. Detects SPA navigation (Instagram is a React app using history.pushState)
 *  4. Manages a persistent Port to the service worker for streaming follower batches
 *  5. Controls follower-list scrolling to trigger pagination
 *
 * NOTE: This file is loaded as a plain (non-module) content script.
 *       All constants are inlined to avoid import() in content scripts.
 */

// ─── Inlined constants (from lib/constants.js) ────────────────────────────────
const PORT_NAME         = 'scraper-stream';
const FOLLOWER_BATCH    = 'FOLLOWER_BATCH';
const SCRAPE_COMPLETE   = 'SCRAPE_COMPLETE';
const SCRAPE_ERROR      = 'SCRAPE_ERROR';
const HEARTBEAT         = 'HEARTBEAT';
const BATCH_ACK         = 'BATCH_ACK';
const START_DIG         = 'START_DIG';
const RESUME_DIG        = 'RESUME_DIG';
const PAUSE_DIG         = 'PAUSE_DIG';
const STOP_DIG          = 'STOP_DIG';
const PROFILE_DETECTED  = 'PROFILE_DETECTED';
const CHECKPOINT_DETECTED = 'CHECKPOINT_DETECTED';
const SCRAPE_DELAY_MS   = 2200;

// ─── On-page debug overlay ────────────────────────────────────────────────────
function showStatus(msg, color = '#7c3aed') {
  let el = document.getElementById('__pf_status');
  if (!el) {
    el = document.createElement('div');
    el.id = '__pf_status';
    Object.assign(el.style, {
      position:'fixed', bottom:'16px', right:'16px', zIndex:'999999',
      background:'#1e293b', border:`2px solid ${color}`, borderRadius:'10px',
      padding:'10px 16px', color:'#f8fafc', fontSize:'13px', fontFamily:'sans-serif',
      maxWidth:'320px', boxShadow:'0 4px 20px rgba(0,0,0,0.5)', lineHeight:'1.5'
    });
    document.body.appendChild(el);
  }
  el.style.borderColor = color;
  el.innerHTML = `<b style="color:${color}">✦ Prospect Finder</b><br>${msg}`;
  clearTimeout(el._hide);
  el._hide = setTimeout(() => el?.remove(), 8000);
}

const RESERVED_PATHS = new Set([
  'explore', 'reels', 'stories', 'direct', 'accounts',
  'p', 'tv', 'reel', 'live', 'tags', 'locations',
]);

// ─── State ────────────────────────────────────────────────────────────────────
let port               = null;
let currentProfile     = null;
let activeSessionId    = null;
let isDigging          = false;
let isPaused           = false;
let batchId            = 0;
let pendingAck         = false;          // backpressure: wait for BATCH_ACK
let heartbeatInterval  = null;
let seenThisSession    = new Set();      // per-session dedup

// ─── Interceptor injection ────────────────────────────────────────────────────

function injectInterceptor() {
  if (document.querySelector('script[data-ig-prospect]')) return; // already injected
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('public/interceptor.js');
  script.dataset.igProspect = '1';
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
}

injectInterceptor();

// ─── SPA navigation detection (dual strategy) ────────────────────────────────

let lastUrl = location.href;

// Strategy 1: Navigation API (Chrome 102+)
if ('navigation' in window) {
  window.navigation.addEventListener('navigate', (event) => {
    handleNavigation(event.destination.url);
  });
}

// Strategy 2: MutationObserver fallback
new MutationObserver(() => {
  if (location.href !== lastUrl) {
    lastUrl = location.href;
    handleNavigation(location.href);
  }
}).observe(document.body || document.documentElement, { subtree: true, childList: true });

function handleNavigation(url) {
  const profileMatch = url.match(/instagram\.com\/([^/?#]+)\/?(?:\?.*)?$/);
  if (!profileMatch) return;
  const slug = profileMatch[1];
  if (RESERVED_PATHS.has(slug)) return;

  if (slug !== currentProfile) {
    currentProfile = slug;
    chrome.runtime.sendMessage({ type: PROFILE_DETECTED, profile: slug });
  }
}

// Detect profile on initial page load
handleNavigation(location.href);

// ─── Port management (persistent connection to Service Worker) ────────────────

function connectPort() {
  try {
    port = chrome.runtime.connect({ name: PORT_NAME });

    port.onMessage.addListener((msg) => {
      switch (msg.type) {
        case BATCH_ACK:
          pendingAck = false;
          break;
        case PAUSE_DIG:
          isPaused = true;
          startHeartbeat();
          break;
        case STOP_DIG:
          stopDig();
          break;
        case RESUME_DIG:
          isPaused = false;
          stopHeartbeat();
          if (msg.sessionId) {
            activeSessionId = msg.sessionId;
            startFollowerDig(currentProfile, msg.sessionId, msg.cursor);
          }
          break;
      }
    });

    port.onDisconnect.addListener(() => {
      port = null;
      // Auto-reconnect after 1 second if we were mid-dig
      if (isDigging && !isPaused) {
        setTimeout(connectPort, 1000);
      }
    });
  } catch (e) {
    console.warn('[ProspectFinder] Could not connect port:', e);
  }
}

connectPort();

// ─── Heartbeat (keeps service worker alive when scroll is paused) ─────────────

function startHeartbeat() {
  if (heartbeatInterval) return;
  heartbeatInterval = setInterval(() => {
    if (port) port.postMessage({ type: HEARTBEAT, timestamp: Date.now() });
  }, 20000);
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

// ─── Session-level deduplication ─────────────────────────────────────────────

function dedupeBatch(batch) {
  const fresh = batch.filter(f => !seenThisSession.has(f.username));
  fresh.forEach(f => seenThisSession.add(f.username));
  return fresh;
}

// ─── Intercepted data handler ─────────────────────────────────────────────────

window.addEventListener('message', (event) => {
  if (event.data?.source !== 'IG_PROSPECT_INTERCEPTOR') return;
  if (!isDigging || isPaused) return;

  if (event.data.type === 'FOLLOWER_DATA') {
    handleFollowerData(event.data.payload);
  }
});

function handleFollowerData(payload) {
  let users = [];

  // Shape 1: /api/v1/friendships/*/followers/ → payload.users
  if (Array.isArray(payload?.users)) {
    users = payload.users;
  }
  // Shape 2: Legacy GraphQL → payload.data.user.edge_followed_by.edges[].node
  else if (payload?.data?.user?.edge_followed_by?.edges) {
    users = payload.data.user.edge_followed_by.edges.map(e => e.node);
  }

  if (!users.length) return;

  const fresh = dedupeBatch(users.map(normalizeFollower));
  if (!fresh.length) return;

  sendBatch(fresh);
}

// Detect Instagram checkpoint/verification challenges
function checkForCheckpoint() {
  const challengeDialog = document.querySelector('[data-testid="login-verification"], form[action*="challenge"]');
  if (challengeDialog && isDigging && port) {
    port.postMessage({ type: 'CHECKPOINT_DETECTED', sessionId: activeSessionId });
    isPaused = true;
    startHeartbeat();
  }
}

function normalizeFollower(raw) {
  return {
    username:             raw.username || raw.userName || '',
    full_name:            raw.full_name || raw.fullName || '',
    profile_pic_url:      raw.profile_pic_url || raw.profilePicUrl || '',
    is_private:           Boolean(raw.is_private ?? raw.isPrivate),
    is_verified:          Boolean(raw.is_verified ?? raw.isVerified),
    followed_by_viewer:   Boolean(raw.followed_by_viewer ?? raw.followedByViewer),
    requested_by_viewer:  Boolean(raw.requested_by_viewer ?? raw.requestedByViewer),
    follows_viewer:       Boolean(raw.follows_viewer ?? raw.followsViewer),
  };
}

// ─── Batch sending with backpressure ─────────────────────────────────────────

async function sendBatch(followers) {
  if (!port || !activeSessionId) return;

  // Simple backpressure: wait up to 5s for previous BATCH_ACK
  if (pendingAck) {
    await waitForAck(5000);
  }

  pendingAck = true;
  batchId++;

  port.postMessage({
    type:      FOLLOWER_BATCH,
    sessionId: activeSessionId,
    batchId,
    batch:     followers,
    cursor:    null,
  });
}

function waitForAck(timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const poll = setInterval(() => {
      if (!pendingAck || Date.now() >= deadline) {
        clearInterval(poll);
        resolve();
      }
    }, 100);
  });
}

// ─── Follower dig orchestration ───────────────────────────────────────────────

async function startFollowerDig(username, sessionId, cursor) {
  if (!username) return;

  if (!isLoggedIn()) {
    showStatus('❌ Not logged in to Instagram', '#ef4444');
    if (port) port.postMessage({ type: SCRAPE_ERROR, sessionId, error: 'Not logged in to Instagram' });
    return;
  }

  isDigging       = true;
  isPaused        = false;
  activeSessionId = sessionId;
  seenThisSession.clear();

  if (!port) connectPort();
  await sleep(400);

  showStatus('⏳ Opening followers list…');

  // ── Step 1: Always navigate to the base PROFILE page first ───────────────
  // Instagram only creates [role="dialog"] when clicking the followers count
  // from the profile page — direct /followers/ URL loads it differently.
  const profileBase = `https://www.instagram.com/${username}/`;
  const onProfilePage = location.href.replace(/\/$/, '') === profileBase.replace(/\/$/, '');

  if (!onProfilePage) {
    // Navigate to profile page
    showStatus('⏳ Navigating to profile…');
    window.location.href = profileBase;
    // Wait for React to load the profile
    await sleep(3500);
  }

  // ── Step 2: Click the followers count ────────────────────────────────────
  // Instagram has changed their DOM multiple times. Try every known strategy.
  function findFollowersElement() {
    // Strategy 1: anchor tag with /followers/ href (classic)
    const byHref =
      document.querySelector(`a[href="/${username}/followers/"]`) ||
      document.querySelector(`a[href="/${username}/followers"]`) ||
      document.querySelector('a[href$="/followers/"]');
    if (byHref) return byHref;

    // Strategy 2: button or span containing the word "followers"
    // Instagram 2024+ renders the count as a <button> or plain <span>
    const allClickable = [
      ...document.querySelectorAll('button'),
      ...document.querySelectorAll('a'),
      ...document.querySelectorAll('span[role="link"]'),
      ...document.querySelectorAll('div[role="button"]'),
    ];
    for (const el of allClickable) {
      const txt = el.textContent.toLowerCase();
      if (txt.includes('follower') && !txt.includes('following')) return el;
    }

    // Strategy 3: XPath — find any element whose text ends with "followers"
    try {
      const xp = document.evaluate(
        '//*[contains(translate(text(),"ABCDEFGHIJKLMNOPQRSTUVWXYZ","abcdefghijklmnopqrstuvwxyz"),"followers")]',
        document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
      );
      const node = xp.singleNodeValue;
      if (node && node.textContent.toLowerCase().includes('followers')) {
        // Walk up to find a clickable ancestor
        let el = node;
        for (let i = 0; i < 4; i++) {
          if (el.tagName === 'A' || el.tagName === 'BUTTON' ||
              el.getAttribute('role') === 'button' || el.getAttribute('role') === 'link') {
            return el;
          }
          el = el.parentElement;
          if (!el) break;
        }
        return node; // click the text node's element directly
      }
    } catch (_) {}

    return null;
  }

  let followersLink = findFollowersElement();

  if (!followersLink) {
    // Wait up to 6s for profile to finish rendering
    const deadline2 = Date.now() + 6000;
    while (!followersLink && Date.now() < deadline2) {
      await sleep(400);
      followersLink = findFollowersElement();
    }
  }

  if (followersLink) {
    showStatus('⏳ Clicking followers…');
    followersLink.click();
    showStatus('⏳ Followers modal opening…');
  } else {
    // Fallback: ask user to click manually and wait for the dialog to appear
    showStatus('👆 <b>Please click the Followers count</b> on this profile now — the extension will take over automatically.', '#f59e0b');
    // Wait up to 30s for the dialog to appear
    const manualDeadline = Date.now() + 30000;
    let dialogFound = false;
    while (Date.now() < manualDeadline) {
      if (document.querySelector('[role="dialog"]')) { dialogFound = true; break; }
      await sleep(500);
    }
    if (!dialogFound) {
      const errMsg = `Could not find Followers element. Page: "${document.title}" URL: ${location.href}`;
      showStatus('❌ Timed out waiting. ' + errMsg.slice(0, 80), '#ef4444');
      if (port) port.postMessage({ type: SCRAPE_ERROR, sessionId, error: errMsg });
      isDigging = false;
      return;
    }
    showStatus('⏳ Dialog detected! Scanning…');
  }

  // ── Step 3: Wait for the scrollable follower list inside the dialog ───────
  const MODAL_SELECTORS = [
    '[role="dialog"] [style*="overflow-y: auto"]',
    '[role="dialog"] [style*="overflow-y:auto"]',
    '[role="dialog"] [style*="overflow: auto"]',
    '[role="dialog"] [style*="overflow:auto"]',
    '[role="dialog"] ._aano',
    '[role="dialog"] ._aaoa',
    '[role="dialog"] ul',
  ];

  let container = null;
  const deadline = Date.now() + 12000;
  while (!container && Date.now() < deadline) {
    for (const sel of MODAL_SELECTORS) {
      const el = document.querySelector(sel);
      if (el && el.scrollHeight > 100) { container = el; break; }
    }
    if (!container) await sleep(400);
  }

  // Last resort: tallest scrollable div inside the dialog
  if (!container) {
    const dialog = document.querySelector('[role="dialog"]');
    if (dialog) {
      const allDivs = Array.from(dialog.querySelectorAll('div'));
      allDivs.sort((a, b) => b.scrollHeight - a.scrollHeight);
      for (const d of allDivs) {
        if (d.scrollHeight > 150 && d.clientHeight < d.scrollHeight) {
          container = d;
          break;
        }
      }
    }
  }

  if (!container) {
    const dialog = document.querySelector('[role="dialog"]');
    const errMsg = dialog
      ? `Modal found but no scrollable list inside (${dialog.children.length} top children). DOM: ${dialog.innerHTML.slice(0, 200)}`
      : 'No [role="dialog"] found after clicking followers link.';
    showStatus('❌ ' + errMsg.slice(0, 120), '#ef4444');
    if (port) port.postMessage({ type: SCRAPE_ERROR, sessionId, error: errMsg });
    isDigging = false;
    return;
  }

  const approxTotal = parseInt(document.querySelector('a[href$="/followers/"] span')?.textContent?.replace(/,/g,'') || '0');
  showStatus(`✅ Found list! Scanning ~${approxTotal || '?'} followers…`, '#10b981');
  await paginateFollowerList(container, sessionId, approxTotal);
}

async function paginateFollowerList(container, sessionId, approxTotal = 0) {
  let staleCount = 0;
  let lastHeight = 0;
  let scrolls    = 0;

  while (staleCount < 6 && isDigging && !isPaused) {
    container.scrollTop = container.scrollHeight;
    scrolls++;

    if (scrolls % 5 === 0) {
      showStatus(`📜 Scrolling… (${scrolls} pages, ~${approxTotal || '?'} total)`);
    }

    // Keep service worker alive
    if (port) port.postMessage({ type: HEARTBEAT, timestamp: Date.now() });

    checkForCheckpoint();

    await sleep(SCRAPE_DELAY_MS + Math.random() * 600);

    if (isPaused) {
      showStatus('⏸️ Paused — resume from the extension popup');
      startHeartbeat();
      await waitUntil(() => !isPaused, 300000);
      stopHeartbeat();
    }

    if (!isDigging) break;

    const newHeight = container.scrollHeight;
    if (newHeight === lastHeight) {
      staleCount++;
    } else {
      staleCount = 0;
      lastHeight = newHeight;
    }
  }

  showStatus('✅ Scan complete! Open the Dashboard to see results.', '#10b981');
  if (isDigging && port) {
    port.postMessage({ type: SCRAPE_COMPLETE, sessionId });
  }
  stopDig();
}

function stopDig() {
  isDigging       = false;
  isPaused        = false;
  activeSessionId = null;
  pendingAck      = false;
  stopHeartbeat();
  seenThisSession.clear();
}

// ─── One-shot message listener ────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {
    case START_DIG:
      startFollowerDig(msg.username || currentProfile, msg.sessionId, null);
      sendResponse({ started: true });
      break;
    case RESUME_DIG:
      isPaused = false;
      stopHeartbeat();
      sendResponse({ resumed: true });
      break;
    case PAUSE_DIG:
      isPaused = true;
      startHeartbeat();
      sendResponse({ paused: true });
      break;
    case STOP_DIG:
      if (port) port.postMessage({ type: SCRAPE_COMPLETE, sessionId: activeSessionId });
      stopDig();
      sendResponse({ stopped: true });
      break;
  }
  return false;
});

function isLoggedIn() {
  return !document.querySelector('a[href="/accounts/login/"]');
}

// ─── Utility helpers ──────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function waitForElement(selector, timeoutMs = 5000) {
  return new Promise(resolve => {
    const el = document.querySelector(selector);
    if (el) { resolve(el); return; }

    const observer = new MutationObserver(() => {
      const found = document.querySelector(selector);
      if (found) { observer.disconnect(); resolve(found); }
    });
    observer.observe(document.body || document.documentElement, { subtree: true, childList: true });

    setTimeout(() => { observer.disconnect(); resolve(null); }, timeoutMs);
  });
}

function waitUntil(conditionFn, timeoutMs = 60000) {
  return new Promise(resolve => {
    const start = Date.now();
    const poll = setInterval(() => {
      if (conditionFn() || Date.now() - start > timeoutMs) {
        clearInterval(poll);
        resolve();
      }
    }, 300);
  });
}
