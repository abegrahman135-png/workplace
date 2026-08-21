/**
 * Regression tests for the "N discovered / 0 enriched" outage.
 *
 * Root cause: an MV3 service worker fetch to Instagram's private API is
 * cross-origin and carries no first-party session cookie, so IG answers
 * 401/403 for every profile. Harvesting kept working (content script,
 * same-origin), so the queue filled while nothing ever enriched.
 *
 * Two independent defects made it invisible:
 *   1. deferJob() refunded `attempts` unconditionally, so a permanent upstream
 *      failure deferred every job forever - never dead, never errored.
 *   2. A tripped breaker reported "breaker_open" instead of the real fault.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import '../helpers/env.js';

import { db, STORES } from '../../src/db/schema.js';
import { makeJob, deferJob, queueDepth, dominantError, MAX_DEFERS } from '../../src/db/repo.jobs.js';
import { JOB_STATUS } from '../../src/lib/constants.js';

async function seedJob(username) {
  await db.open();
  const j = makeJob({ username });
  await db.write([STORES.JOBS], async (t) => t.store(STORES.JOBS).put(j));
  return j;
}

test('deferJob stops refunding attempts forever and eventually marks the job dead', async () => {
  const j = await seedJob('defer_victim');
  let row;
  for (let i = 0; i < MAX_DEFERS; i++) {
    row = await deferJob(j.id, 1000, 'http_403 not authenticated');
  }
  assert.strictEqual(row.status, JOB_STATUS.DEAD);
  assert.ok(String(row.lastError).includes('403'));

  const d = await queueDepth();
  assert.strictEqual(d.dead, 1);
  assert.strictEqual(d.pending, 0);
});

test('a deferred job records why, so the queue can never stall silently', async () => {
  const j = await seedJob('explains_itself');
  await deferJob(j.id, 1000, 'breaker_open (http_403 not authenticated)');
  const top = await dominantError();
  assert.ok(top);
  assert.ok(String(top.msg).includes('403'));
});

test('rate-budget defers stay blameless and keep the job alive', async () => {
  const j = await seedJob('paced');
  const row = await deferJob(j.id, 500, null);   // our own pacing, not a fault
  assert.strictEqual(row.status, JOB_STATUS.PENDING);
  assert.strictEqual(row.lastError, null);
});

test('fetchProfile prefers a live instagram.com tab over the worker origin', async () => {
  const calls = [];
  globalThis.chrome = {
    ...(globalThis.chrome || {}),
    runtime: { ...(globalThis.chrome?.runtime || {}), lastError: null },
    tabs: {
      query: async () => [{ id: 1, url: 'https://www.instagram.com/home' }],
      sendMessage: (id, msg, cb) => {
        calls.push(msg.url);
        cb({ ok: true, status: 200, body: { data: { user: { username: 'via_tab' } } } });
      },
    },
  };
  // The worker's own fetch is what production rejects.
  globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({}) });

  const { fetchProfile } = await import('../../src/background/enricher.js?authproxy');
  const r = await fetchProfile('via_tab');

  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.user.username, 'via_tab');
  assert.strictEqual(calls.length, 1);
});

test('with no instagram tab, a 403 is reported as an auth fault, not a mystery', async () => {
  globalThis.chrome = {
    ...(globalThis.chrome || {}),
    tabs: { query: async () => [], sendMessage: () => {} },
  };
  globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({}) });

  const { fetchProfile } = await import('../../src/background/enricher.js?noauth');
  const r = await fetchProfile('blocked');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.noAuth, true);
});
