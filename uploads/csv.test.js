import test from 'node:test';
import assert from 'node:assert/strict';
import { prospectsToCsv } from '../src/csv.js';
import { parseCsv } from '../src/import.js';

test('escapes commas, quotes, and newlines in CSV export', () => {
  const csv = prospectsToCsv([{
    username: 'jane',
    fullName: 'Jane, Doe',
    biography: 'Says "hello"\nand goodbye',
    sourceUsernames: ['one', 'two'],
    score: { finalScore: 88, priorityLabel: 'High Priority' },
  }]);
  assert.match(csv, /"Jane, Doe"/);
  assert.match(csv, /"Says ""hello"" and goodbye"/);
  assert.match(csv, /one;two/);
});

test('parses basic imported CSV data', () => {
  const records = parseCsv('username,post_count,is_private\njane,42,true');
  assert.equal(records.length, 1);
  assert.equal(records[0].username, 'jane');
  assert.equal(records[0].postCount, 42);
});
