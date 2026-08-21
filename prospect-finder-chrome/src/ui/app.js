/**
 * app.js — Dashboard controller.
 *
 * No polling. Updates arrive by BroadcastChannel and are coalesced into a
 * single rAF batch, so counters keep moving during enrichment even after a
 * scan has finished (v1 froze at that exact moment).
 */

import { db, STORES } from '../db/schema.js';
import { runQuery, tabCounts } from '../search/query.js';
import { parseShorthand } from '../search/parse.js';
import { listViews } from '../search/saved_views.js';
import { loadSettings, saveSettings } from '../db/repo.settings.js';
import { allSessions } from '../db/repo.sessions.js';
import { updateProspect, updateMany } from '../db/repo.prospects.js';
import { queueDepth, dominantError } from '../db/repo.jobs.js';
import { onBroadcast } from '../background/broadcast.js';
import { readStats } from '../background/stats.js';
import { VirtualGrid } from './components/VirtualGrid.js';
import { createCard, patchCard, setAvatarBlobs, releaseAvatarUrls, avatarUrlFor } from './components/ProspectCard.js';
import { getAvatars } from '../db/repo.avatars.js';
import { MSG, DEFAULT_SETTINGS, LABEL } from '../lib/constants.js';
import { debounce, fmtNum, relTime } from '../lib/utils.js';
import { ICON, iconLabel } from './components/icons.js';

// Queue-stall detection: no completions for this long => surface a warning.
const STALL_AFTER_MS = 90_000;
const _pipe = { lastDone: -1, since: 0 };

