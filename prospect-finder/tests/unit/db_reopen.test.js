/**
 * The DB_VERSION 2->3 bump newly exercises the versionchange path: a second
 * context upgrading the schema closes our connection. The handler nulled
 * `_db` but left `_opening` resolved, so open() kept handing back a CLOSED
 * connection and every later read threw.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import '../helpers/env.js';

import { db, STORES } from '../../src/db/schema.js';

test('open() reconnects after another context triggers versionchange', async () => {
  await db.open();
  assert.ok(db._db);

  // Simulate Chrome firing versionchange because another tab is upgrading.
  db._db.onversionchange({});

  assert.strictEqual(db._db, null);
  // The cached promise must go too, otherwise open() resolves with a dead handle.
  assert.strictEqual(db._opening, null);

  const handle = await db.open();
  assert.ok(handle);

  // The real assertion: a read must actually work afterwards.
  const rows = await db.read([STORES.PROSPECTS], async (t) => t.store(STORES.PROSPECTS).getAll());
  assert.strictEqual(Array.isArray(rows), true);
});

test('a failed open does not poison future opens', async () => {
  await db.open();
  db.close();
  assert.strictEqual(db._opening, null);
  const again = await db.open();
  assert.ok(again);
});
