/**
 * dashboard.js — Instagram Prospect Finder Dashboard
 * Features: advanced filters, reject/restore, clear all, new sort options,
 *           followers/following quality display, manual priority boost
 */

import { db } from './db/schema.js';
import { scoreProspect, compareProspects } from './engines/scoring.js';
import { DEFAULT_SETTINGS, SETTINGS_CHANNEL } from './lib/constants.js';

// ─── Pagination ───────────────────────────────────────────────────────────────
const PAGE_SIZE = 50;

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  prospects:    [],
  sessions:     [],
  filtered:     [],
  filters: {
    search:          '',
    privacy:         'all', // 'all', 'private', 'public'
    minPosts:        0,
    minFollowers:    0,
    maxFollowers:    null,
    minFemale:       0,
    hideTaken:       false,
    excludeKeywords: '',
  },
  sortBy:       'priority',
  selectedTab:  'results',
  priorityTab:  'all',        // Bug 1 fix: was 'high_priority'
  chosen:       new Set(),
  settings:     { ...DEFAULT_SETTINGS },
  activeSession: null,
  pollTimer:    null,
  page:         0,            // Pagination: current page index (0-based)
};

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const el = {
  grid:              document.getElementById('results-grid'),
  emptyState:        document.getElementById('empty-state'),
  drawer:            document.getElementById('selection-drawer'),
  drawerCount:       document.getElementById('drawer-count'),
  liveBanner:        document.getElementById('live-banner'),
  liveBannerText:    document.getElementById('live-banner-text'),
  liveProgress:      document.getElementById('live-progress-fill'),
  sessionsList:      document.getElementById('sessions-list'),
  sessionsEmpty:     document.getElementById('sessions-empty'),
  toastContainer:    document.getElementById('toast-container'),
  weightSliders:     document.getElementById('weight-sliders'),
  statScanned:       document.getElementById('stat-scanned'),
  statFemale:        document.getElementById('stat-female'),
  statPosts:         document.getElementById('stat-posts'),
  statHigh:          document.getElementById('stat-high'),
  statSelected:      document.getElementById('stat-selected'),
  statEnriched:      document.getElementById('stat-enriched'),
  statRemoved:       document.getElementById('stat-removed'),
  countAll:          document.getElementById('count-all'),
  countHigh:         document.getElementById('count-high'),
  countQualified:    document.getElementById('count-qualified'),
  countReview:       document.getElementById('count-review'),
  countExcluded:     document.getElementById('count-excluded'),
  countRejected:     document.getElementById('count-rejected'),
  sourceLabel:       document.getElementById('stat-source-label'),
  loadMoreContainer: document.getElementById('load-more-container'),
  loadMoreBtn:       document.getElementById('btn-load-more'),
};

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  try { await db.open(); } catch (e) {
    showToast('Database unavailable — prospects will not persist.', 'error');
  }
  await loadSettings();
  // Bug 2 fix: clearOldData() removed from init — users can clear manually via "Clear All"
  await loadData();
  bindEvents();
  renderWeightSliders();
  populateSettingsForm();
  startPolling();
}

// ─── Clear old-algorithm data on startup ─────────────────────────────────────
// User confirmed: wipe old data scored with femaleScore-as-finalScore algorithm.
// Old records have breakdown.femaleLikelihood or breakdown.privateAccount (old dims).
async function clearOldData() {
  try {
    const all = await db.prospects.getAll();
    const oldRecords = all.filter(p =>
      p.scored?.breakdown?.femaleLikelihood !== undefined ||
      p.scored?.breakdown?.privateAccount  !== undefined ||
      // Also catch prospects where finalScore == femaleScore (the bug)
      (p.finalScore > 0 && p.finalScore === p.femaleScore && !p.scored?.breakdown?.postCount)
    );
    if (oldRecords.length === 0) return;

    for (const p of oldRecords) {
      await db.prospects.update(p.username, { status: 'deleted' });
    }
    showToast(`Cleared ${oldRecords.length} old records — please re-scan with new algorithm.`, 'success');
  } catch (e) {
    console.warn('[dashboard] clearOldData error', e);
  }
}

// ─── Data Loading ─────────────────────────────────────────────────────────────
async function loadData() {
  try {
    const all = await db.prospects.getAll();
    // Exclude permanently deleted records
    state.prospects = all.filter(p => p.status !== 'deleted');
    state.sessions  = await db.sessions.all();
    state.activeSession = state.sessions
      .filter(s => s.status === 'running')
      .sort((a, b) => b.createdAt - a.createdAt)[0] || null;
    applyFilters();
    updateStats();
    updateLiveBanner();
    renderSessions();
  } catch (e) { console.error('[dashboard] loadData error', e); }
}

async function loadSettings() {
  try {
    const all = await db.settings.all();
    all.forEach(({ key, value }) => {
      if (key === 'userSettings') Object.assign(state.settings, value);
    });
  } catch (_) {}
}

