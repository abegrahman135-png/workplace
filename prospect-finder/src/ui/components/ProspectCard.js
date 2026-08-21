/**
 * ProspectCard.js — Keyed card with PATCH-not-replace updates.
 * Every mutable element is cached on the node so live updates touch only
 * changed text, preserving focus, checkbox state and open panels.
 */

import { fmtNum } from '../../lib/utils.js';
import { LABEL } from '../../lib/constants.js';
import { ICON, iconLabel } from './icons.js';

/**
 * Object URLs for cached avatar blobs.
 *
 * Created lazily and reference-counted per username, because the grid is
 * virtualised: the same prospect can be attached to a recycled node many times
 * while scrolling, and minting a fresh blob URL each time would leak memory for
 * the life of the page.
 */
const objectUrls = new Map();          // username -> { url, refs }

export function avatarUrlFor(username, blob) {
  if (!username || !blob) return null;
  let e = objectUrls.get(username);
  if (!e) {
    e = { url: URL.createObjectURL(blob), refs: 0 };
    objectUrls.set(username, e);
  }
  e.refs++;
  return e.url;
}

/** Release every cached object URL — call on unload or a full data reset. */
export function releaseAvatarUrls() {
  for (const { url } of objectUrls.values()) URL.revokeObjectURL(url);
  objectUrls.clear();
}

/** Blobs handed in by the dashboard before a repaint. */
let avatarBlobs = new Map();
export function setAvatarBlobs(map) { avatarBlobs = map || new Map(); }

const LABEL_META = {
  [LABEL.HIGH]:      { txt: iconLabel('fire',  'High Priority'), cls: 'hot' },
  [LABEL.QUALIFIED]: { txt: iconLabel('check', 'Qualified'),     cls: 'ok' },
  [LABEL.REVIEW]:    { txt: iconLabel('eye',   'Review'),        cls: 'mid' },
  [LABEL.EXCLUDED]:  { txt: iconLabel('ban',   'Excluded'),      cls: '' },
  [LABEL.PENDING]:   { txt: iconLabel('clock', 'Queued'),        cls: 'pend' },
};

const VERDICT_TXT = {
  likely_female: iconLabel('female', 'Female'),
  likely_male:   iconLabel('male', 'Male'),
  ambiguous:     iconLabel('scale', 'Ambiguous'),
  unknown:       iconLabel('question', 'Unknown'),
};

