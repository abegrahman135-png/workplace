/**
 * fixture_ingest.test.js — drives the real ingest path with generated fixtures.
 *
 * Guards the original P0 defect: 500+ profiles scanned but only a handful
 * reaching the dashboard. Asserts conservation (every valid input is either
 * inserted or merged, never silently dropped) and that hostile input cannot
 * abort a batch.
 */

import '../helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FX = join(process.cwd(), 'tests', 'fixtures');
const readFx = (f) => JSON.parse(readFileSync(join(FX, f), 'utf8'));

const { db, STORES } = await import('../../src/db/schema.js');
const { ingestBatch } = await import('../../src/background/ingest.js');
const { queueDepth } = await import('../../src/db/repo.jobs.js');
const { tabCounts } = await import('../../src/search/query.js');

test('fixture ingest', async (t) => {
  await db.open();

  const batch = readFx('follower_batch.json');
  const edge = readFx('edge_cases.json');

  await t.test('every scanned profile is persisted and queued', async () => {
    const res = await ingestBatch({
      users: batch.users,
      sessionId: batch.sessionId,
      sourceUsername: batch.sourceUsername,
    });

    assert.equal(res.seen, batch.users.length, 'seen must equal input length');
    assert.equal(
      res.inserted + res.merged + res.rejected,
      res.seen,
      'conservation: inserted + merged + rejected must account for every input',
    );

    const stored = await db.count(STORES.PROSPECTS);
    assert.equal(stored, res.inserted, 'every inserted prospect is readable back');

    // The core regression: scanned count must reach the dashboard, not ~10.
    assert.ok(stored >= 490, `expected ~500 stored, got ${stored}`);

    const q = await queueDepth();
    assert.equal(q.pending, res.inserted, 'every new prospect gets an enrich job');
  });

  await t.test('re-ingesting the same batch merges instead of duplicating', async () => {
    const before = await db.count(STORES.PROSPECTS);
    const res = await ingestBatch({
      users: batch.duplicates,
      sessionId: 'fixture-session-2',
      sourceUsername: 'second_source',
    });
    const after = await db.count(STORES.PROSPECTS);

    assert.equal(after, before, 'duplicates must not create new rows');
    assert.equal(res.merged, batch.duplicates.length, 'all duplicates report as merged');
  });

  await t.test('merge records the second source without losing the first', async () => {
    const u = batch.duplicates[0].username;
    const p = await db.get(STORES.PROSPECTS, u);
    assert.ok(p, 'merged prospect still exists');
    assert.ok(p.sourceUsernames.includes(batch.sourceUsername), 'original source kept');
    assert.ok(p.sourceUsernames.includes('second_source'), 'new source appended');
    assert.equal(p.sessionIds.length, 2, 'both sessions recorded');
  });

  await t.test('hostile input is rejected without aborting the batch', async () => {
    const before = await db.count(STORES.PROSPECTS);
    const res = await ingestBatch({
      users: edge,
      sessionId: 'fixture-edge',
      sourceUsername: 'edge_src',
    });

    assert.equal(res.seen, edge.length);
    assert.ok(res.rejected > 0, 'blank/invalid usernames must be rejected');
    assert.equal(
      res.inserted + res.merged + res.rejected,
      res.seen,
      'conservation holds even for malformed input',
    );

    const after = await db.count(STORES.PROSPECTS);
    assert.equal(after - before, res.inserted, 'only valid rows landed');
  });

  await t.test('tab counts agree with stored rows', async () => {
    const counts = await tabCounts();
    const total = await db.count(STORES.PROSPECTS);
    const rejected = counts.rejected || 0;
    assert.equal(counts.total + rejected, total, 'tab totals reconcile with the store');
  });
});

/**
 * Regression: a 404 marks the PROSPECT dead and consumes its job row, so
 * requeueDead() (jobs-only) found nothing and the dashboard's Retry button
 * reported "0 requeued" while dead prospects sat permanently unreachable.
 * Caught by loading the extension in real Chrome.
 */
test('retryFailed revives dead prospects that have no job row', async () => {
  const { db: d, STORES: S } = await import('../../src/db/schema.js');
  // Import the pure requeue path, NOT retryFailed(): that also calls pumpNow(),
  // which starts real fetches and leaves retry timers running past the test.
  const { requeueAllFailed } = await import('../../src/background/scheduler.js');
  await d.open();

  await d.write([S.JOBS], async (t) => { await t.store(S.JOBS).clear(); });
  const all = await d.getAll(S.PROSPECTS);
  const victims = all.slice(0, 10);
  for (const p of victims) {
    await d.put(S.PROSPECTS, { ...p, stage: 'dead', lastError: 'HTTP 404' });
  }

  const n = await requeueAllFailed();
  assert.ok(n >= victims.length, `expected >=${victims.length} requeued, got ${n}`);

  for (const p of victims) {
    const row = await d.get(S.PROSPECTS, p.username);
    assert.notEqual(row.stage, 'dead', `${p.username} still dead`);
  }
  const jobs = await d.getAll(S.JOBS);
  assert.ok(jobs.length >= victims.length, 'fresh enrich jobs were created');
});