function prospectTab(p) {
  if (p.status === 'rejected') return 'rejected';
  if (p.manualPriority)        return 'high_priority';

  // Un-enriched prospects wait in 'review'
  if (!p.scored || p.enrichmentStatus === 'pending') {
    return 'review';
  }

  // Scored prospects: rank strictly by finalScore (posts + followers + following)
  const score = p.finalScore ?? p.scored?.finalScore ?? 0;
  if (score >= 70) return 'high_priority';
  if (score >= 45) return 'qualified';
  if (score > 0)   return 'review';
  return 'excluded';
}

// ─── Filtering & Sorting ──────────────────────────────────────────────────────
function applyFilters() {
  const { search, privacy, minPosts, minFollowers, maxFollowers, minFemale, hideTaken, excludeKeywords } = state.filters;

  const totalScanned = state.prospects.filter(p => p.status !== 'rejected').length;

  state.filtered = state.prospects.filter(p => {
    // 1. Tab filter ('all' shows everything except 'rejected' unless viewing rejected tab)
    const tab = prospectTab(p);
    if (state.priorityTab === 'all') {
      if (p.status === 'rejected') return false;
    } else {
      if (tab !== state.priorityTab) return false;
    }

    // 2. Live Search query (name, username, bio)
    if (search) {
      const q = search.toLowerCase();
      const u = (p.username || '').toLowerCase();
      const fn = (p.raw?.full_name || '').toLowerCase();
      const bio = (p.enriched?.biography || '').toLowerCase();
      if (!u.includes(q) && !fn.includes(q) && !bio.includes(q)) return false;
    }

    // 3. Privacy filter
    const isPrivate = Boolean(p.enriched?.is_private ?? p.raw?.is_private);
    if (privacy === 'private' && !isPrivate) return false;
    if (privacy === 'public' && isPrivate) return false;

    // 4. Min posts
    const postCount = p.enriched?.post_count ?? p.raw?.media_count ?? 0;
    if (minPosts > 0 && postCount < minPosts) return false;

    // 5. Min / Max followers
    const follCount = p.enriched?.follower_count ?? p.raw?.follower_count ?? 0;
    if (minFollowers > 0 && follCount < minFollowers) return false;
    if (maxFollowers && maxFollowers > 0 && follCount > maxFollowers) return false;

    // 6. Female score
    if (minFemale > 0 && (p.femaleScore || 0) < minFemale) return false;

    // 7. Hide Taken / Married filter
    const bioText = (p.enriched?.biography || '').toLowerCase();
    if (hideTaken) {
      const takenMarkers = ['💍', 'engaged', 'married', 'taken', 'wifey', 'wife of', 'hubby', 'husband', 'mom of', 'mama of'];
      if (takenMarkers.some(m => bioText.includes(m))) return false;
    }

    // 8. Exclude custom negative keywords
    if (excludeKeywords) {
      const badWords = excludeKeywords.toLowerCase().split(',').map(w => w.trim()).filter(Boolean);
      if (badWords.some(w => bioText.includes(w))) return false;
    }

    return true;
  });

  // Sort
  if (state.sortBy === 'priority')       state.filtered.sort(compareProspects);
  else if (state.sortBy === 'posts')     state.filtered.sort((a, b) => (b.enriched?.post_count || 0) - (a.enriched?.post_count || 0));
  else if (state.sortBy === 'followers') state.filtered.sort((a, b) => (b.enriched?.follower_count || 0) - (a.enriched?.follower_count || 0));
  else if (state.sortBy === 'following') state.filtered.sort((a, b) => (b.enriched?.following_count || 0) - (a.enriched?.following_count || 0));
  else if (state.sortBy === 'female')    state.filtered.sort((a, b) => (b.femaleScore || 0) - (a.femaleScore || 0));
  else if (state.sortBy === 'newest')    state.filtered.sort((a, b) => b.firstSeenAt - a.firstSeenAt);
  else if (state.sortBy === 'oldest')    state.filtered.sort((a, b) => a.firstSeenAt - b.firstSeenAt);

  // Bug 3 fix / Pagination: reset to first page on every new filter/sort
  state.page = 0;

  renderActiveFilterChips(totalScanned);
  renderList();
}

