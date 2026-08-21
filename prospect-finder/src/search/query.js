/**
 * query.js — Query planner + executor.
 *
 * v1 ran db.prospects.getAll() on every keystroke: deserialise all N rows,
 * filter in JS, sort, re-render. 300-800ms main-thread block at 5k records.
 *
 * v2 picks the most selective index available, opens a cursor over just that
 * range, and applies the remaining predicates in-cursor. The fast path reads
 * exactly `limit` rows.
 */

import { db, STORES } from '../db/schema.js';
import { buildMatcher } from './predicates.js';
import { queryTerms } from './text_index.js';
import { compareProspects } from '../engines/scoring.js';
import { LABEL } from '../lib/constants.js';

export const SORTS = {
  priority:   { index: null, cmp: compareProspects },
  score:      { index: 'byFinalScore', field: p => p.finalScore ?? -1 },
  posts:      { index: 'byPosts', field: p => p.metrics?.posts ?? 0 },
  followers:  { index: 'byFollowers', field: p => p.metrics?.followers ?? 0 },
  following:  { index: 'byFollowing', field: p => p.metrics?.following ?? 0 },
  female:     { index: 'byFemaleScore', field: p => p.femaleScore ?? 0 },
  newest:     { index: 'byFirstSeen', field: p => p.firstSeenAt ?? 0 },
  oldest:     { index: 'byFirstSeen', field: p => p.firstSeenAt ?? 0, asc: true },
  ratio:      { index: null, field: p => { const f = p.metrics?.following ?? 0; return f ? (p.metrics?.followers ?? 0) / f : 0; } },
};

function conditionsOf(q) {
  const list = [];
  const walk = (g) => {
    if (!g) return;
    if (g.logic === 'OR') return;          // OR groups can't drive index choice
    (g.conditions || []).forEach(c => list.push(c));
    (g.groups || []).forEach(walk);
  };
  if (q.group) walk(q.group);
  else if (q.filters && (q.logic || 'AND') === 'AND') q.filters.forEach(c => list.push(c));
  return list;
}

/**
 * Choose a cursor source. Returns {store|index, range, direction, presorted}.
 */
export function planQuery(q) {
  const conds = conditionsOf(q);
  const sort = SORTS[q.sort?.field] || SORTS.priority;
  const desc = (q.sort?.dir || 'desc') === 'desc';

  const labelCond = conds.find(c => c.field === 'label' && c.op === 'eq');
  const statusCond = conds.find(c => c.field === 'status' && c.op === 'eq');

  // Best case: single label + sort by score -> one compound index scan,
  // already ordered, so we can stop after `limit` rows.
  if (labelCond && (q.sort?.field === 'score' || !q.sort?.field)) {
    return {
      index: 'byLabelScore',
      range: IDBKeyRange.bound([labelCond.value, -1], [labelCond.value, 101]),
      direction: desc ? 'prev' : 'next',
      presorted: q.sort?.field === 'score',
      note: 'compound(label,score)',
    };
  }

  if (labelCond) {
    return { index: 'byLabel', range: IDBKeyRange.only(labelCond.value), direction: 'next', presorted: false, note: 'byLabel' };
  }
  if (statusCond) {
    return { index: 'byStatus', range: IDBKeyRange.only(statusCond.value), direction: 'next', presorted: false, note: 'byStatus' };
  }
  if (sort.index) {
    return { index: sort.index, range: null, direction: desc ? 'prev' : 'next', presorted: true, note: `sortIndex(${sort.index})` };
  }
  return { index: null, range: null, direction: 'next', presorted: false, note: 'fullScan' };
}

/**
 * Execute a query.
 * @returns {{rows:Array, total:number, plan:string, tookMs:number}}
 */
