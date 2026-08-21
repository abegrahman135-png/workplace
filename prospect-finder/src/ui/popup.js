const MSG = {
  START_DIG: 'START_DIG', PAUSE_DIG: 'PAUSE_DIG', RESUME_DIG: 'RESUME_DIG',
  STOP_DIG: 'STOP_DIG', GET_STATUS: 'GET_STATUS', OPEN_DASHBOARD: 'OPEN_DASHBOARD',
};
const RESERVED = new Set(['explore','reels','stories','direct','accounts','p','tv','reel','live','tags','locations','_u']);
const $ = (id) => document.getElementById(id);

let target = '';
let paused = false;

async function detect() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url?.includes('instagram.com')) {
    $('target').textContent = 'Not on Instagram';
    $('sub').textContent = 'Open an instagram.com profile';
    $('btn-start').disabled = true;
    return;
  }
  const clean = tab.url.replace(/\/(followers|following)\/?.*$/, '/');
  const m = clean.match(/instagram\.com\/([^/?#]+)/);
  if (!m || RESERVED.has(m[1])) {
    $('target').textContent = 'No profile';
    $('sub').textContent = 'Navigate to a profile page';
    $('btn-start').disabled = true;
    return;
  }
  target = m[1];
  $('target').textContent = '@' + target;
  $('sub').textContent = 'Ready to scan followers';
  $('btn-start').disabled = false;
}

async function poll() {
  try {
    const s = await chrome.runtime.sendMessage({ type: MSG.GET_STATUS });
    if (!s?.ok) return;
    const t = s.tabs || {};
    const q = s.queue || {};
    $('k-total').textContent = (t.total || 0).toLocaleString();
    $('k-high').textContent = (t.high || 0).toLocaleString();
    $('k-queue').textContent = ((q.pending || 0) + (q.leased || 0)).toLocaleString();

    const done = (t.total || 0) - (q.pending || 0) - (q.leased || 0);
    const pct = t.total ? Math.round((done / t.total) * 100) : 0;
    $('bar').style.width = pct + '%';

    const active = s.session && s.session.status === 'running';
    $('running').classList.toggle('hide', !active);
    $('btn-start').classList.toggle('hide', !!active);

    if (active) $('pipe').textContent = `Scanning @${s.session.sourceUsername}…`;
    else if (q.pending || q.leased) $('pipe').textContent = `Enriching ${done}/${t.total} (${pct}%) — runs in background`;
    else if (q.dead) $('pipe').textContent = `${q.dead} need retry — see dashboard`;
    else $('pipe').textContent = t.total ? 'All processed' : 'Idle';
  } catch (_) {}
}

$('btn-start').onclick = async () => {
  $('btn-start').disabled = true;
  const r = await chrome.runtime.sendMessage({ type: MSG.START_DIG, username: target, digType: 'followers' });
  if (!r?.ok) { $('pipe').textContent = r?.reason || 'Could not start'; $('btn-start').disabled = false; return; }
  $('pipe').textContent = 'Starting…';
  setTimeout(() => window.close(), 700);
};
$('btn-pause').onclick = async () => {
  paused = !paused;
  await chrome.runtime.sendMessage({ type: paused ? MSG.PAUSE_DIG : MSG.RESUME_DIG });
  $('btn-pause').textContent = paused ? '▶ Resume' : '⏸ Pause';
};
$('btn-stop').onclick = async () => { await chrome.runtime.sendMessage({ type: MSG.STOP_DIG }); poll(); };
$('btn-dash').onclick = async () => { await chrome.runtime.sendMessage({ type: MSG.OPEN_DASHBOARD }); window.close(); };

detect();
poll();
setInterval(poll, 1500);