function renderActiveFilterChips(totalScanned) {
  const summaryEl = document.getElementById('results-count-summary');
  const chipsEl = document.getElementById('active-chips');
  const barEl = document.getElementById('active-filters-bar');
  if (!summaryEl || !chipsEl || !barEl) return;

  const chips = [];
  const { search, privacy, minPosts, minFollowers, maxFollowers, minFemale, hideTaken, excludeKeywords } = state.filters;

  if (search) chips.push({ label: `🔍 "${search}"`, clear: () => { state.filters.search = ''; setVal('filter-search', ''); } });
  if (privacy !== 'all') chips.push({ label: privacy === 'private' ? '🔒 Private only' : '🌐 Public only', clear: () => setPrivacySegment('all') });
  if (minPosts > 0) chips.push({ label: `📸 ≥ ${minPosts} posts`, clear: () => { state.filters.minPosts = 0; setVal('filter-min-posts', ''); } });
  if (minFollowers > 0 || (maxFollowers && maxFollowers > 0)) {
    chips.push({ label: `👥 ${minFollowers || 0}–${maxFollowers || '∞'} followers`, clear: () => { state.filters.minFollowers = 0; state.filters.maxFollowers = null; setVal('filter-min-followers', ''); setVal('filter-max-followers', ''); } });
  }
  if (minFemale > 0) chips.push({ label: `♀ ≥ ${minFemale}%`, clear: () => { state.filters.minFemale = 0; setVal('filter-female-score', ''); } });
  if (hideTaken) chips.push({ label: '💍 Single / Not Taken', clear: () => { state.filters.hideTaken = false; setChecked('filter-hide-taken-chk', false); } });
  if (excludeKeywords) chips.push({ label: `🚫 Excl: ${excludeKeywords}`, clear: () => { state.filters.excludeKeywords = ''; setVal('filter-exclude-keywords', ''); } });

  summaryEl.textContent = `Showing ${state.filtered.length} of ${totalScanned} prospects`;

  chipsEl.innerHTML = '';
  chips.forEach(({ label, clear }) => {
    const span = document.createElement('span');
    span.className = 'filter-chip';
    span.innerHTML = `${label} <span class="chip-remove">✕</span>`;
    span.querySelector('.chip-remove')?.addEventListener('click', () => {
      clear();
      applyFilters();
    });
    chipsEl.appendChild(span);
  });

  barEl.style.display = (chips.length > 0 || state.filtered.length !== totalScanned) ? 'flex' : 'none';
}

function setPrivacySegment(val) {
  state.filters.privacy = val;
  setVal('filter-privacy', val);
  document.querySelectorAll('#seg-privacy .segmented-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.val === val);
  });
  applyFilters();
}

// ─── Stats ────────────────────────────────────────────────────────────────────
function updateStats() {
  const active = state.prospects.filter(p => p.status !== 'rejected');

  // Bug 5 fix: stat-scanned = sum of stats.scanned across all sessions
  const totalScanned = state.sessions.reduce((sum, s) => sum + (s.stats?.scanned || 0), 0);

  setText(el.statScanned,  totalScanned);
  // Bug 5 fix: stat-female = prospects with femaleScore >= 70
  setText(el.statFemale,   active.filter(p => (p.femaleScore || 0) >= 70).length);
  // Bug 5 fix: stat-posts = prospects with enriched.post_count >= 20
  setText(el.statPosts,    active.filter(p => (p.enriched?.post_count || 0) >= 20).length);
  setText(el.statHigh,     active.filter(p => prospectTab(p) === 'high_priority').length);
  setText(el.statSelected, state.chosen.size);
  setText(el.statEnriched, active.filter(p => p.enrichmentStatus === 'enriched').length);
  // Bug 5 fix: stat-removed = prospects where status === 'rejected'
  setText(el.statRemoved,  state.prospects.filter(p => p.status === 'rejected').length);

  setText(el.countAll,      active.length);
  setText(el.countHigh,     active.filter(p => prospectTab(p) === 'high_priority').length);
  setText(el.countQualified,active.filter(p => prospectTab(p) === 'qualified').length);
  setText(el.countReview,   active.filter(p => prospectTab(p) === 'review').length);
  setText(el.countExcluded, active.filter(p => prospectTab(p) === 'excluded').length);
  setText(el.countRejected, state.prospects.filter(p => p.status === 'rejected').length);

  if (state.activeSession?.sourceUsername && el.sourceLabel) {
    el.sourceLabel.textContent = `@${state.activeSession.sourceUsername}`;
  }
}

// ─── Live Banner ──────────────────────────────────────────────────────────────
function updateLiveBanner() {
  if (!el.liveBanner) return;
  const active = state.activeSession;
  el.liveBanner.style.display = active ? 'flex' : 'none';
  if (active) {
    // Bug 4 fix: was active.stats?.processed — sessions store stats.scanned
    const scanned = active.stats?.scanned || 0;
    setText(el.liveBannerText, `Scanning @${active.sourceUsername || '…'} — ${scanned.toLocaleString()} found`);
  }
}

// ─── Card Rendering ───────────────────────────────────────────────────────────
function renderList() {
  if (!el.grid) return;
  if (!state.filtered.length) {
    el.grid.innerHTML = '';
    if (el.emptyState) el.emptyState.style.display = 'flex';
    if (el.loadMoreContainer) el.loadMoreContainer.style.display = 'none';
    return;
  }
  if (el.emptyState) el.emptyState.style.display = 'none';

  // Bug 3 fix: show only first (page+1)*PAGE_SIZE items
  const visibleCount = (state.page + 1) * PAGE_SIZE;
  const toShow = state.filtered.slice(0, visibleCount);

  el.grid.innerHTML = '';
  const frag = document.createDocumentFragment();
  toShow.forEach(p => frag.appendChild(buildCard(p)));
  el.grid.appendChild(frag);

  // Show/hide load more button
  const hasMore = state.filtered.length > visibleCount;
  if (el.loadMoreContainer) {
    el.loadMoreContainer.style.display = hasMore ? 'block' : 'none';
    if (el.loadMoreBtn) {
      const remaining = state.filtered.length - visibleCount;
      el.loadMoreBtn.textContent = `Load ${Math.min(PAGE_SIZE, remaining)} more (${remaining} remaining)`;
    }
  }
}

