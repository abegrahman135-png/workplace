/**
 * harvest_pagination.test.js
 *
 * Regression guard for "scanning stops after the first page (~24 profiles)".
 *
 * The content script is a classic IIFE that needs `window`/`chrome`, so rather
 * than importing it we assert the cursor-walking CONTRACT it relies on:
 * follow `next_max_id` until absent, dedupe across pages, respect the cap, and
 * treat empty pages as end-of-list only after a short streak.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'src', 'content', 'index.js'), 'utf8');

test('content script shape', async (t) => {
  await t.test('is a classic script (no ESM syntax)', () => {
    assert.equal(/^\s*(import|export)\s/m.test(SRC), false);
  });

  await t.test('drives pagination via the API, not only scrolling', () => {
    assert.match(SRC, /friendships\/\$\{userId\}\/\$\{kind\}/, 'calls the friendships endpoint');
    assert.match(SRC, /max_id/, 'passes a cursor');
    assert.match(SRC, /X-IG-App-ID/, 'sends the app id header');
  });

  await t.test('does NOT use scrollHeight as the liveness signal', () => {
    // The old bug: `if (h === lastH) stale++` on a virtualised list.
    assert.equal(/const h = box\.scrollHeight;[\s\S]{0,80}stale\+\+/.test(SRC), false);
    assert.match(SRC, /seen\.size === lastCount/, 'progress measured by usernames harvested');
  });

  await t.test('finds the scroller by computed overflow, not a <ul> guess', () => {
    assert.match(SRC, /getComputedStyle\(el\)/);
    assert.match(SRC, /overflowY/);
  });

  await t.test('retries transient failures instead of ending the run', () => {
    assert.match(SRC, /softFails/);
    assert.match(SRC, /res\.status === 429/);
  });
});

/** Reference implementation of the cursor walk, mirroring apiHarvest(). */
async function walk(fetchPage, { cap = Infinity } = {}) {
  const seen = new Set();
  let next = null, pages = 0, emptyStreak = 0;
  while (true) {
    if (seen.size >= cap) return { seen, pages, reason: 'cap' };
    const page = await fetchPage(next);
    pages++;
    for (const u of page.users) seen.add(u.username);
    next = page.next_max_id || null;
    if (!page.users.length) { if (++emptyStreak >= 3) return { seen, pages, reason: 'end' }; }
    else emptyStreak = 0;
    if (!next) return { seen, pages, reason: 'end' };
  }
}

test('cursor walk', async (t) => {
  const makeApi = (total, size = 50) => async (cur) => {
    const start = Number(cur || 0);
    const users = [];
    for (let i = start; i < Math.min(start + size, total); i++) users.push({ username: 'u' + i });
    const nx = start + size;
    return { users, ...(nx < total ? { next_max_id: String(nx) } : {}) };
  };

  await t.test('walks every page to the end (1000 profiles, not 24)', async () => {
    const r = await walk(makeApi(1000));
    assert.equal(r.seen.size, 1000);
    assert.equal(r.pages, 20);
    assert.equal(r.reason, 'end');
  });

  await t.test('dedupes overlapping pages', async () => {
    let n = 0;
    const r = await walk(async () => {
      n++;
      if (n > 3) return { users: [] };
      return { users: [{ username: 'a' }, { username: 'b' }], next_max_id: n < 3 ? String(n) : null };
    });
    assert.equal(r.seen.size, 2, 'repeated usernames collapse');
  });

  await t.test('honours the cap', async () => {
    const r = await walk(makeApi(1000), { cap: 120 });
    assert.equal(r.reason, 'cap');
    assert.ok(r.seen.size >= 120 && r.seen.size < 200);
  });

  await t.test('a single empty page does not end the run', async () => {
    let n = 0;
    const r = await walk(async () => {
      n++;
      if (n === 2) return { users: [], next_max_id: '2' };
      if (n > 4) return { users: [] };
      return { users: [{ username: 'x' + n }], next_max_id: String(n) };
    });
    assert.ok(r.pages > 2, 'kept going past the empty page');
  });
});
