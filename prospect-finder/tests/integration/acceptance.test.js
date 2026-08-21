/**
 * acceptance.test.js — plan §13 criteria that are verifiable headlessly.
 * Criteria needing a real browser/Chrome (3,4,8,9) are covered elsewhere or
 * listed as known gaps in the README.
 */
import '../helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const readFx = (f) => JSON.parse(readFileSync(join(process.cwd(), 'tests', 'fixtures', f), 'utf8'));
const { db, STORES } = await import('../../src/db/schema.js');
const { ingestBatch } = await import('../../src/background/ingest.js');
const { tabCounts, runQuery } = await import('../../src/search/query.js');
const { scoreProspect } = await import('../../src/engines/scoring.js');
const { mergeProspect } = await import('../../src/engines/dedup.js');
const { DEFAULT_SETTINGS } = await import('../../src/lib/constants.js');

test('acceptance criteria', async (t) => {
  await db.open();
  const fx = readFx('follower_batch.json');

  const rejections = [];
  process.on('unhandledRejection', (e) => rejections.push(e));

  const res = await ingestBatch({ users: fx.users, sessionId: 's1', sourceUsername: 'src1' });

  await t.test('AC1+AC6: every scanned profile is accounted for', async () => {
    assert.equal(res.inserted + res.merged + res.rejected, res.seen);
    const counts = await tabCounts();
    const sum = counts.high + counts.qualified + counts.review + counts.excluded
              + counts.pending + counts.rejected;
    const stored = await db.count(STORES.PROSPECTS);
    assert.equal(sum, stored, `tabs must sum to stored rows (${sum} vs ${stored})`);
  });

  await t.test('AC2: no profile lands in the void — every row has a tab', async () => {
    const all = await db.getAll(STORES.PROSPECTS);
    const VALID = new Set(['high_priority','qualified','review','pending','excluded']);
    const orphans = all.filter(p => !VALID.has(p.label));
    assert.equal(orphans.length, 0, `orphaned labels: ${orphans.slice(0,3).map(o=>o.label)}`);
  });

  await t.test('AC11: score always within [0,100]', async () => {
    const all = await db.getAll(STORES.PROSPECTS);
    for (const p of all) {
      if (p.finalScore == null) continue;
      assert.ok(p.finalScore >= 0 && p.finalScore <= 100, `${p.username} scored ${p.finalScore}`);
    }
  });

  await t.test('AC11: merging is idempotent', async () => {
    const base = await db.get(STORES.PROSPECTS, fx.users[0].username);
    const once = mergeProspect(base, { ...base }, { sessionId: 's1', sourceUsername: 'src1' });
    const twice = mergeProspect(once, { ...base }, { sessionId: 's1', sourceUsername: 'src1' });
    assert.deepEqual(twice.sourceUsernames.sort(), once.sourceUsernames.sort());
    assert.deepEqual(twice.sessionIds.sort(), once.sessionIds.sort());
  });

  await t.test('AC5: a poison record does not take down its batch', async () => {
    const poison = [
      { username: 'good_one_a', full_name: 'Good A', is_private: true },
      null,
      { username: '', full_name: 'bad' },
      { username: 'good_one_b', full_name: 'Good B', is_private: false },
    ];
    const r = await ingestBatch({ users: poison, sessionId: 's2', sourceUsername: 'src2' });
    assert.equal(r.seen, poison.length);
    assert.ok(await db.get(STORES.PROSPECTS, 'good_one_a'), 'valid row before poison survived');
    assert.ok(await db.get(STORES.PROSPECTS, 'good_one_b'), 'valid row after poison survived');
    assert.ok(r.rejected >= 2, 'poison rows were rejected, not crashed on');
  });

  await t.test('AC12: filters are composable', async () => {
    const q = await runQuery({
      filters: [
        { field: 'metrics.followers', op: 'gte', value: 100 },
        { field: 'raw.is_private', op: 'eq', value: true },
      ],
      logic: 'AND',
      sort: { field: 'score', dir: 'desc' },
      page: { limit: 20, offset: 0 },
      needTotal: true,
    });
    assert.ok(Array.isArray(q.rows));
    for (const r of q.rows) assert.equal(r.raw.is_private, true, 'AND logic respected');
  });

  await t.test('AC14: no unhandled promise rejections during the run', () => {
    assert.equal(rejections.length, 0, `unhandled: ${rejections.map(String).slice(0,3)}`);
  });

  await t.test('AC13: no external network references in UI assets', () => {
    for (const f of ['src/ui/dashboard.html','src/ui/popup.html','src/ui/styles/app.css','src/ui/styles/tokens.css']) {
      const src = readFileSync(join(process.cwd(), f), 'utf8');
      const ext = src.match(/https?:\/\/(?!www\.w3\.org)[^\s"')]+/g) || [];
      assert.equal(ext.length, 0, `${f} references ${ext[0]}`);
    }
  });
});