function buildCard(p) {
  const username   = p.username || p.raw?.username || '?';
  const fullName   = p.raw?.full_name || '';
  const femaleScore = p.femaleScore || 0;
  const finalScore  = p.finalScore || 0;
  const tab         = prospectTab(p);
  const isPrivate   = p.raw?.is_private;
  const isVerified  = p.raw?.is_verified;
  const bio         = p.enriched?.biography || '';
  const posts       = p.enriched?.post_count || 0;
  const followers   = p.enriched?.follower_count || p.raw?.follower_count || 0;
  const following   = p.enriched?.following_count || p.raw?.following_count || 0;
  const accountType = p.accountType || 'Personal';
  const breakdown   = p.scored?.breakdown || {};
  const reasons     = p.scored?.explainReasons || [];
  const chosen      = state.chosen.has(username);
  const isRejected  = p.status === 'rejected';
  const isManualPri = p.manualPriority === true;

  const isPending = p.enrichmentStatus === 'pending' || !p.scored;
  const scoreClass = tab === 'high_priority' ? 'hot'
                   : tab === 'qualified'     ? 'success'
                   : tab === 'review'        ? 'warning'
                   : tab === 'rejected'      ? 'muted'
                   : 'muted';

  const labelText = isManualPri ? '⭐ Priority'
                  : isPending   ? '⏳ Enriching...'
                  : tab === 'high_priority' ? '🔥 High Priority'
                  : tab === 'qualified'     ? '✅ Qualified'
                  : tab === 'review'        ? '👁 Review'
                  : tab === 'rejected'      ? '🚫 Removed'
                  : '⛔ Excluded';

  const follQuality   = breakdown.followersQuality;
  const follingQuality = breakdown.followingQuality;

  const picUrl = p.enriched?.profile_pic_url || p.raw?.profile_pic_url;
  const initial = (fullName || username).charAt(0).toUpperCase();
  const avatarHtml = picUrl
    ? `<div class="avatar ${scoreClass}" style="overflow:hidden;"><img src="${esc(picUrl)}" alt="" referrerpolicy="no-referrer" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" /></div>`
    : `<div class="avatar ${scoreClass}">${initial}</div>`;

  const article = document.createElement('article');
  article.className = `prospect-card${chosen ? ' chosen' : ''}${isRejected ? ' rejected' : ''}`;
  article.setAttribute('data-username', username);

  const displayScore = isPending ? '⏳' : Math.round(finalScore);
  const bioLower = (bio || '').toLowerCase();
  const takenMarkers = ['💍', 'engaged', 'married', 'taken', 'wifey', 'wife of', 'hubby', 'husband', 'mom of', 'mama of'];
  const isTaken = takenMarkers.some(m => bioLower.includes(m));

  article.innerHTML = `
    <input type="checkbox" class="card-check" aria-label="Select @${username}" ${chosen ? 'checked' : ''}>
    <div class="card-top">
      ${avatarHtml}
      <div class="card-identity">
        <div class="full-name">${esc(fullName || username)} ${isManualPri ? '⭐' : ''}</div>
        <div class="username">@${esc(username)}</div>
      </div>
      <div class="score-badge ${scoreClass}">${displayScore}</div>
    </div>

    <div class="badges">
      <span class="badge badge-${scoreClass}">${labelText}</span>
      <span class="badge badge-female">♀ ${femaleScore}%</span>
      ${posts     ? `<span class="badge badge-neutral">📸 ${posts.toLocaleString()} posts</span>` : ''}
      ${followers ? `<span class="badge badge-neutral">👥 ${fmtNum(followers)} followers${follQuality ? ` · ${follQuality.tier}` : ''}</span>` : ''}
      ${following ? `<span class="badge badge-neutral">➡️ ${fmtNum(following)} following${follingQuality ? ` · ${follingQuality.tier}` : ''}</span>` : ''}
      ${isPrivate  ? '<span class="badge badge-info">🔒 Private</span>' : '<span class="badge badge-neutral">🌐 Public</span>'}
      ${isTaken    ? '<span class="badge badge-warning">💍 Taken / Engaged</span>' : ''}
      ${isVerified ? '<span class="badge badge-warning">✓ Verified</span>' : ''}
      <span class="badge badge-neutral">${esc(accountType)}</span>
    </div>

    ${bio ? `<div class="card-bio">${esc(bio)}</div>` : ''}

    ${reasons.length ? `
    <details class="card-why">
      <summary>▸ Why ranked — ${Math.round(finalScore)} pts</summary>
      <div class="signal-list">
        ${Object.entries(breakdown).map(([k, v]) => {
          const pct = v.max > 0 ? Math.round((v.score / v.max) * 100) : 0;
          return `<div class="signal-row">
            <span class="signal-label">${formatDimLabel(k)}</span>
            <div class="signal-bar"><div class="signal-bar-fill" style="width:${pct}%"></div></div>
            <span class="signal-val">${Math.round(v.score)}/${v.max}</span>
          </div>`;
        }).join('')}
        <div class="reason-list">${reasons.map(r => `<span class="reason-tag">✓ ${esc(r)}</span>`).join('')}</div>
      </div>
    </details>` : ''}

    <div class="card-actions">
      ${isRejected
        ? `<button class="btn btn-sm btn-restore" data-u="${username}">↩ Restore</button>`
        : `
          <button class="btn btn-sm btn-open"    data-u="${username}">Open Profile</button>
          <button class="btn btn-sm btn-select"  data-u="${username}">${chosen ? 'Deselect' : 'Select'}</button>
          <button class="btn btn-sm btn-boost"   data-u="${username}" title="Boost to High Priority">${isManualPri ? '⭐ Boosted' : '⭐ Boost'}</button>
          <button class="btn btn-sm btn-remove"  data-u="${username}" title="Remove from list">✕ Remove</button>
        `
      }
    </div>`;

  // Handle avatar fallback cleanly without inline event handlers (CSP compliance)
  const avatarEl = article.querySelector('.avatar');
  const imgEl = avatarEl?.querySelector('img');
  if (imgEl) {
    imgEl.addEventListener('error', () => {
      avatarEl.textContent = initial;
    });
  }

  // Events
  article.querySelector('.card-check')?.addEventListener('change', e => {
    toggleChosen(username, e.target.checked);
  });
  if (isRejected) {
    article.querySelector('.btn-restore')?.addEventListener('click', () => restoreProspect(username));
  } else {
    article.querySelector('.btn-open')?.addEventListener('click', () =>
      window.open(`https://www.instagram.com/${username}/`, '_blank'));
    article.querySelector('.btn-select')?.addEventListener('click', () => {
      toggleChosen(username, !state.chosen.has(username)); renderList();
    });
    article.querySelector('.btn-boost')?.addEventListener('click', () => boostPriority(username, !p.manualPriority));
    article.querySelector('.btn-remove')?.addEventListener('click', () => removeProspect(username));
  }

  return article;
}

