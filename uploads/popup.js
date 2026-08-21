/**
 * popup.js — Minimal, reliable popup state machine.
 * Reads profile from current tab URL directly (no background dependency for detection).
 * Sends START_DIG to background which injects content script if needed.
 */

const RESERVED = new Set(['explore','reels','stories','direct','accounts','p','tv','reel','live','tags','locations','_u']);

let detectedUsername = '';
let sessionId = null;
let pollTimer = null;

// ─── DOM refs ────────────────────────────────────────────────────────────────
const app           = document.getElementById('app');
const elTarget      = document.getElementById('target-username');
const elActiveUser  = document.getElementById('active-username');
const elDigType     = document.getElementById('dig-type-label');
const elStatHigh    = document.getElementById('stat-high');
const elStatScanned = document.getElementById('stat-scanned');
const elProgFill    = document.getElementById('progress-fill');
const elProgCount   = document.getElementById('progress-count');
const elProgPct     = document.getElementById('progress-percent');
const elPauseCount  = document.getElementById('pause-count');
const elDoneHigh    = document.getElementById('complete-high');
const elDoneTotal   = document.getElementById('complete-total');
const elBadge       = document.getElementById('dash-badge');

// ─── State switcher ──────────────────────────────────────────────────────────
function setState(name) {
  // Valid names: not-instagram | on-feed | profile-detected | digging | paused | complete
  app.className = `app-container state-${name} popup-content`;
}

// ─── Detect profile from current tab URL ─────────────────────────────────────
async function detectProfile() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) { setState('not-instagram'); return; }

  const url = tab.url;
  if (!url.includes('instagram.com')) { setState('not-instagram'); return; }

  // Strip out /followers/ or /following/ suffix to get base username
  const clean = url.replace(/\/(followers|following)\/?.*$/, '/');
  const m = clean.match(/instagram\.com\/([^/?#]+)/);
  if (!m || RESERVED.has(m[1])) { setState('on-feed'); return; }

  detectedUsername = m[1];
  if (elTarget) elTarget.textContent = '@' + detectedUsername;
  if (elActiveUser) elActiveUser.textContent = '@' + detectedUsername;

  // Check background for active session
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (resp) => {
    if (chrome.runtime.lastError || !resp) {
      setState('profile-detected');
      return;
    }
    const { state, activeSession, highPriorityCount } = resp;
    if (activeSession) updateStats(activeSession);
    if (highPriorityCount > 0 && elBadge) {
      elBadge.style.display = 'inline-block';
      elBadge.textContent = highPriorityCount;
    }
    // Map backend state → CSS state
    if (state === 'digging')  { setState('digging');  startPoll(); }
    else if (state === 'paused') setState('paused');
    else if (state === 'complete') setState('complete');
    else setState('profile-detected');
  });
}

// ─── Stats updater ───────────────────────────────────────────────────────────
function updateStats(session) {
  const scanned  = session.scanned || 0;
  const expected = session.expectedTotal || 0;
  const high     = session.highPriority || 0;
  if (elDigType)     elDigType.textContent    = session.digType || 'followers';
  if (elStatHigh)    elStatHigh.textContent   = high;
  if (elStatScanned) elStatScanned.textContent = scanned;
  const pct = expected > 0 ? Math.min(100, Math.round(scanned / expected * 100)) : 0;
  if (elProgFill)  elProgFill.style.width    = pct + '%';
  if (elProgCount) elProgCount.textContent   = `${scanned} / ~${expected}`;
  if (elProgPct)   elProgPct.textContent     = pct + '%';
  if (elPauseCount) elPauseCount.textContent = scanned;
  if (elDoneHigh)   elDoneHigh.textContent   = high;
  if (elDoneTotal)  elDoneTotal.textContent  = scanned;
}

// ─── Poll for progress while digging ─────────────────────────────────────────
function startPoll() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    chrome.runtime.sendMessage({ type: 'GET_STATUS' }, (resp) => {
      if (chrome.runtime.lastError || !resp) return;
      const { state, activeSession } = resp;
      if (activeSession) updateStats(activeSession);
      if (state !== 'digging') { stopPoll(); setState(state || 'profile-detected'); }
    });
  }, 2000);
}

function stopPoll() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ─── DIG buttons ──────────────────────────────────────────────────────────────
function startDig(digType) {
  if (!detectedUsername) return;
  sessionId = crypto.randomUUID();

  // Immediately show scanning UI
  setState('digging');
  if (elDigType) elDigType.textContent = digType;
  if (elActiveUser) elActiveUser.textContent = '@' + detectedUsername;
  startPoll();

  chrome.runtime.sendMessage({
    type: 'START_DIG',
    payload: { username: detectedUsername, digType, sessionId }
  }, (resp) => {
    if (chrome.runtime.lastError) {
      console.error('START_DIG failed:', chrome.runtime.lastError.message);
      setState('profile-detected');
      stopPoll();
    }
  });
}

document.getElementById('btn-dig-followers')?.addEventListener('click', () => startDig('followers'));
document.getElementById('btn-dig-following')?.addEventListener('click', () => startDig('following'));

document.getElementById('btn-pause')?.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'PAUSE_DIG' });
  setState('paused');
  stopPoll();
});

document.getElementById('btn-resume')?.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'RESUME_DIG', sessionId });
  setState('digging');
  startPoll();
});

const doStop = () => {
  if (!confirm('Stop the current dig? Results so far are saved.')) return;
  chrome.runtime.sendMessage({ type: 'STOP_DIG' });
  setState('profile-detected');
  stopPoll();
};
document.getElementById('btn-stop')?.addEventListener('click', doStop);
document.getElementById('btn-stop-paused')?.addEventListener('click', doStop);

document.getElementById('btn-goto-ig')?.addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://www.instagram.com' });
});

document.getElementById('btn-dashboard')?.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'OPEN_DASHBOARD' });
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
detectProfile();
