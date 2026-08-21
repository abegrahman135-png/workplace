import '../helpers/env.js';
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb } from '../helpers/env.js';

describe('query performance @ 10k', () => {
  let db, STORES, runQuery, tabCounts;

  before(async () => {
    await resetDb();
    ({ db, STORES } = await import('../../src/db/schema.js'));
    ({ runQuery, tabCounts } = await import('../../src/search/query.js'));
    const { buildSearchTokens } = await import('../../src/search/text_index.js');
    await db.open();

    const LABELS = ['high_priority', 'qualified', 'review', 'excluded'];
    const rows = [];
    for (let i = 0; i < 10000; i++) {
      const p = {
        username: `user_${i}`,
        raw: { full_name: `Person ${i}`, is_private: i % 3 === 0 },
        enriched: { biography: i % 7 === 0 ? 'photographer and traveller' : 'coffee lover', is_private: i % 3 === 0, post_count: i % 400 },
        metrics: { posts: i % 400, followers: (i * 37) % 20000, following: (i * 13) % 3000 },
        evidence: { female: { verdict: i % 2 ? 'likely_female' : 'unknown', value: i % 100, confidence: 0.5 } },
        femaleScore: i % 100, femaleConfidence: 0.5,
        finalScore: i % 101,
        label: LABELS[i % 4],
        stage: 'scored', status: 'active',
        sourceUsernames: [`src${i % 20}`], sessionIds: ['s1'],
        firstSeenAt: Date.now() - i * 1000, lastSeenAt: Date.now(),
        manualPriority: false, schemaVersion: 2,
      };
      p.searchTokens = buildSearchTokens(p);
      rows.push(p);
    }
    for (let i = 0; i < rows.length; i += 500) {
      await db.bulkPut(STORES.PROSPECTS, rows.slice(i, i + 500));
    }
  });

  test('paged label+score query is fast and correct', async () => {
    const t0 = performance.now();
    const r = await runQuery({
      filters: [{ field: 'label', op: 'eq', value: 'high_priority' }],
      sort: { field: 'score', dir: 'desc' },
      page: { offset: 0, limit: 50 },
    });
    const ms = performance.now() - t0;
    assert.equal(r.rows.length, 50);
    assert.equal(r.plan, 'compound(label,score)');
    for (let i = 1; i < r.rows.length; i++) {
      assert.ok(r.rows[i - 1].finalScore >= r.rows[i].finalScore, 'must be sorted desc');
    }
    console.log(`      label+score page: ${ms.toFixed(1)}ms (plan=${r.plan})`);
    assert.ok(ms < 250, `too slow: ${ms}ms`);
  });

  test('text search uses the trigram index', async () => {
    const t0 = performance.now();
    const r = await runQuery({ text: 'photographer', page: { offset: 0, limit: 50 } });
    const ms = performance.now() - t0;
    console.log(`      text search: ${ms.toFixed(1)}ms, ${r.total} hits`);
    assert.ok(r.total > 1000, `expected ~1428 hits, got ${r.total}`);
    assert.ok(r.rows.every(p => (p.enriched.biography || '').includes('photographer')));
    assert.ok(ms < 800, `too slow: ${ms}ms`);
  });

  test('complex multi-filter query', async () => {
    const t0 = performance.now();
    const r = await runQuery({
      filters: [
        { field: 'isPrivate', op: 'eq', value: true },
        { field: 'posts', op: 'between', value: [50, 300] },
        { field: 'followers', op: 'gte', value: 100 },
        { field: 'verdict', op: 'eq', value: 'likely_female' },
      ],
      sort: { field: 'score', dir: 'desc' },
      page: { offset: 0, limit: 50 },
    });
    const ms = performance.now() - t0;
    console.log(`      4-filter query: ${ms.toFixed(1)}ms, ${r.total} matches`);
    assert.ok(r.rows.length > 0);
    assert.ok(ms < 900, `too slow: ${ms}ms`);
  });

  test('tab counts use index counts only', async () => {
    const t0 = performance.now();
    const c = await tabCounts();
    const ms = performance.now() - t0;
    console.log(`      tabCounts: ${ms.toFixed(1)}ms`);
    assert.equal(c.total, 10000);
    assert.equal(c.high + c.qualified + c.review + c.excluded, 10000);
    assert.ok(ms < 200, `too slow: ${ms}ms`);
  });

  test('brute-force parity: planner returns the same set', async () => {
    const q = {
      filters: [
        { field: 'label', op: 'eq', value: 'qualified' },
        { field: 'posts', op: 'gte', value: 200 },
      ],
      sort: { field: 'score', dir: 'desc' },
      page: { offset: 0, limit: 10000 },
      needTotal: true,
    };
    const planned = await runQuery(q);
    const all = await db.getAll(STORES.PROSPECTS);
    const brute = all.filter(p => p.label === 'qualified' && p.metrics.posts >= 200);
    assert.equal(planned.total, brute.length, 'planner must not lose rows');
  });
});