function formatDimLabel(key) {
  return {
    femaleLikelihood: 'Female',
    postCount:        'Posts',
    privateAccount:   'Private',
    followersQuality: 'Followers',
    followingQuality: 'Following',
    recentActivity:   'Activity',
    personalAccount:  'Personal',
    audienceRelevance:'Audience',
    sourceOverlap:    'Sources',
  }[key] || key;
}

// ─── Prospect Actions ─────────────────────────────────────────────────────────
async function removeProspect(username) {
  try {
    await db.prospects.update(username, { status: 'rejected', rejectedAt: Date.now() });
    state.chosen.delete(username);
    await loadData();
    showToast(`@${username} removed.`);
  } catch (e) { showToast('Could not remove.', 'error'); }
}

async function restoreProspect(username) {
  try {
    await db.prospects.update(username, { status: 'new', rejectedAt: null });
    await loadData();
    showToast(`@${username} restored.`);
  } catch (e) { showToast('Could not restore.', 'error'); }
}

async function boostPriority(username, boost) {
  try {
    await db.prospects.update(username, { manualPriority: boost });
    await loadData();
    showToast(boost ? `@${username} boosted to High Priority ⭐` : `@${username} unboosted.`);
  } catch (e) { showToast('Could not boost.', 'error'); }
}

async function markStatus(username, status) {
  try {
    await db.prospects.update(username, { status, lastSeenAt: Date.now() });
    await loadData();
    showToast(`Marked @${username} as ${status}.`);
  } catch (e) { showToast('Could not update status.', 'error'); }
}

// ─── Clear Functions ──────────────────────────────────────────────────────────
async function clearAllProspects() {
  if (!confirm('Delete ALL prospect data? This cannot be undone.')) return;
  try {
    const all = await db.prospects.getAll();
    for (const p of all) await db.prospects.update(p.username, { status: 'deleted' });
    state.chosen.clear();
    await loadData();
    showToast('All prospects cleared.', 'success');
  } catch (e) { showToast('Error clearing data.', 'error'); }
}

async function clearRejected() {
  if (!confirm('Permanently delete all removed profiles?')) return;
  try {
    const rejected = state.prospects.filter(p => p.status === 'rejected');
    for (const p of rejected) await db.prospects.update(p.username, { status: 'deleted' });
    await loadData();
    showToast(`Cleared ${rejected.length} removed profiles.`, 'success');
  } catch (e) { showToast('Error.', 'error'); }
}

