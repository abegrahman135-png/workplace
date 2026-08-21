import test from 'node:test';
import assert from 'node:assert/strict';
import { addHistory } from '../src/backup.js';
import { sortRecords } from '../src/dashboard-view.js';

test('records immutable activity history entries', () => {
  const state = { history: [], prospects: [] };
  const next = addHistory(state, 'import', 'Imported 2 records');
  assert.equal(state.history.length, 0);
  assert.equal(next.history.length, 1);
  assert.equal(next.history[0].type, 'import');
});

test('limits persisted history to 200 entries', () => {
  let state = { history: [], prospects: [] };
  for (let index = 0; index < 205; index += 1) state = addHistory(state, 'test', `Entry ${index}`);
  assert.equal(state.history.length, 200);
  assert.equal(state.history[0].message, 'Entry 204');
});

test('sorts ranked records by score and name', () => {
  const records = [
    { username: 'z', fullName: 'Zed', firstSeenAt: 1, score: { finalScore: 20 } },
    { username: 'a', fullName: 'Alpha', firstSeenAt: 2, score: { finalScore: 90 } },
  ];
  assert.deepEqual(sortRecords(records, 'score-desc').map(item => item.username), ['a', 'z']);
  assert.deepEqual(sortRecords(records, 'name-asc').map(item => item.username), ['a', 'z']);
  assert.deepEqual(sortRecords(records, 'oldest').map(item => item.username), ['z', 'a']);
});
