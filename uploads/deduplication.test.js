import test from 'node:test';
import assert from 'node:assert/strict';
import { deduplicateAndMerge } from '../src/engines/deduplication.js';

// Mock db that simulates IndexedDB get/put/update
function makeMockDb(existing = null) {
  let store = existing ? { ...existing } : null;
  return {
    prospects: {
      async get(username) { return store && store.username === username ? { ...store } : null; },
      async put(record)  { store = { ...record }; },
      async update(username, changes) {
        if (store && store.username === username) store = { ...store, ...changes };
      },
    }
  };
}

const baseProspect = {
  username: 'jane_doe',
  full_name: 'Jane Doe',
  is_private: true,
  femaleScore: 92,
};

// ─── Insert (new prospect) ─────────────────────────────────────────────────
test('deduplicateAndMerge: inserts new prospect with sessionIds and timestamps', async () => {
  const db = makeMockDb(null);
  const result = await deduplicateAndMerge({ ...baseProspect }, 'sess-1', '@source1', db);
  assert.equal(result.action, 'insert');
  assert.deepEqual(result.prospect.sessionIds, ['sess-1']);
  assert.deepEqual(result.prospect.sourceUsernames, ['@source1']);
  assert.ok(result.prospect.firstSeenAt > 0);
  assert.ok(result.prospect.lastSeenAt > 0);
  assert.equal(result.prospect.status, 'new');
});

// ─── Skip (already followed / requested / rejected) ────────────────────────
test('deduplicateAndMerge: skips prospect with status=followed', async () => {
  const db = makeMockDb({ ...baseProspect, status:'followed', sessionIds:['s1'], sourceUsernames:['a'] });
  const result = await deduplicateAndMerge({ ...baseProspect }, 'sess-2', '@source2', db);
  assert.equal(result.action, 'skip');
});
test('deduplicateAndMerge: skips prospect with status=requested', async () => {
  const db = makeMockDb({ ...baseProspect, status:'requested', sessionIds:['s1'], sourceUsernames:['a'] });
  const result = await deduplicateAndMerge({ ...baseProspect }, 'sess-2', '@source2', db);
  assert.equal(result.action, 'skip');
});
test('deduplicateAndMerge: skips prospect with status=rejected', async () => {
  const db = makeMockDb({ ...baseProspect, status:'rejected', sessionIds:['s1'], sourceUsernames:['a'] });
  const result = await deduplicateAndMerge({ ...baseProspect }, 'sess-2', '@source2', db);
  assert.equal(result.action, 'skip');
});

// ─── Merge ─────────────────────────────────────────────────────────────────
test('deduplicateAndMerge: merges existing (new status) by union of sessionIds', async () => {
  const db = makeMockDb({ ...baseProspect, status:'new', sessionIds:['sess-1'], sourceUsernames:['@source1'], firstSeenAt:1000, lastSeenAt:1000 });
  const result = await deduplicateAndMerge({ ...baseProspect }, 'sess-2', '@source2', db);
  assert.equal(result.action, 'merge');
  assert.ok(result.prospect.sessionIds.includes('sess-1'));
  assert.ok(result.prospect.sessionIds.includes('sess-2'));
  assert.ok(result.prospect.sourceUsernames.includes('@source1'));
  assert.ok(result.prospect.sourceUsernames.includes('@source2'));
});
test('deduplicateAndMerge: merge deduplicates sessionIds (no duplicates)', async () => {
  const db = makeMockDb({ ...baseProspect, status:'new', sessionIds:['sess-1'], sourceUsernames:['@source1'], firstSeenAt:1000, lastSeenAt:1000 });
  const result = await deduplicateAndMerge({ ...baseProspect }, 'sess-1', '@source1', db);
  assert.equal(result.action, 'merge');
  assert.equal(result.prospect.sessionIds.length, 1);
  assert.equal(result.prospect.sourceUsernames.length, 1);
});
test('deduplicateAndMerge: merge updates sourceOverlap in scored breakdown', async () => {
  const db = makeMockDb({
    ...baseProspect, status:'new', sessionIds:['sess-1'], sourceUsernames:['@source1'], firstSeenAt:1000, lastSeenAt:1000,
    scored: { finalScore:60, breakdown:{ sourceOverlap:{ score:0, max:5, sourceCount:1 } } }
  });
  const result = await deduplicateAndMerge({ ...baseProspect }, 'sess-2', '@source2', db);
  assert.equal(result.action, 'merge');
  assert.ok(result.prospect.scored.breakdown.sourceOverlap.score > 0);
  assert.equal(result.prospect.scored.breakdown.sourceOverlap.sourceCount, 2);
});
test('deduplicateAndMerge: uses username (not pk) as lookup key', async () => {
  // Prospect has no .pk — should still find it by .username
  const db = makeMockDb({ ...baseProspect, status:'new', sessionIds:['s1'], sourceUsernames:['a'], firstSeenAt:1, lastSeenAt:1 });
  const prospect = { ...baseProspect }; // no .pk property
  delete prospect.pk;
  const result = await deduplicateAndMerge(prospect, 'sess-2', '@src2', db);
  assert.equal(result.action, 'merge');
});