function resetFilters() {
  state.filters = {
    search:          '',
    privacy:         'all',
    minPosts:        0,
    minFollowers:    0,
    maxFollowers:    null,
    minFemale:       0,
    hideTaken:       false,
    excludeKeywords: '',
  };
  setVal('filter-search', '');
  setPrivacySegment('all');
  setVal('filter-min-posts', '');
  setVal('filter-min-followers', '');
  setVal('filter-max-followers', '');
  setVal('filter-female-score', '');
  setVal('filter-exclude-keywords', '');
  setChecked('filter-hide-taken-chk', false);
  document.querySelectorAll('.preset-pill').forEach(p => p.classList.remove('active'));
  applyFilters();
  showToast('Filters reset.');
}

// ─── Sessions Panel ───────────────────────────────────────────────────────────
function renderSessions() {
  if (!el.sessionsList) return;
  const sorted = [...state.sessions].sort((a, b) => b.createdAt - a.createdAt);
  if (!sorted.length) {
    el.sessionsList.innerHTML = '';
    if (el.sessionsEmpty) el.sessionsEmpty.style.display = 'flex';
    return;
  }
  if (el.sessionsEmpty) el.sessionsEmpty.style.display = 'none';
  el.sessionsList.innerHTML = sorted.map(s => `
    <div class="session-card">
      <div class="session-info">
        <div class="source">@${esc(s.sourceUsername || '?')}</div>
        <div class="meta">
          ${new Date(s.createdAt).toLocaleString()} ·
          ${(s.stats?.scanned || 0).toLocaleString()} scanned ·
          ${(s.stats?.highPriority || 0).toLocaleString()} high priority
        </div>
      </div>
      <span class="session-status ${s.status}">${s.status}</span>
    </div>`).join('');
}

// ─── Settings Panel ───────────────────────────────────────────────────────────
const WEIGHT_LABELS = {
  postCount:        '📸 Post Count — MAIN PRIORITY (max 60 pts)',
  followersQuality: '👥 Followers Quality (max 25 pts)',
  followingQuality: '➡️ Following Quality (max 15 pts)',
};

function renderWeightSliders() {
  if (!el.weightSliders) return;
  el.weightSliders.innerHTML = Object.entries(state.settings.weights || {}).map(([key, val]) => `
    <div class="weight-slider-row">
      <span>${WEIGHT_LABELS[key] || key}</span>
      <input type="range" min="0" max="50" value="${val}" id="weight-${key}" data-weight="${key}">
      <span class="weight-val" id="weight-val-${key}">${val}</span>
    </div>`).join('');

  el.weightSliders.querySelectorAll('input[type="range"]').forEach(input => {
    input.addEventListener('input', e => {
      const k = e.target.dataset.weight;
      state.settings.weights[k] = Number(e.target.value);
      setText(document.getElementById(`weight-val-${k}`), e.target.value);
    });
  });
}

function populateSettingsForm() {
  const s = state.settings;
  setVal('set-min-female',      s.minFemaleScore);
  setVal('set-min-posts',       s.minPosts);
  setVal('set-min-followers',   s.minFollowers ?? 100);
  setVal('set-min-following',   s.minFollowing ?? 50);
  setVal('set-max-followers',   s.maxFollowers ?? '');
  setVal('set-max-following',   s.maxFollowing ?? '');
  setVal('set-scrape-delay',    s.scrapeDelayMs);
  setVal('set-max-profiles',    s.maxProfilesPerSession);
  setChecked('set-exclude-verified', s.excludeVerified);
  setChecked('set-exclude-business', s.excludeBusinesses);
  setChecked('set-prefer-private',   s.preferPrivate);
}

function collectSettings() {
  return {
    ...state.settings,
    minFemaleScore:        numVal('set-min-female', 50),
    minPosts:              numVal('set-min-posts', 20),
    minFollowers:          numVal('set-min-followers', 0),
    minFollowing:          numVal('set-min-following', 0),
    maxFollowers:          numValOrNull('set-max-followers'),
    maxFollowing:          numValOrNull('set-max-following'),
    scrapeDelayMs:         numVal('set-scrape-delay', 2200),
    maxProfilesPerSession: numVal('set-max-profiles', 1000),
    excludeVerified:       boolVal('set-exclude-verified'),
    excludeBusinesses:     boolVal('set-exclude-business'),
    preferPrivate:         boolVal('set-prefer-private'),
  };
}

async function saveSettings() {
  state.settings = collectSettings();
  try {
    await db.settings.put({ key: 'userSettings', value: state.settings });
    if (typeof BroadcastChannel !== 'undefined') {
      new BroadcastChannel('settings-sync').postMessage({ type: 'SETTINGS_UPDATED', settings: state.settings });
    }
    renderWeightSliders();
    showToast('Settings saved ✓', 'success');
  } catch (e) { showToast('Failed to save settings.', 'error'); }
}

