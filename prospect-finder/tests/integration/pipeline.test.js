/**
 * pipeline.test.js — The tests that prove the "500 scanned, 10 shown" bug is
 * actually fixed. Each one targets a specific v1 root cause.
 */

import '../helpers/env.js';
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, makeUsers, fakeProfile } from '../helpers/env.js';

const S = () => import('../../src/db/schema.js');

describe('pipeline', () => {
  beforeEach(async () => { await resetDb(); });

  test('P0-1: a poisoned record does not destroy the rest of the batch', async () => {
    const { db, STORES } = await S();
    const { ingestBatch } = await import('../../src/background/ingest.js');
    const { DEFAULT_SETTINGS } = await import('../../src/lib/constants.js');
    await db.open();

    const users = makeUsers(50);
    users[17].username = '';                    // empty keyPath — aborted v1's whole tx
    users[31].username = 'bad name!!with spaces';

    const r = await ingestBatch({
      sessionId: 's1', sourceUsername: 'target', users, settings: DEFAULT_SETTINGS,
    });

    assert.equal(r.seen, 50);
    assert.equal(r.rejected, 2);
    assert.equal(r.inserted, 48, 'the 48 valid records must survive');

    const count = await db.count(STORES.PROSPECTS);
    assert.equal(count, 48);
  });

  test('P0-1: no orphaned processed-markers (the permanent-invisibility bug)', async () => {
    const { db, STORES } = await S();
    const { ingestBatch } = await import('../../src/background/ingest.js');
    const { DEFAULT_SETTINGS } = await import('../../src/lib/constants.js');
    await db.open();

    await ingestBatch({
      sessionId: 's1', sourceUsername: 't', users: makeUsers(40), settings: DEFAULT_SETTINGS,
    });

    const prospects = await db.getAll(STORES.PROSPECTS);
    const processed = await db.getAll(STORES.PROCESSED);
    const pset = new Set(prospects.map(p => p.username));

    assert.equal(processed.length, prospects.length);
    for (const m of processed) {
      assert.ok(pset.has(m.username), `orphan marker: ${m.username}`);
    }
  });

  test('P0-3: EVERY scanned profile is queued, not just dictionary names', async () => {
    const { db, STORES } = await S();
    const { ingestBatch } = await import('../../src/background/ingest.js');
    const { DEFAULT_SETTINGS } = await import('../../src/lib/constants.js');
    const { loadNameDb } = await import('../../src/engines/classifier/index.js');
    await db.open();
    await loadNameDb();

    const users = makeUsers(500);
    await ingestBatch({ sessionId: 's1', sourceUsername: 't', users, settings: DEFAULT_SETTINGS });

    const prospects = await db.count(STORES.PROSPECTS);
    const jobs = await db.count(STORES.JOBS);

    assert.equal(prospects, 500, 'all 500 persisted');
    assert.equal(jobs, 500, 'all 500 queued for enrichment — v1 queued ~90');

    // Unknown-name profiles must still be present and queued.
    const all = await db.getAll(STORES.PROSPECTS);
    const unknown = all.filter(p => p.evidence?.female?.verdict === 'unknown');
    assert.ok(unknown.length > 50, `expected many unknowns, got ${unknown.length}`);
    for (const u of unknown.slice(0, 20)) {
      const job = await db.get(STORES.JOBS, `enrich:${u.username}`);
      assert.ok(job, `unknown-name profile ${u.username} must still be queued`);
    }
  });

  test('P0-2: queue survives worker death and reaches 100%', async () => {
    const { db, STORES } = await S();
    const { ingestBatch } = await import('../../src/background/ingest.js');
    const { DEFAULT_SETTINGS, JOB_STATUS } = await import('../../src/lib/constants.js');
    const enricher = await import('../../src/background/enricher.js');
    const { claimBatch, completeJob, queueDepth } = await import('../../src/db/repo.jobs.js');
    await db.open();

    const N = 120;
    await ingestBatch({
      sessionId: 's1', sourceUsername: 't', users: makeUsers(N), settings: DEFAULT_SETTINGS,
    });

    // Stub the network.
    let i = 0;
    enricher.fetchProfile;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const uname = decodeURIComponent(String(url).split('username=')[1]);
      const payload = { data: { user: fakeProfile(uname, i++) } };
      return { ok: true, status: 200, json: async () => payload };
    };

    const ctx = {
      limiter: { waitForSlot: async () => {}, reportSuccess() {}, reportError() {} },
      breaker: { isOpen: false, trip() {}, fail() {}, reset() {}, remaining: () => 0 },
      settings: DEFAULT_SETTINGS,
    };

    // Process 30 jobs, then simulate the worker being KILLED mid-lease:
    // claim a batch and simply abandon it without completing.
    let done = 0;
    while (done < 30) {
      const jobs = await claimBatch(3);
      if (!jobs.length) break;
      for (const j of jobs) {
        await enricher.runEnrichJob(j, ctx);
        await completeJob(j.id);
        done++;
      }
    }
    const abandoned = await claimBatch(5);   // leased, never completed == worker died
    assert.equal(abandoned.length, 5);

    let depth = await queueDepth();
    assert.equal(depth.leased, 5, 'five jobs stuck in leased state');

    // Simulate the alarm firing AFTER the lease expired.
    await db.write([STORES.JOBS], async (t) => {
      const st = t.store(STORES.JOBS);
      for (const j of abandoned) {
        const row = await st.get(j.id);
        row.leaseExpiresAt = Date.now() - 1000;   // expire it
        await st.put(row);
      }
    });

    // Drain everything, as repeated alarm ticks would.
    let guard = 0;
    while (guard++ < 200) {
      const jobs = await claimBatch(5);
      if (!jobs.length) break;
      for (const j of jobs) {
        await enricher.runEnrichJob(j, ctx);
        await completeJob(j.id);
      }
    }

    globalThis.fetch = origFetch;

    depth = await queueDepth();
    assert.equal(depth.pending, 0);
    assert.equal(depth.leased, 0);

    const all = await db.getAll(STORES.PROSPECTS);
    const scored = all.filter(p => p.stage === 'scored');
    assert.equal(scored.length, N, `all ${N} enriched after simulated worker death`);
  });

  test('accounting: every prospect lands in exactly one visible bucket', async () => {
    const { db } = await S();
    const { ingestBatch } = await import('../../src/background/ingest.js');
    const { DEFAULT_SETTINGS } = await import('../../src/lib/constants.js');
    const { tabCounts } = await import('../../src/search/query.js');
    await db.open();

    await ingestBatch({
      sessionId: 's1', sourceUsername: 't', users: makeUsers(200), settings: DEFAULT_SETTINGS,
    });

    const c = await tabCounts();
    const sum = c.high + c.qualified + c.review + c.excluded + c.pending;
    assert.equal(c.total, 200);
    assert.equal(sum, 200, 'no profile may fall through the cracks');
  });

  test('P1-6: merging a re-sighting never changes the score', async () => {
    const { db, STORES } = await S();
    const { ingestBatch } = await import('../../src/background/ingest.js');
    const { DEFAULT_SETTINGS } = await import('../../src/lib/constants.js');
    await db.open();

    const users = makeUsers(10);
    await ingestBatch({ sessionId: 's1', sourceUsername: 'a', users, settings: DEFAULT_SETTINGS });

    await db.write([STORES.PROSPECTS], async (t) => {
      const st = t.store(STORES.PROSPECTS);
      const p = await st.get(users[0].username);
      await st.put({ ...p, finalScore: 82, label: 'high_priority', scored: { finalScore: 82 } });
    });

    for (const src of ['b', 'c', 'd', 'e']) {
      await ingestBatch({ sessionId: 's2', sourceUsername: src, users, settings: DEFAULT_SETTINGS });
    }

    const after = await db.get(STORES.PROSPECTS, users[0].username);
    assert.equal(after.finalScore, 82, 'score must be untouched by merges');
    assert.equal(after.sourceUsernames.length, 5);
  });
});
