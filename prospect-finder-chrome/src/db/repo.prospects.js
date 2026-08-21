/**
 * repo.prospects.js — Prospect persistence.
 * Never calls getAll() on the hot path. Everything is cursor- or index-driven.
 */

import { db, STORES } from './schema.js';
import { STAGE, LABEL, SCORE_VERSION } from '../lib/constants.js';
import { buildSearchTokens } from '../search/text_index.js';
import { hashStr } from '../lib/utils.js';

export function makeProspect({ username, raw, sessionId, sourceUsername, evidence, lane, priority }) {
  const now = Date.now();
  const p = {
    username,
    raw,
    enriched: null,
    metrics: {
      posts: raw.media_count ?? 0,
      followers: raw.follower_count ?? 0,
      following: raw.following_count ?? 0,
    },
    evidence: evidence || {},
    scored: null,
    stage: STAGE.QUEUED,
    status: 'active',
    label: LABEL.PENDING,
    femaleScore: evidence?.female?.value ?? 50,
    femaleConfidence: evidence?.female?.confidence ?? 0,
    finalScore: null,
    accountType: null,
    manualPriority: false,
    lane: lane || 'normal',
    priority: priority ?? 50,
    sessionIds: sessionId ? [sessionId] : [],
    sourceUsernames: sourceUsername ? [sourceUsername] : [],
    searchTokens: [],
    attempts: 0,
    lastError: null,
    firstSeenAt: now,
    lastSeenAt: now,
    enrichedAt: null,
    scoreVersion: SCORE_VERSION,
    schemaVersion: 2,
  };
  p.searchTokens = buildSearchTokens(p);
  return p;
}

/** Merge a re-sighting. Deliberately does NOT touch scores (fixes v1 P1-6). */
export function mergeSighting(existing, sessionId, sourceUsername) {
  if (sessionId && !existing.sessionIds.includes(sessionId)) {
    existing.sessionIds = [...existing.sessionIds, sessionId];
  }
  if (sourceUsername && !existing.sourceUsernames.includes(sourceUsername)) {
    existing.sourceUsernames = [...existing.sourceUsernames, sourceUsername];
  }
  existing.lastSeenAt = Date.now();
  return existing;
}

export async function getProspect(username) {
  return db.get(STORES.PROSPECTS, username);
}

export async function putProspect(p) {
  p.searchTokens = buildSearchTokens(p);
  p.bioHash = hashStr(p.enriched?.biography || '');
  return db.put(STORES.PROSPECTS, p);
}

export async function updateProspect(username, changes) {
  return db.write([STORES.PROSPECTS], async (t) => {
    const s = t.store(STORES.PROSPECTS);
    const cur = await s.get(username);
    if (!cur) return null;
    const next = { ...cur, ...changes };
    next.searchTokens = buildSearchTokens(next);
    await s.put(next);
    return next;
  });
}

export async function updateMany(usernames, changes) {
  return db.write([STORES.PROSPECTS], async (t) => {
    const s = t.store(STORES.PROSPECTS);
    let n = 0;
    for (const u of usernames) {
      const cur = await s.get(u);
      if (!cur) continue;
      const next = { ...cur, ...changes };
      next.searchTokens = buildSearchTokens(next);
      await s.put(next);
      n++;
    }
    return n;
  });
}

export async function countProspects() {
  return db.count(STORES.PROSPECTS);
}

/** Count by a single-value index (label, stage, status). */
export async function countBy(indexName, value) {
  return db.read([STORES.PROSPECTS], (t) =>
    t.index(STORES.PROSPECTS, indexName).count(IDBKeyRange.only(value)));
}

/**
 * Fast paged read for the common case: one label, sorted by score.
 * Reads exactly `limit` rows — O(page), not O(N).
 */
export async function pageByLabelScore({ label, offset = 0, limit = 50, desc = true }) {
  return db.read([STORES.PROSPECTS], async (t) => {
    const idx = t.index(STORES.PROSPECTS, 'byLabelScore');
    const range = IDBKeyRange.bound([label, -1], [label, 101]);
    const out = [];
    let skipped = 0;
    await idx.cursor(range, desc ? 'prev' : 'next', (value) => {
      if (skipped < offset) { skipped++; return true; }
      out.push(value);
      if (out.length >= limit) return false;
      return true;
    });
    return out;
  });
}

/** Stream every prospect through a callback without materialising the array. */
export async function scanProspects(cb, { indexName = null, range = null, direction = 'next' } = {}) {
  return db.read([STORES.PROSPECTS], async (t) => {
    const src = indexName
      ? t.index(STORES.PROSPECTS, indexName)
      : t.store(STORES.PROSPECTS);
    await src.cursor(range, direction, cb);
  });
}

/** Primary keys matching a multiEntry token — used by text search. */
export async function keysForToken(token) {
  return db.read([STORES.PROSPECTS], async (t) => {
    const idx = t.index(STORES.PROSPECTS, 'byToken');
    const keys = [];
    await idx.keyCursor(IDBKeyRange.only(token), 'next', (pk) => { keys.push(pk); return true; });
    return keys;
  });
}

export async function getMany(usernames) {
  return db.read([STORES.PROSPECTS], async (t) => {
    const s = t.store(STORES.PROSPECTS);
    const out = [];
    for (const u of usernames) {
      const v = await s.get(u);
      if (v) out.push(v);
    }
    return out;
  });
}

export async function deleteProspect(username) {
  return db.write([STORES.PROSPECTS, STORES.PROCESSED], async (t) => {
    await t.store(STORES.PROSPECTS).delete(username);
    await t.store(STORES.PROCESSED).delete(username);
  });
}