/** Escape untrusted text before it goes into innerHTML. */
const escHtml = (v) => String(v ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const $ = (id) => document.getElementById(id);
const PAGE = 60;

const state = {
  label: '',
  search: '',
  sort: 'priority',
  filters: {},
  rows: [],
  total: 0,
  offset: 0,
  selected: new Set(),
  settings: { ...DEFAULT_SETTINGS },
  counts: {},
  loading: false,
  activeView: null,
};

let grid;

// ─── Query assembly ─────────────────────────────────────────────────────────
function buildQuery(extra = {}) {
  const f = [];
  const F = state.filters;

  if (state.label === '__rejected') f.push({ field: 'status', op: 'eq', value: 'rejected' });
  else {
    f.push({ field: 'status', op: 'neq', value: 'rejected' });
    if (state.label) f.push({ field: 'label', op: 'eq', value: state.label });
  }

  if (F.privacy === 'private') f.push({ field: 'isPrivate', op: 'eq', value: true });
  if (F.privacy === 'public') f.push({ field: 'isPrivate', op: 'eq', value: false });
  if (F.verdict) f.push({ field: 'verdict', op: 'eq', value: F.verdict });
  if (F.conf > 0) f.push({ field: 'femaleConfidence', op: 'gte', value: F.conf / 100 });
  if (F.postsMin != null || F.postsMax != null) f.push({ field: 'posts', op: 'between', value: [F.postsMin, F.postsMax] });
  if (F.follMin != null || F.follMax != null) f.push({ field: 'followers', op: 'between', value: [F.follMin, F.follMax] });
  if (F.fingMin != null || F.fingMax != null) f.push({ field: 'following', op: 'between', value: [F.fingMin, F.fingMax] });
  if (F.ratio) f.push({ field: 'ratio', op: 'gte', value: F.ratio });
  if (F.accType) f.push({ field: 'accountType', op: 'eq', value: F.accType });
  if (F.exclude?.length) f.push({ field: 'bio', op: 'containsNone', value: F.exclude });
  if (F.source) f.push({ field: 'sourceUsernames', op: 'containsAll', value: [F.source.replace('@', '')] });
  if (F.within) f.push({ field: 'firstSeenAt', op: 'within', value: F.within });
  if (F.single) f.push({ field: 'isTaken', op: 'eq', value: false });
  if (F.noVerified) f.push({ field: 'isVerified', op: 'eq', value: false });
  if (F.noBusiness) f.push({ field: 'isBusiness', op: 'eq', value: false });
  if (F.hasStory) f.push({ field: 'hasStory', op: 'eq', value: true });
  if (F.multi) f.push({ field: 'sourceCount', op: 'gte', value: 2 });
  if (F.stage) f.push({ field: 'stage', op: F.stage.op, value: F.stage.value });

  const parsed = parseShorthand(state.search);
  f.push(...parsed.filters);

  return {
    text: parsed.text,
    filters: f,
    logic: 'AND',
    sort: { field: state.sort === 'priority' ? 'priority' : state.sort, dir: 'desc' },
    page: { offset: 0, limit: PAGE },
    needTotal: true,
    ...extra,
  };
}

// ─── Data ───────────────────────────────────────────────────────────────────
let refreshQueued = false;
/**
 * Fetch cached avatar blobs for the rows about to be rendered.
 *
 * Accumulates across pages (infinite scroll keeps earlier rows mounted) and is
 * bounded so a very long scroll cannot grow the map without limit.
 */
const AVATAR_MAP_CAP = 1200;
let avatarMap = new Map();

async function loadAvatarsFor(rows) {
  try {
    const missing = rows.map(r => r.username).filter(u => u && !avatarMap.has(u));
    if (missing.length) {
      const got = await getAvatars(missing);
      for (const [u, b] of got) avatarMap.set(u, b);
    }
    if (avatarMap.size > AVATAR_MAP_CAP) {
      // Keep only what is currently on screen.
      const keep = new Set(rows.map(r => r.username));
      const next = new Map();
      for (const [u, b] of avatarMap) if (keep.has(u)) next.set(u, b);
      avatarMap = next;
    }
    setAvatarBlobs(avatarMap);
  } catch (_) {
    // A missing avatar cache must never block the grid.
  }
}

addEventListener('pagehide', releaseAvatarUrls);

/** Full-size profile photo, for eyeballing an undecided gender verdict. */
function showPhoto(p) {
  if (!p) return;
  let back = document.getElementById('pv-back');
  if (!back) {
    back = document.createElement('div');
    back.id = 'pv-back';
    back.className = 'pv-back';
    back.innerHTML = `<div class="pv-box">
      <img alt="">
      <div class="pv-name"></div>
      <div class="pv-user"></div>
      <div class="pv-hint">Click anywhere to close</div>
    </div>`;
    document.body.appendChild(back);
    back.addEventListener('click', () => { back.dataset.open = '0'; });
    addEventListener('keydown', (e) => {
      if (e.key === 'Escape') back.dataset.open = '0';
    });
  }
  const blob = avatarMap.get(p.username);
  const net = p.enriched?.profile_pic_url || p.raw?.profile_pic_url || '';
  const src = blob ? avatarUrlFor(p.username, blob) : net;
  const img = back.querySelector('img');
  img.src = src || '';
  img.style.display = src ? '' : 'none';
  back.querySelector('.pv-name').textContent =
    p.enriched?.full_name || p.raw?.full_name || p.username;
  back.querySelector('.pv-user').textContent = '@' + p.username;
  back.dataset.open = '1';
}

async function refresh({ keepScroll = false } = {}) {
  if (state.loading) { refreshQueued = true; return; }
  state.loading = true;
  try {
    const q = buildQuery({ page: { offset: 0, limit: PAGE + state.offset } });
    const res = await runQuery(q);
    state.rows = res.rows;
    state.total = res.total;

    // Load cached avatar bytes for this page BEFORE painting, so cards render
    // with a photo on first paint instead of flashing an initial.
    await loadAvatarsFor(state.rows);

    grid.setItems(state.rows);
    if (!keepScroll) grid.scrollToTop();
    $('rescount').textContent = `${res.total.toLocaleString()} match${res.total === 1 ? '' : 'es'} · ${res.tookMs}ms`;
    $('empty').style.display = res.total === 0 ? 'flex' : 'none';
    renderChips();
  } finally {
    state.loading = false;
    if (refreshQueued) { refreshQueued = false; refresh({ keepScroll }); }
  }
}

async function refreshCounts() {
  const [c, stats, queue, qErr] = await Promise.all([
    tabCounts(), readStats(), queueDepth(), dominantError().catch(() => null),
  ]);
  state.counts = c;
  $('n-all').textContent = (c.total - c.rejected).toLocaleString();
  $('n-high').textContent = c.high.toLocaleString();
  $('n-qual').textContent = c.qualified.toLocaleString();
  $('n-rev').textContent = c.review.toLocaleString();
  $('n-pend').textContent = c.pending.toLocaleString();
  $('n-exc').textContent = c.excluded.toLocaleString();
  $('n-rej').textContent = c.rejected.toLocaleString();

  $('s-total').textContent = c.total.toLocaleString();
  $('s-enriched').textContent = (stats.enriched || 0).toLocaleString();
  $('s-high').textContent = c.high.toLocaleString();
  $('s-qualified').textContent = c.qualified.toLocaleString();
  $('s-failed').textContent = (c.dead + c.failed).toLocaleString();

  const done = c.total - queue.pending - queue.leased;
  const pct = c.total ? Math.round((done / c.total) * 100) : 0;
  $('pipe-fill').style.width = `${pct}%`;
  const dot = $('pipe-dot');
  if (queue.pending || queue.leased) {
    // Detect a stalled queue: work outstanding but the completed count hasn't
    // moved for a while. Previously a wedged pump looked identical to a slow
    // one ("Enriching 39/368" forever), so the failure was invisible.
    const now = Date.now();
    if (done !== _pipe.lastDone) { _pipe.lastDone = done; _pipe.since = now; }
    const stalledMs = now - (_pipe.since || now);

    if (stalledMs > STALL_AFTER_MS) {
      dot.className = 'dot warn';
      // Never report a stall without its cause: a silent 401/403 loop looked
      // exactly like a slow queue and hid a total outage.
      const e = String(qErr?.msg || '');
      if (/429|rate limit/i.test(e)) {
        // Waiting out a rate limit is healthy behaviour, not a stall.
        dot.className = 'dot live';
        $('pipe-txt').textContent =
          `Paused at ${done.toLocaleString()}/${c.total.toLocaleString()} — Instagram rate limit, resuming automatically`;
      } else {
        const why = /401|403|auth|logged/i.test(e)
          ? 'Instagram rejected the request — open instagram.com and make sure you are logged in'
          : e ? e.slice(0, 90) : 'click Retry to resume';
        $('pipe-txt').textContent =
          `Stalled at ${done.toLocaleString()}/${c.total.toLocaleString()} — ${why}`;
      }
    } else {
      dot.className = 'dot live';
      $('pipe-txt').textContent = `Enriching ${done.toLocaleString()}/${c.total.toLocaleString()} (${pct}%)`;
    }
  } else if (queue.dead) {
    dot.className = 'dot warn';
    $('pipe-txt').textContent = `${queue.dead} need retry`;
  } else {
    dot.className = 'dot';
    $('pipe-txt').textContent = c.total ? 'All processed' : 'Idle';
  }
}

// ─── Chips ──────────────────────────────────────────────────────────────────
function renderChips() {
  const wrap = $('chips');
  [...wrap.querySelectorAll('.chip')].forEach(c => c.remove());
  const F = state.filters;
  const chips = [];
  const add = (label, clear) => chips.push({ label, clear });

  if (state.search) add(iconLabel('search', escHtml(state.search)), () => { state.search = ''; $('search').value = ''; });
  if (F.privacy && F.privacy !== 'all') add(F.privacy === 'private' ? iconLabel('lock', 'Private') : iconLabel('globe', 'Public'), () => setPrivacy('all'));
  if (F.verdict) add(iconLabel('female', escHtml(F.verdict.replace('_', ' '))), () => { F.verdict = ''; $('f-verdict').value = ''; });
  if (F.conf) add(`≥${F.conf}% confidence`, () => { F.conf = 0; $('f-conf').value = 0; $('conf-v').textContent = '0%'; });
  if (F.postsMin != null || F.postsMax != null) add(iconLabel('camera', `${F.postsMin ?? 0}–${F.postsMax ?? '∞'}`), () => { F.postsMin = F.postsMax = null; $('f-posts-min').value = ''; $('f-posts-max').value = ''; });
  if (F.follMin != null || F.follMax != null) add(iconLabel('users', `${F.follMin ?? 0}–${F.follMax ?? '∞'}`), () => { F.follMin = F.follMax = null; $('f-foll-min').value = ''; $('f-foll-max').value = ''; });
  if (F.ratio) add(iconLabel('scale', `ratio ≥${escHtml(F.ratio)}`), () => { F.ratio = null; $('f-ratio').value = ''; });
  if (F.accType) add(iconLabel('user', escHtml(F.accType)), () => { F.accType = ''; $('f-acctype').value = ''; });
  if (F.source) add(`@${escHtml(F.source)}`, () => { F.source = ''; $('f-source').value = ''; });
  if (F.single) add(iconLabel('ring', 'Single only'), () => { F.single = false; $('f-single').checked = false; });
  if (F.multi) add(iconLabel('link', '2+ lists'), () => { F.multi = false; $('f-multi').checked = false; });

  const count = $('rescount');
  chips.forEach(({ label, clear }) => {
    const el = document.createElement('span');
    el.className = 'chip';
    el.innerHTML = `${label} <button aria-label="Remove filter">${ICON.close}</button>`;
    el.querySelector('button').onclick = () => { clear(); refresh(); };
    wrap.insertBefore(el, count);
  });
}

// ─── Filter wiring ──────────────────────────────────────────────────────────
const num = (id) => { const v = $(id).value; return v === '' ? null : Number(v); };
const deb = debounce(() => refresh(), 140);

function readFilters() {
  const F = state.filters;
  F.verdict = $('f-verdict').value;
  F.conf = Number($('f-conf').value);
  F.postsMin = num('f-posts-min'); F.postsMax = num('f-posts-max');
  F.follMin = num('f-foll-min'); F.follMax = num('f-foll-max');
  F.fingMin = num('f-fing-min'); F.fingMax = num('f-fing-max');
  F.ratio = num('f-ratio');
  F.accType = $('f-acctype').value;
  F.exclude = $('f-exclude').value.split(',').map(s => s.trim()).filter(Boolean);
  F.source = $('f-source').value.replace('@', '').trim();
  F.within = $('f-within').value;
  F.single = $('f-single').checked;
  F.noVerified = $('f-noverified').checked;
  F.noBusiness = $('f-nobusiness').checked;
  F.hasStory = $('f-hastory').checked;
  F.multi = $('f-multi').checked;
}

function setPrivacy(v) {
  state.filters.privacy = v;
  document.querySelectorAll('#seg-privacy button').forEach(b => b.classList.toggle('active', b.dataset.v === v));
  refresh();
}

function resetFilters() {
  state.filters = {};
  state.search = '';
  $('search').value = '';
  ['f-verdict', 'f-acctype', 'f-within'].forEach(i => $(i).value = '');
  ['f-posts-min', 'f-posts-max', 'f-foll-min', 'f-foll-max', 'f-fing-min', 'f-fing-max', 'f-ratio', 'f-exclude', 'f-source'].forEach(i => $(i).value = '');
  ['f-single', 'f-noverified', 'f-nobusiness', 'f-hastory', 'f-multi'].forEach(i => $(i).checked = false);
  $('f-conf').value = 0; $('conf-v').textContent = '0%';
  setPrivacyNoRefresh('all');
  state.label = '';
  syncTabs();
  state.activeView = null;
  renderViews();
}

// ─── Card actions ───────────────────────────────────────────────────────────
const handlers = {
  onSelect(u, on) {
    on ? state.selected.add(u) : state.selected.delete(u);
    updateDock();
    const node = grid.nodes.get(u);
    if (node) node.classList.toggle('sel', on);
  },
  onOpen(u) { window.open(`https://www.instagram.com/${u}/`, '_blank', 'noopener'); },
  async onBoost(u) {
    const p = state.rows.find(r => r.username === u);
    const next = !p?.manualPriority;
    await updateProspect(u, { manualPriority: next });
    toast(next ? `@${u} boosted` : `@${u} unboosted`);
    refresh({ keepScroll: true });
  },
  async onRemove(u) {
    await updateProspect(u, { status: 'rejected', rejectedAt: Date.now() });
    state.selected.delete(u);
    toast(`@${u} removed`);
    refresh({ keepScroll: true });
    refreshCounts();
  },
  onWhy(u) { showWhy(state.rows.find(r => r.username === u)); },
  onAvatar(u) { showPhoto(state.rows.find(r => r.username === u)); },
};

function showWhy(p) {
  if (!p) return;
  $('why-title').textContent = `@${p.username} — ${p.finalScore ?? '—'} pts`;
  const d = p.scored?.dims;
  const ev = p.evidence?.female;
  const rows = [];

  if (d) {
    rows.push('<div style="display:flex;flex-direction:column;gap:8px">');
    for (const [k, v] of Object.entries(d)) {
      const pct = v.max ? Math.round((v.score / v.max) * 100) : 0;
      const nm = { postCount: 'Posts', followersQuality: 'Followers', followingQuality: 'Following' }[k] || k;
      rows.push(`<div class="slider"><span>${nm}</span><div class="bar" style="height:6px"><i style="width:${pct}%"></i></div><span class="v">${Math.round(v.score)}/${v.max}</span></div>
        <div style="font-size:11px;color:var(--fg-2);margin:-6px 0 4px 110px">${v.raw.toLocaleString()} — ${v.tier}</div>`);
    }
    rows.push('</div>');
  } else {
    rows.push('<div style="color:var(--fg-2);font-size:12.5px">Not enriched yet — this profile is still in the queue.</div>');
  }

  const gates = p.scored?.gates || {};
  const applied = Object.entries(gates).filter(([, v]) => v < 1);
  if (applied.length) {
    rows.push(`<div class="warnbox"><b>Suppressors applied</b><br>${applied.map(([k, v]) => `${k}: ×${v}`).join('<br>')}</div>`);
  }

  if (ev) {
    rows.push(`<div class="card-box" style="padding:11px">
      <div style="font-size:12px;font-weight:600;margin-bottom:5px">Gender evidence — ${ev.verdict.replace('_', ' ')} (${Math.round((ev.confidence || 0) * 100)}% confidence)</div>
      <div style="font-size:11.5px;color:var(--fg-2)">${(ev.sources || []).join(' · ') || 'no signals yet'}</div>
    </div>`);
  }

  if (p.scored?.reasons?.length) {
    rows.push(`<div style="display:flex;flex-wrap:wrap;gap:5px">${p.scored.reasons.map(r => `<span class="badge">${r}</span>`).join('')}</div>`);
  }

  $('why-body').innerHTML = rows.join('');
  $('why-mask').classList.add('show');
}

function updateDock() {
  const n = state.selected.size;
  $('dock-n').textContent = n;
  $('dock').classList.toggle('show', n > 0);
}

// ─── Views ──────────────────────────────────────────────────────────────────
let views = [];
async function renderViews() {
  views = await listViews();
  const wrap = $('views');
  wrap.innerHTML = '';
  for (const v of views) {
    const b = document.createElement('button');
    b.className = 'viewbtn' + (state.activeView === v.id ? ' active' : '');
    b.innerHTML = `<span class="vi">${ICON[v.icon] || ICON.star}</span><span>${escHtml(v.name)}</span>`;
    b.onclick = () => applyView(v);
    wrap.appendChild(b);
  }
}

function applyView(v) {
  resetFilters();
  state.activeView = v.id;
  const q = v.query || {};
  for (const c of q.filters || []) {
    switch (c.field) {
      case 'label': state.label = c.value; syncTabs(); break;
      case 'isPrivate': setPrivacyNoRefresh(c.value ? 'private' : 'public'); break;
      case 'posts': if (c.op === 'gte') { state.filters.postsMin = c.value; $('f-posts-min').value = c.value; } break;
      case 'followers':
        if (c.op === 'between') { state.filters.follMin = c.value[0]; state.filters.follMax = c.value[1]; $('f-foll-min').value = c.value[0]; $('f-foll-max').value = c.value[1]; }
        if (c.op === 'lt') { state.filters.follMax = c.value; $('f-foll-max').value = c.value; }
        break;
      case 'femaleConfidence': state.filters.conf = Math.round(c.value * 100); $('f-conf').value = state.filters.conf; $('conf-v').textContent = `${state.filters.conf}%`; break;
      case 'ratio': state.filters.ratio = c.value; $('f-ratio').value = c.value; break;
      case 'verdict': state.filters.verdict = c.value; $('f-verdict').value = c.value; break;
      case 'stage':
        state.filters.stage = { op: c.op, value: c.value };
        state.label = '';
        syncTabs();
        break;
      case 'firstSeenAt': state.filters.within = c.value; $('f-within').value = c.value; break;
    }
  }
  if (q.sort?.field) { state.sort = q.sort.field; $('sort').value = q.sort.field; }
  renderViews();
  refresh();
}

function setPrivacyNoRefresh(v) {
  state.filters.privacy = v;
  document.querySelectorAll('#seg-privacy button').forEach(b => b.classList.toggle('active', b.dataset.v === v));
}

function syncTabs() {
  document.querySelectorAll('#tabs .tab').forEach(t => t.classList.toggle('active', (t.dataset.label || '') === state.label));
}

// ─── Sessions / settings panels ─────────────────────────────────────────────
async function renderSessions() {
  const list = await allSessions();
  const wrap = $('sessions');
  if (!list.length) { wrap.innerHTML = '<div style="color:var(--fg-2);font-size:12.5px">No scans yet.</div>'; return; }
  wrap.innerHTML = list.sort((a, b) => b.createdAt - a.createdAt).map(s => `
    <div class="sesrow">
      <span class="pill ${s.status}">${s.status}</span>
      <b>@${s.sourceUsername}</b>
      <span style="color:var(--fg-2)">${relTime(s.createdAt)}</span>
      <span style="margin-left:auto;color:var(--fg-2);font-size:11.5px">
        seen ${s.stats?.seen ?? 0} · new ${s.stats?.inserted ?? 0} · dup ${s.stats?.merged ?? 0}${s.stats?.rejected ? ` · invalid ${s.stats.rejected}` : ''}
      </span>
    </div>`).join('');
}

async function renderHealth() {
  const q = await queueDepth();
  const stats = await readStats();
  let proxyHtml = '';
  try {
    const s = await chrome.runtime.sendMessage({ type: MSG.GET_STATUS });
    const p = s?.health?.proxy;
    if (p && (p.hits || p.cached || p.misses || p.fallbacks)) {
      proxyHtml = `
        <div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line-1)">
          <div style="font-size:12px;font-weight:600;margin-bottom:8px">Proxy stats</div>
          <div class="grid2">
            <div class="field"><label>Cache hits</label><b style="font-size:14px;color:var(--success)">${p.cached}</b></div>
            <div class="field"><label>IG fetches</label><b style="font-size:14px">${p.hits}</b></div>
            <div class="field"><label>Coalesced</label><b style="font-size:14px">${p.misses}</b></div>
            <div class="field"><label>Fallbacks</label><b style="font-size:14px;color:var(--warn)">${p.fallbacks}</b></div>
          </div>
        </div>`;
    }
  } catch (_) {}

  $('health').innerHTML = `
    <div class="field"><label>Queued</label><b style="font-size:18px">${q.pending.toLocaleString()}</b></div>
    <div class="field"><label>In flight</label><b style="font-size:18px">${q.leased}</b></div>
    <div class="field"><label>Needs retry</label><b style="font-size:18px;color:var(--warn)">${q.dead}</b></div>
    <div class="field"><label>Enriched</label><b style="font-size:18px;color:var(--success)">${(stats.enriched || 0).toLocaleString()}</b></div>
    ${proxyHtml}`;
}

function renderWeights() {
  const w = state.settings.weights || {};
  const names = { postCount: 'Posts', followersQuality: 'Followers', followingQuality: 'Following' };
  $('weights').innerHTML = Object.entries(w).map(([k, v]) => `
    <div class="slider">
      <span>${names[k] || k}</span>
      <input type="range" min="0" max="80" value="${v}" data-w="${k}">
      <span class="v" id="wv-${k}">${v}</span>
    </div>`).join('');
  $('weights').querySelectorAll('input').forEach(i => {
    i.oninput = () => {
      state.settings.weights[i.dataset.w] = Number(i.value);
      $(`wv-${i.dataset.w}`).textContent = i.value;
    };
  });
}

function fillSettings() {
  const s = state.settings;
  $('set-minposts').value = s.minPosts;
  $('set-minfemale').value = s.minFemaleScore;
  $('set-minfoll').value = s.minFollowers ?? '';
  $('set-maxfoll').value = s.maxFollowers ?? '';
  $('set-minfing').value = s.minFollowing ?? '';
  $('set-maxfing').value = s.maxFollowing ?? '';
  $('set-exverified').checked = !!s.excludeVerified;
  $('set-exbusiness').checked = !!s.excludeBusinesses;
  $('set-conc').value = s.enrichConcurrency;
  $('set-cap').value = s.perMinuteCap;
  $('set-delay').value = s.enrichDelayMs;
  $('set-maxprof').value = s.maxProfilesPerSession;
  $('set-visual').checked = !!s.enableVisualClassifier;
  $('set-visualfast').checked = !!s.visualFastLaneOnly;
  $('set-purge').value = s.autoPurgeDays ?? 0;
  renderWeights();
  loadProxySettings();
}

// ── Proxy settings ──────────────────────────────────────────────────────────
const PROXY_STORAGE_KEY = 'pf-proxy-url';

async function loadProxySettings() {
  try {
    const o = await chrome.storage.local.get(['pf-proxy-url', 'pf-backend-url']);
    $('set-proxy-url').value = o?.['pf-proxy-url'] || '';
    $('set-backend-url').value = o?.['pf-backend-url'] || '';
    updateProxyStatus();
  } catch (_) {}
}

function updateProxyStatus() {
  const url = $('set-proxy-url').value.trim();
  const backend = $('set-backend-url').value.trim();
  const el = $('proxy-status');
  let html = '';
  if (!url && !backend) {
    html = '<span style="color:var(--fg-2)">⚪ Direct mode — requests go through your browser</span>';
  } else {
    if (url) html += '<span style="color:var(--info)">🔵 R2 cache proxy configured</span><br>';
    if (backend) html += '<span style="color:var(--success)">🟢 Backend proxy configured (IP rotation on429)</span>';
  }
  el.innerHTML = html;
}

async function testProxy() {
  const url = $('set-proxy-url').value.trim();
  if (!url) { toast('Enter a proxy URL first', 'error'); return; }

  const el = $('proxy-status');
  el.innerHTML = '<span style="color:var(--fg-2)">⏳ Testing…</span>';

  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/health`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.ok) {
      const sessions = data.sessions || 0;
      const cached = data.cached || '0';
      el.innerHTML = `<span style="color:var(--success)">✅ Connected — ${sessions} session(s), ${cached} cached profiles</span>`;
    } else {
      el.innerHTML = '<span style="color:var(--warn)">⚠️ Proxy responded but not healthy</span>';
    }
  } catch (e) {
    el.innerHTML = `<span style="color:var(--danger)">❌ ${e.message || 'Connection failed'}</span>`;
  }
}

async function saveProxySettings() {
  const url = $('set-proxy-url').value.trim();
  const backend = $('set-backend-url').value.trim();
  try {
    const toSet = {};
    const toRemove = [];
    if (url) toSet['pf-proxy-url'] = url; else toRemove.push('pf-proxy-url');
    if (backend) toSet['pf-backend-url'] = backend; else toRemove.push('pf-backend-url');
    if (Object.keys(toSet).length) await chrome.storage.local.set(toSet);
    if (toRemove.length) await chrome.storage.local.remove(toRemove);
    // Notify the background worker
    try { await chrome.runtime.sendMessage({ type: 'SETTINGS_UPDATED' }); } catch (_) {}
  } catch (_) {}
}

async function doSaveSettings() {
  const s = state.settings;
  Object.assign(s, {
    minPosts: Number($('set-minposts').value) || 0,
    minFemaleScore: Number($('set-minfemale').value) || 0,
    minFollowers: Number($('set-minfoll').value) || 0,
    maxFollowers: $('set-maxfoll').value ? Number($('set-maxfoll').value) : null,
    minFollowing: Number($('set-minfing').value) || 0,
    maxFollowing: $('set-maxfing').value ? Number($('set-maxfing').value) : null,
    excludeVerified: $('set-exverified').checked,
    excludeBusinesses: $('set-exbusiness').checked,
    enrichConcurrency: Number($('set-conc').value) || 3,
    perMinuteCap: Number($('set-cap').value) || 35,
    enrichDelayMs: Number($('set-delay').value) || 1500,
    maxProfilesPerSession: Number($('set-maxprof').value) || 1000,
    enableVisualClassifier: $('set-visual').checked,
    visualFastLaneOnly: $('set-visualfast').checked,
    autoPurgeDays: Number($('set-purge').value) || 0,
  });
  await saveSettings(s);
  try { await chrome.runtime.sendMessage({ type: MSG.SETTINGS_UPDATED, settings: s }); } catch (_) {}
  toast('Settings saved. Use "Re-score all" to apply new weights.', 'success');
}

// ─── Export ─────────────────────────────────────────────────────────────────
const CSV_COLS = [
  ['Username', p => p.username],
  ['Full name', p => p.enriched?.full_name || p.raw?.full_name || ''],
  ['Score', p => p.finalScore ?? ''],
  ['Label', p => p.label || ''],
  ['Female score', p => p.femaleScore ?? ''],
  ['Confidence', p => p.femaleConfidence ?? ''],
  ['Verdict', p => p.evidence?.female?.verdict || ''],
  ['Posts', p => p.metrics?.posts ?? ''],
  ['Followers', p => p.metrics?.followers ?? ''],
  ['Following', p => p.metrics?.following ?? ''],
  ['Private', p => (p.enriched?.is_private ?? p.raw?.is_private) ? 'Yes' : 'No'],
  ['Verified', p => p.raw?.is_verified ? 'Yes' : 'No'],
  ['Account type', p => p.accountType || ''],
  ['Bio', p => (p.enriched?.biography || '').replace(/\s+/g, ' ')],
  ['Sources', p => (p.sourceUsernames || []).join(';')],
  ['Stage', p => p.stage || ''],
  ['First seen', p => p.firstSeenAt ? new Date(p.firstSeenAt).toISOString() : ''],
  ['URL', p => `https://instagram.com/${p.username}`],
];

function toCsv(rows) {
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  return [CSV_COLS.map(c => c[0]).join(','), ...rows.map(p => CSV_COLS.map(c => esc(c[1](p))).join(','))].join('\n');
}

function download(text, name, mime = 'text/csv') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function exportCurrent() {
  const q = buildQuery({ page: { offset: 0, limit: 100000 }, needTotal: true });
  const res = await runQuery(q);
  download(toCsv(res.rows), `prospects-${Date.now()}.csv`);
  toast(`Exported ${res.rows.length} prospects`, 'success');
}

// ─── Command palette ────────────────────────────────────────────────────────
const COMMANDS = [
  { icon: 'fire', label: 'Show high priority', hint: 'tab', run: () => { state.label = LABEL.HIGH; syncTabs(); refresh(); } },
  { icon: 'question', label: 'Show unknown gender (needs review)', hint: 'view', run: () => applyView(views.find(v => v.id === 'builtin:unknown')) },
  { icon: 'recycle', label: 'Retry failed profiles', hint: 'action', run: () => retryFailed() },
  { label: '⟳ Re-score everything', hint: 'action', run: () => rescore() },
  { icon: 'play', label: 'Process queue now', hint: 'action', run: () => pumpNow() },
  { icon: 'down', label: 'Export current view', hint: 'action', run: () => exportCurrent() },
  { label: '◐ Toggle theme', hint: 'ui', run: () => toggleTheme() },
  { icon: 'grid', label: 'Toggle density', hint: 'ui', run: () => toggleDensity() },
  { icon: 'close', label: 'Reset all filters', hint: 'ui', run: () => { resetFilters(); refresh(); } },
];

function openPalette() {
  $('pal-mask').classList.add('show');
  $('pal-input').value = '';
  $('pal-input').focus();
  renderPalette('');
}

function renderPalette(q) {
  const ql = q.toLowerCase();
  const cmds = COMMANDS.filter(c => c.label.toLowerCase().includes(ql));
  const items = [];
  if (q.trim()) {
    items.push(`<div class="pal-item on" data-i="-1"><span class="pi">${ICON.search}</span><span>Search for “${escHtml(q)}”</span><span class="hint">enter</span></div>`);
  }
  cmds.forEach((c, i) => items.push(`<div class="pal-item" data-i="${i}"><span class="pi">${ICON[c.icon] || ''}</span><span>${escHtml(c.label)}</span><span class="hint">${escHtml(c.hint)}</span></div>`));
  $('pal-list').innerHTML = items.join('');
  $('pal-list').querySelectorAll('.pal-item').forEach(el => {
    el.onclick = () => {
      const i = Number(el.dataset.i);
      $('pal-mask').classList.remove('show');
      if (i === -1) { state.search = $('pal-input').value; $('search').value = state.search; refresh(); }
      else cmds[i].run();
    };
  });
}

// ─── Actions ────────────────────────────────────────────────────────────────
async function pumpNow() { try { await chrome.runtime.sendMessage({ type: MSG.PUMP_NOW }); toast('Queue processing…'); } catch (_) { toast('Background worker unavailable', 'error'); } }
async function retryFailed() {
  try {
    const r = await chrome.runtime.sendMessage({ type: MSG.REQUEUE_FAILED });
    toast(`Re-queued ${r?.requeued ?? 0} profiles`, 'success');
    refreshCounts();
  } catch (_) { toast('Could not reach worker', 'error'); }
}
async function rescore() {
  try {
    const r = await chrome.runtime.sendMessage({ type: MSG.RESCORE_ALL });
    toast(`Re-scored ${r?.rescored ?? 0} prospects`, 'success');
    refresh(); refreshCounts();
  } catch (_) { toast('Could not reach worker', 'error'); }
}

function toggleTheme() {
  const cur = document.documentElement.dataset.theme;
  document.documentElement.dataset.theme = cur === 'dark' ? 'light' : 'dark';
  localStorage.setItem('pf_theme', document.documentElement.dataset.theme);
}
function toggleDensity() {
  const cur = document.documentElement.dataset.density;
  const next = cur === 'comfortable' ? 'compact' : 'comfortable';
  document.documentElement.dataset.density = next;
  localStorage.setItem('pf_density', next);
  grid.itemHeight = next === 'compact' ? 116 : 172;
  grid.setItems(state.rows);
}

function toast(msg, kind = '') {
  const d = document.createElement('div');
  d.className = `toast ${kind}`;
  d.textContent = msg;
  $('toasts').appendChild(d);
  setTimeout(() => { d.style.opacity = '0'; setTimeout(() => d.remove(), 200); }, 2800);
}

// ─── Live updates (no polling) ──────────────────────────────────────────────
let pendingUpdate = false;
function scheduleLive() {
  if (pendingUpdate) return;
  pendingUpdate = true;
  requestAnimationFrame(() => {
    setTimeout(async () => {
      pendingUpdate = false;
      await refreshCounts();
      await refresh({ keepScroll: true });
      if ($('panel-sessions').classList.contains('active')) { renderSessions(); renderHealth(); }
    }, 250);
  });
}

// ─── Boot ───────────────────────────────────────────────────────────────────
async function init() {
  document.documentElement.dataset.theme = localStorage.getItem('pf_theme') || 'dark';
  document.documentElement.dataset.density = localStorage.getItem('pf_density') || 'comfortable';

  await db.open();
  state.settings = await loadSettings();

  grid = new VirtualGrid({
    scroller: $('scroller'),
    spacer: $('vspace'),
    window: $('vwin'),
    itemHeight: document.documentElement.dataset.density === 'compact' ? 116 : 172,
    create: () => createCard(handlers),
    patch: (node, item) => patchCard(node, item, state.selected.has(item.username)),
    keyOf: (p) => p.username,
  });
  grid.measure();

  // Nav
  document.querySelectorAll('.nav-tab').forEach(t => t.onclick = () => {
    document.querySelectorAll('.nav-tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    $(`panel-${t.dataset.panel}`).classList.add('active');
    if (t.dataset.panel === 'sessions') { renderSessions(); renderHealth(); }
    if (t.dataset.panel === 'settings') fillSettings();
  });

  // Tabs
  document.querySelectorAll('#tabs .tab').forEach(t => t.onclick = () => {
    state.label = t.dataset.label || '';
    state.offset = 0;
    syncTabs();
    refresh();
  });

  // Filters
  $('search').addEventListener('input', e => { state.search = e.target.value; deb(); });
  document.querySelectorAll('#seg-privacy button').forEach(b => b.onclick = () => setPrivacy(b.dataset.v));
  ['f-verdict', 'f-acctype', 'f-within'].forEach(i => $(i).onchange = () => { readFilters(); refresh(); });
  ['f-posts-min', 'f-posts-max', 'f-foll-min', 'f-foll-max', 'f-fing-min', 'f-fing-max', 'f-ratio', 'f-exclude', 'f-source'].forEach(i => $(i).addEventListener('input', () => { readFilters(); deb(); }));
  ['f-single', 'f-noverified', 'f-nobusiness', 'f-hastory', 'f-multi'].forEach(i => $(i).onchange = () => { readFilters(); refresh(); });
  $('f-conf').addEventListener('input', e => { $('conf-v').textContent = `${e.target.value}%`; readFilters(); deb(); });
  $('sort').onchange = e => { state.sort = e.target.value; refresh(); };
  $('btn-clear-filters').onclick = () => { resetFilters(); refresh(); };
  $('btn-empty-reset').onclick = () => { resetFilters(); refresh(); };
  $('btn-side').onclick = () => $('sidebar').classList.toggle('collapsed');

  // Infinite scroll
  $('scroller').addEventListener('scroll', () => {
    const s = $('scroller');
    if (s.scrollTop + s.clientHeight > s.scrollHeight - 600 && state.rows.length < state.total && !state.loading) {
      state.offset += PAGE;
      refresh({ keepScroll: true });
    }
  }, { passive: true });

  // Header
  $('btn-export').onclick = exportCurrent;
  $('btn-theme').onclick = toggleTheme;
  $('btn-density').onclick = toggleDensity;
  $('btn-palette').onclick = openPalette;
  $('btn-retry').onclick = retryFailed;
  $('btn-retry2').onclick = retryFailed;
  $('btn-pump').onclick = pumpNow;
  $('btn-rescore').onclick = rescore;
  $('btn-save').onclick = async () => { await saveProxySettings(); doSaveSettings(); };
  $('btn-proxy-test').onclick = testProxy;
  $('btn-proxy-clear').onclick = async () => { $('set-proxy-url').value = ''; updateProxyStatus(); };
  $('set-proxy-url').addEventListener('input', updateProxyStatus);

  $('btn-selall').onclick = () => {
    state.rows.forEach(p => state.selected.add(p.username));
    updateDock();
    grid.updateItems(state.rows);
  };

  // Dock
  $('dk-clear').onclick = () => { state.selected.clear(); updateDock(); grid.updateItems(state.rows); };
  $('dk-open').onclick = () => [...state.selected].slice(0, 20).forEach(u => window.open(`https://instagram.com/${u}/`, '_blank', 'noopener'));
  $('dk-export').onclick = () => {
    const rows = state.rows.filter(p => state.selected.has(p.username));
    download(toCsv(rows), `selected-${Date.now()}.csv`);
  };
  $('dk-followed').onclick = async () => {
    await updateMany([...state.selected], { status: 'followed' });
    toast(`Marked ${state.selected.size} as followed`, 'success');
    state.selected.clear(); updateDock(); refresh(); refreshCounts();
  };
  $('dk-remove').onclick = async () => {
    await updateMany([...state.selected], { status: 'rejected', rejectedAt: Date.now() });
    toast(`Removed ${state.selected.size}`, 'success');
    state.selected.clear(); updateDock(); refresh(); refreshCounts();
  };

  // Data management
  $('btn-backup').onclick = async () => {
    const dump = {};
    for (const s of Object.values(STORES)) dump[s] = await db.getAll(s).catch(() => []);
    download(JSON.stringify({ version: 2, at: Date.now(), data: dump }, null, 2), `prospectfinder-backup-${Date.now()}.json`, 'application/json');
    toast('Backup downloaded', 'success');
  };
  $('btn-clear-rejected').onclick = async () => {
    if (!confirm('Permanently delete all removed prospects?')) return;
    const all = await db.getAll(STORES.PROSPECTS);
    const gone = all.filter(p => p.status === 'rejected');
    await db.write([STORES.PROSPECTS], async t => { for (const p of gone) await t.store(STORES.PROSPECTS).delete(p.username); });
    toast(`Deleted ${gone.length}`, 'success');
    refresh(); refreshCounts();
  };
  $('btn-wipe').onclick = async () => {
    if (!confirm('Delete ALL data? This cannot be undone.')) return;
    await db.clearAll();
    toast('All data deleted', 'success');
    refresh(); refreshCounts();
  };

  // Modals
  $('why-close').onclick = () => $('why-mask').classList.remove('show');
  document.querySelectorAll('.mask').forEach(m => m.onclick = e => { if (e.target === m) m.classList.remove('show'); });
  $('pal-input').addEventListener('input', e => renderPalette(e.target.value));
  $('pal-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { $('pal-list').querySelector('.pal-item')?.click(); }
    if (e.key === 'Escape') $('pal-mask').classList.remove('show');
  });

  // Keyboard
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
    if (e.key === 'Escape') document.querySelectorAll('.mask.show').forEach(m => m.classList.remove('show'));
    if (e.key === '/' && document.activeElement.tagName !== 'INPUT') { e.preventDefault(); $('search').focus(); }
  });

  onBroadcast(() => scheduleLive());

  await renderViews();
  await refreshCounts();
  await refresh();

  // Nudge the worker in case anything is queued from a previous session.
  pumpNow().catch(() => {});
}

init().catch(e => {
  console.error('[dashboard] init failed', e);
  document.body.insertAdjacentHTML('afterbegin', `<div style="padding:20px;color:#f87171">Dashboard failed to start: ${e.message}</div>`);
});