/** Stable hue per username so an avatar keeps its colour across re-renders. */
function hueOf(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h % 360;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function scoreClass(p) {
  const s = p.finalScore;
  if (s == null) return '';
  if (s >= 70) return 'hot';
  if (s >= 45) return 'ok';
  if (s > 0) return 'mid';
  return '';
}

export function createCard(handlers) {
  const el = document.createElement('article');
  el.className = 'card';
  el.innerHTML = `
    <input type="checkbox" class="c-check" aria-label="Select prospect">
    <div class="c-top">
      <div class="avatar"><span class="ini"></span></div>
      <div class="c-id">
        <div class="c-name"></div>
        <div class="c-user"></div>
      </div>
    </div>
    <div class="c-score">—</div>
    <div class="c-badges"></div>
    <div class="c-metrics">
      <span title="Posts">${ICON.camera}<b class="m-p">0</b></span>
      <span title="Followers">${ICON.users}<b class="m-f">0</b></span>
      <span title="Following">${ICON.arrowR}<b class="m-g">0</b></span>
    </div>
    <div class="bars">
      <div class="bar"><i class="b-p"></i></div>
      <div class="bar f"><i class="b-f"></i></div>
      <div class="bar g"><i class="b-g"></i></div>
    </div>
    <div class="c-bio"></div>
    <div class="c-foot">
      <button class="why" type="button">${ICON.chevron}<span>Why?</span></button>
      <div class="c-actions">
        <button class="icobtn a-open" title="Open profile" aria-label="Open profile">${ICON.arrowOut}</button>
        <button class="icobtn a-boost" title="Boost to top" aria-label="Boost">${ICON.star}</button>
        <button class="icobtn a-remove" title="Remove" aria-label="Remove">${ICON.close}</button>
      </div>
    </div>`;

  // Cache mutable refs — no repeated querySelector on the hot path.
  el.$ = {
    check: el.querySelector('.c-check'),
    avatar: el.querySelector('.avatar'),
    ini: el.querySelector('.ini'),
    name: el.querySelector('.c-name'),
    user: el.querySelector('.c-user'),
    score: el.querySelector('.c-score'),
    badges: el.querySelector('.c-badges'),
    mp: el.querySelector('.m-p'),
    mf: el.querySelector('.m-f'),
    mg: el.querySelector('.m-g'),
    bp: el.querySelector('.b-p'),
    bf: el.querySelector('.b-f'),
    bg: el.querySelector('.b-g'),
    bio: el.querySelector('.c-bio'),
    why: el.querySelector('.why'),
    open: el.querySelector('.a-open'),
    boost: el.querySelector('.a-boost'),
    remove: el.querySelector('.a-remove'),
  };

  el.$.check.addEventListener('change', () => handlers.onSelect(el._u, el.$.check.checked));
  el.$.open.addEventListener('click', () => handlers.onOpen(el._u));
  el.$.boost.addEventListener('click', () => handlers.onBoost(el._u));
  el.$.remove.addEventListener('click', () => handlers.onRemove(el._u));
  el.$.why.addEventListener('click', () => handlers.onWhy(el._u));
  // Click the photo to inspect it full-size — the quickest manual override for
  // a profile the classifier could not decide.
  el.$.avatar.addEventListener('click', () => handlers.onAvatar?.(el._u));

  return el;
}

export function patchCard(el, p, selected) {
  const $ = el.$;
  el._u = p.username;

  const name = p.enriched?.full_name || p.raw?.full_name || p.username;
  if (el._name !== name) { $.name.textContent = name; el._name = name; }

  const user = '@' + p.username;
  if (el._user !== user) { $.user.textContent = user; el._user = user; }

  // ── Avatar ───────────────────────────────────────────────────────────────
  // Prefer locally cached BYTES over the harvested CDN URL. Instagram signs
  // those URLs with an expiry, so hotlinking one from a dashboard opened hours
  // later returns 403 and the card falls back to a bare initial — which is what
  // made the whole grid look letters-only.
  const blob = avatarBlobs.get(p.username);
  const netPic = p.enriched?.profile_pic_url || p.raw?.profile_pic_url || '';
  const initial = (name || '?').trim().charAt(0).toUpperCase() || '?';
  const src = blob ? avatarUrlFor(p.username, blob) : netPic;
  // Key on the resolved source AND the initial: recycled cards often share the
  // same (empty) pic, and keying on pic alone left the previous card's letter.
  const picKey = (blob ? 'blob:' + p.username : netPic) + '|' + initial;

  if (el._pic !== picKey) {
    el._pic = picKey;
    $.avatar.style.setProperty('--av-h', hueOf(p.username || name));
    $.avatar.innerHTML = '';
    if (src) {
      const img = document.createElement('img');
      img.referrerPolicy = 'no-referrer';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.alt = '';
      img.src = src;
      img.addEventListener('error', () => {
        // Expired URL or blocked request — degrade to the coloured initial.
        $.avatar.innerHTML = `<span class="ini">${esc(initial)}</span>`;
      }, { once: true });
      $.avatar.appendChild(img);
    } else {
      $.avatar.innerHTML = `<span class="ini">${esc(initial)}</span>`;
    }
  }

  const sc = scoreClass(p);
  const pendingScore = p.finalScore == null;
  const scoreTxt = pendingScore ? '' : String(p.finalScore);
  if (el._score !== scoreTxt + sc) {
    if (pendingScore) { $.score.innerHTML = ICON.clock; $.score.title = 'Not yet enriched'; }
    else { $.score.textContent = scoreTxt; $.score.title = ''; }
    $.score.className = `c-score ${sc}`;
    $.avatar.style.setProperty('--ring', sc === 'hot' ? 'var(--hot)' : sc === 'ok' ? 'var(--success)' : sc === 'mid' ? 'var(--warn)' : 'var(--line-2)');
    el._score = scoreTxt + sc;
  }

  // Badges
  const meta = LABEL_META[p.label] || LABEL_META[LABEL.PENDING];
  const verdict = p.evidence?.female?.verdict || 'unknown';
  const conf = Math.round((p.femaleConfidence || 0) * 100);
  const isPriv = p.enriched?.is_private ?? p.raw?.is_private;
  const bkey = `${p.label}|${verdict}|${conf}|${isPriv}|${p.accountType}|${p.manualPriority}|${p.stage}`;
  if (el._badges !== bkey) {
    el._badges = bkey;
    const parts = [];
    if (p.manualPriority) parts.push(`<span class="badge pend">${iconLabel('star', 'Boosted')}</span>`);
    parts.push(`<span class="badge ${meta.cls}">${meta.txt}</span>`);
    parts.push(`<span class="badge ${verdict === 'likely_female' ? 'ok' : verdict === 'likely_male' ? '' : 'mid'}">${VERDICT_TXT[verdict]} ${conf ? conf + '%' : ''}</span>`);
    parts.push(`<span class="badge ${isPriv ? 'info' : ''}">${isPriv ? iconLabel('lock', 'Private') : iconLabel('globe', 'Public')}</span>`);
    if (p.accountType && p.accountType !== 'Unknown') parts.push(`<span class="badge">${esc(p.accountType)}</span>`);
    if (p.stage === 'failed' || p.stage === 'dead') parts.push(`<span class="badge mid">${iconLabel('warn', 'Needs retry')}</span>`);
    $.badges.innerHTML = parts.join('');
  }

  // Metrics
  const m = p.metrics || {};
  const mk = `${m.posts}|${m.followers}|${m.following}`;
  if (el._metrics !== mk) {
    el._metrics = mk;
    $.mp.textContent = fmtNum(m.posts || 0);
    $.mf.textContent = fmtNum(m.followers || 0);
    $.mg.textContent = fmtNum(m.following || 0);
    const d = p.scored?.dims;
    if (d) {
      $.bp.style.width = `${Math.round((d.postCount.score / d.postCount.max) * 100)}%`;
      $.bf.style.width = `${Math.round((d.followersQuality.score / d.followersQuality.max) * 100)}%`;
      $.bg.style.width = `${Math.round((d.followingQuality.score / d.followingQuality.max) * 100)}%`;
    } else {
      $.bp.style.width = $.bf.style.width = $.bg.style.width = '0%';
    }
  }

  // Bio
  const bio = p.enriched?.biography || '';
  if (el._bio !== bio) { $.bio.textContent = bio; el._bio = bio; }

  // Selection / state classes — never re-create the checkbox.
  if ($.check.checked !== selected) $.check.checked = selected;
  el.classList.toggle('sel', selected);
  el.classList.toggle('rejected', p.status === 'rejected');
  $.boost.style.color = p.manualPriority ? 'var(--warn)' : '';
}