export async function runQuery(q = {}) {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const limit = q.page?.limit ?? 50;
  const offset = q.page?.offset ?? 0;
  const match = buildMatcher(q);
  const plan = planQuery(q);
  const sort = SORTS[q.sort?.field] || SORTS.priority;
  const desc = (q.sort?.dir || 'desc') === 'desc';

  // Text pre-filter. Count each candidate term (cheap, index-only), pick the
  // rarest, then pull those rows in ONE getAll instead of N point lookups.
  let textRows = null;
  if (q.text && q.text.length >= 2) {
    const terms = queryTerms(q.text);
    if (terms.length) {
      textRows = await db.read([STORES.PROSPECTS], async (t) => {
        const idx = t.index(STORES.PROSPECTS, 'byToken');
        let best = null;
        let bestN = Infinity;
        for (const term of terms.slice(0, 12)) {
          const n = await idx.count(IDBKeyRange.only(term));
          if (n === 0) return [];              // impossible term -> no results
          if (n < bestN) { bestN = n; best = term; }
        }
        if (!best) return [];
        return idx.getAll(IDBKeyRange.only(best));
      });
    }
  }

  const collected = [];
  let total = 0;
  let canStreamPage = plan.presorted && !q.needTotal;

  if (textRows) {
    canStreamPage = false;
    for (const p of textRows) {
      if (match(p)) collected.push(p);
    }
  } else {
    await db.read([STORES.PROSPECTS], async (t) => {
      const src = plan.index
        ? t.index(STORES.PROSPECTS, plan.index)
        : t.store(STORES.PROSPECTS);

      await src.cursor(plan.range, plan.direction, (p) => {
        if (!match(p)) return true;
        total++;
        if (canStreamPage) {
          if (total <= offset) return true;
          collected.push(p);
          if (collected.length >= limit) return false;   // early exit — O(page)
          return true;
        }
        collected.push(p);
        return true;
      });
    });
  }

  let rows = collected;
  if (!canStreamPage) {
    if (sort.cmp) rows.sort(sort.cmp);
    else {
      const f = sort.field;
      const asc = sort.asc ? !desc : desc;
      rows.sort((a, b) => (asc ? f(b) - f(a) : f(a) - f(b)));
    }
    total = rows.length;
    rows = rows.slice(offset, offset + limit);
  }

  const t1 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  return { rows, total, plan: plan.note, tookMs: Math.round((t1 - t0) * 10) / 10 };
}

/** Counts for the tab strip — index counts, no row deserialisation. */
export async function tabCounts() {
  return db.read([STORES.PROSPECTS], async (t) => {
    const byLabel = t.index(STORES.PROSPECTS, 'byLabel');
    const byStatus = t.index(STORES.PROSPECTS, 'byStatus');
    const byStage = t.index(STORES.PROSPECTS, 'byStage');
    const [high, qualified, review, excluded, pending, rejected, total, dead, failed] = await Promise.all([
      byLabel.count(IDBKeyRange.only(LABEL.HIGH)),
      byLabel.count(IDBKeyRange.only(LABEL.QUALIFIED)),
      byLabel.count(IDBKeyRange.only(LABEL.REVIEW)),
      byLabel.count(IDBKeyRange.only(LABEL.EXCLUDED)),
      byLabel.count(IDBKeyRange.only(LABEL.PENDING)),
      byStatus.count(IDBKeyRange.only('rejected')),
      t.store(STORES.PROSPECTS).count(),
      byStage.count(IDBKeyRange.only('dead')),
      byStage.count(IDBKeyRange.only('failed')),
    ]);
    return { high, qualified, review, excluded, pending, rejected, total, dead, failed };
  });
}

/** Collect every username matching a query (for bulk actions / export). */
export async function collectMatching(q, cap = 100000) {
  const match = buildMatcher(q);
  const out = [];
  await db.read([STORES.PROSPECTS], async (t) => {
    await t.store(STORES.PROSPECTS).cursor(null, 'next', (p) => {
      if (match(p)) out.push(p);
      return out.length < cap;
    });
  });
  return out;
}