// ─── CSV Export ───────────────────────────────────────────────────────────────
function exportCsv(prospects) {
  const headers = [
    'Username','Full Name','Female Score','Confidence','Final Score','Priority',
    'Posts','Followers','Follower Tier','Following','Following Tier',
    'Private','Verified','Account Type','Activity Level',
    'Bio','Is Mutual','Source Profiles','First Seen','Last Seen','Status'
  ];
  const rows = prospects.map(p => {
    const bd = p.scored?.breakdown || {};
    return [
      p.username,
      p.raw?.full_name || '',
      p.femaleScore || '',
      p.classification?.confidence || '',
      p.finalScore || '',
      p.scored?.priorityLabel || p.classification?.label || '',
      p.enriched?.post_count || '',
      p.enriched?.follower_count || '',
      bd.followersQuality?.tier || '',
      p.enriched?.following_count || '',
      bd.followingQuality?.tier || '',
      p.raw?.is_private ? 'Yes' : 'No',
      p.raw?.is_verified ? 'Yes' : 'No',
      p.accountType || '',
      bd.recentActivity?.activityLevel || '',
      (p.enriched?.biography || '').replace(/\n/g,' ').replace(/,/g,';'),
      p.raw?.follows_viewer ? 'Yes' : 'No',
      (p.sourceUsernames || []).join(';'),
      p.firstSeenAt ? new Date(p.firstSeenAt).toISOString() : '',
      p.lastSeenAt  ? new Date(p.lastSeenAt).toISOString()  : '',
      p.status || 'new',
    ].map(v => `"${String(v).replace(/"/g,'""')}"`);
  });
  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
  downloadText(csv, 'prospects.csv', 'text/csv');
}

// ─── Selection Management ─────────────────────────────────────────────────────
function toggleChosen(username, on) {
  on ? state.chosen.add(username) : state.chosen.delete(username);
  updateStats();
  updateDrawer();
}

function updateDrawer() {
  setText(el.drawerCount, state.chosen.size);
  if (state.chosen.size > 0) el.drawer?.classList.add('visible');
  else el.drawer?.classList.remove('visible');
}

// ─── Polling ──────────────────────────────────────────────────────────────────
function startPolling() {
  // Bug fix: poll every 3000ms (was 5000ms)
  state.pollTimer = setInterval(async () => {
    if (state.activeSession) await loadData();
  }, 3000);

  if (typeof BroadcastChannel !== 'undefined') {
    const bc = new BroadcastChannel(SETTINGS_CHANNEL);
    bc.onmessage = () => loadSettings();
  }
}

