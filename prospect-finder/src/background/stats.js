/**
 * stats.js — ONE canonical counter document. Fixes P1-5.
 *
 * v1 computed "scanned" from Σ session.stats.scanned (which counted duplicates)
 * and "total" from prospects.length (which under-counted because of the
 * ingest data loss). Two numbers, two definitions, displayed side by side —
 * part of why "500 scanned" and "10 shown" could both be true at once.
 */

import { db, STORES } from '../db/schema.js';
import { tabCounts } from '../search/query.js';
import { queueDepth, dominantError } from '../db/repo.jobs.js';

const KEY = 'global';

export async function readStats() {
  const row = await db.get(STORES.STATS, KEY);
  return row?.value || emptyStats();
}

export function emptyStats() {
  return {
    seen: 0, inserted: 0, merged: 0, rejected: 0,
    enriched: 0, failed: 0,
    updatedAt: 0,
  };
}

export async function bumpStats(patch) {
  return db.write([STORES.STATS], async (t) => {
    const s = t.store(STORES.STATS);
    const cur = (await s.get(KEY))?.value || emptyStats();
    const next = { ...cur };
    for (const [k, v] of Object.entries(patch)) next[k] = (next[k] || 0) + v;
    next.updatedAt = Date.now();
    await s.put({ key: KEY, value: next });
    return next;
  });
}

/** Full snapshot for the dashboard: counters + tab counts + queue health. */
export async function fullSnapshot() {
  const [stats, tabs, queue, err] = await Promise.all([
    readStats(), tabCounts(), queueDepth(), dominantError().catch(() => null),
  ]);
  return { stats, tabs, queue, queueError: err, at: Date.now() };
}

/** Rebuild counters from scratch by scanning (repair path). */
export async function rebuildStats() {
  let inserted = 0, enriched = 0, failed = 0;
  await db.read([STORES.PROSPECTS], async (t) => {
    await t.store(STORES.PROSPECTS).cursor(null, 'next', (p) => {
      inserted++;
      if (p.stage === 'scored') enriched++;
      if (p.stage === 'failed' || p.stage === 'dead') failed++;
      return true;
    });
  });
  const value = { ...emptyStats(), seen: inserted, inserted, enriched, failed, updatedAt: Date.now() };
  await db.put(STORES.STATS, { key: KEY, value });
  return value;
}