// ─── Events ───────────────────────────────────────────────────────────────────
function bindEvents() {
  // Nav tabs
  document.querySelectorAll('.nav-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`panel-${tab.dataset.tab}`)?.classList.add('active');
      state.selectedTab = tab.dataset.tab;
    });
  });

  // Priority tabs — reset pagination on tab switch
  document.querySelectorAll('.priority-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.priority-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      state.priorityTab = tab.dataset.priority;
      state.page = 0;
      applyFilters();
    });
  });

  // Live search as user types
  document.getElementById('filter-search')?.addEventListener('input', e => {
    state.filters.search = e.target.value.trim();
    applyFilters();
  });

  // Segmented privacy buttons
  document.querySelectorAll('#seg-privacy .segmented-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setPrivacySegment(btn.dataset.val);
    });
  });

  // Live updates on all filter inputs
  ['filter-min-posts', 'filter-min-followers', 'filter-max-followers', 'filter-female-score', 'filter-exclude-keywords'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', () => {
      state.filters.minPosts        = numVal('filter-min-posts', 0);
      state.filters.minFollowers    = numVal('filter-min-followers', 0);
      state.filters.maxFollowers    = numValOrNull('filter-max-followers');
      state.filters.minFemale       = numVal('filter-female-score', 0);
      state.filters.excludeKeywords = getVal('filter-exclude-keywords').trim();
      applyFilters();
    });
  });

  // Hide taken checkbox toggle
  document.getElementById('filter-hide-taken-chk')?.addEventListener('change', e => {
    state.filters.hideTaken = Boolean(e.target.checked);
    applyFilters();
  });

  // Quick preset: Private + Active (50+ Posts)
  document.getElementById('preset-private-active')?.addEventListener('click', () => {
    setPrivacySegment('private');
    setVal('filter-min-posts', 50);
    state.filters.minPosts = 50;
    document.getElementById('preset-private-active')?.classList.toggle('active');
    applyFilters();
    showToast('Applied: 🔒 Private + 50+ Posts');
  });

  // Quick preset: 100-2K Followers Sweetspot
  document.getElementById('preset-sweetspot')?.addEventListener('click', () => {
    setVal('filter-min-followers', 100);
    setVal('filter-max-followers', 2000);
    state.filters.minFollowers = 100;
    state.filters.maxFollowers = 2000;
    document.getElementById('preset-sweetspot')?.classList.toggle('active');
    applyFilters();
    showToast('Applied: 👥 100-2K Followers Sweetspot');
  });

  // Quick preset: Hide Taken / Married
  document.getElementById('preset-hide-taken')?.addEventListener('click', () => {
    const chk = document.getElementById('filter-hide-taken-chk');
    if (chk) chk.checked = !chk.checked;
    state.filters.hideTaken = Boolean(chk?.checked);
    document.getElementById('preset-hide-taken')?.classList.toggle('active', state.filters.hideTaken);
    applyFilters();
    showToast(state.filters.hideTaken ? 'Applied: 💍 Hiding Taken/Married' : 'Showing all relationships');
  });

  // Preset: Reset All
  document.getElementById('preset-all-reset')?.addEventListener('click', resetFilters);

  document.getElementById('sort-select')?.addEventListener('change', e => {
    state.sortBy = e.target.value;
    applyFilters();
  });

  // Load more (pagination)
  document.getElementById('btn-load-more')?.addEventListener('click', () => {
    state.page++;
    renderList();
  });

  // Select all high
  document.getElementById('btn-select-all-high')?.addEventListener('click', () => {
    state.prospects
      .filter(p => prospectTab(p) === 'high_priority')
      .forEach(p => state.chosen.add(p.username));
    updateStats(); updateDrawer(); renderList();
  });

  // Export
  document.getElementById('btn-export-csv')?.addEventListener('click', () => {
    if (!state.prospects.length) return showToast('No prospects to export.');
    exportCsv(state.filtered.length ? state.filtered : state.prospects);
    showToast('CSV export started ✓');
  });

  // Clear all / clear rejected
  document.getElementById('btn-clear-all-data')?.addEventListener('click', clearAllProspects);
  document.getElementById('btn-clear-rejected')?.addEventListener('click', clearRejected);

  // Live banner
  document.getElementById('btn-pause-scan')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'PAUSE_DIG' });
    showToast('Pausing scan…');
  });
  document.getElementById('btn-stop-scan')?.addEventListener('click', () => {
    if (confirm('Stop the current scan?')) chrome.runtime.sendMessage({ type: 'STOP_DIG' });
  });

  // Drawer
  document.getElementById('btn-drawer-clear')?.addEventListener('click', () => {
    state.chosen.clear(); updateStats(); updateDrawer(); renderList();
  });
  document.getElementById('btn-drawer-export')?.addEventListener('click', () => {
    const sel = state.prospects.filter(p => state.chosen.has(p.username));
    if (!sel.length) return showToast('Nothing selected.');
    exportCsv(sel); showToast('Exporting selected…');
  });
  document.getElementById('btn-drawer-open')?.addEventListener('click', () => {
    state.chosen.forEach(u => window.open(`https://www.instagram.com/${u}/`, '_blank'));
  });
  document.getElementById('btn-drawer-followed')?.addEventListener('click', async () => {
    const count = state.chosen.size;
    for (const u of state.chosen) await db.prospects.update(u, { status: 'followed' });
    state.chosen.clear();
    await loadData(); updateDrawer();
    showToast(`Marked ${count} as followed ✓`, 'success');
  });
  document.getElementById('btn-drawer-remove')?.addEventListener('click', async () => {
    if (!confirm(`Remove ${state.chosen.size} selected profiles?`)) return;
    for (const u of [...state.chosen]) await db.prospects.update(u, { status: 'rejected', rejectedAt: Date.now() });
    state.chosen.clear();
    await loadData(); updateDrawer();
    showToast('Selected profiles removed.', 'success');
  });

  // Settings
  document.getElementById('btn-save-settings')?.addEventListener('click', saveSettings);
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function showToast(msg, type = '') {
  const div = document.createElement('div');
  div.className = `toast${type ? ` ${type}` : ''}`;
  div.textContent = msg;
  el.toastContainer?.appendChild(div);
  setTimeout(() => div.remove(), 3000);
}

function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function fmtNum(n) {
  if (n >= 1e6) return (n/1e6).toFixed(1)+'M';
  if (n >= 1e3) return (n/1e3).toFixed(1)+'K';
  return String(n);
}

function setText(el, val)  { if (el) el.textContent = val; }
function setVal(id, val)   { const e = document.getElementById(id); if (e) e.value = val ?? ''; }
function getVal(id)        { return document.getElementById(id)?.value || ''; }
function boolVal(id)       { return Boolean(document.getElementById(id)?.checked); }
function setChecked(id, v) { const e = document.getElementById(id); if (e) e.checked = Boolean(v); }
function numVal(id, fb=0)  { return Number(document.getElementById(id)?.value) || fb; }
function numValOrNull(id)  { const v = document.getElementById(id)?.value; return v ? Number(v) : null; }
function downloadText(text, name, mime) {
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([text], { type: mime })),
    download: name,
  });
  a.click(); URL.revokeObjectURL(a.href);
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
init().catch(e => console.error('[dashboard] init error', e));
