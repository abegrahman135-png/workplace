import test from 'node:test';
import assert from 'node:assert/strict';
import { deduplicateProspects, normalizeProspect, qualifyProspect, rankProspects, scoreProspect } from '../src/models.js';

const base = {
  username: 'Jane.Doe',
  fullName: 'Jane Doe',
  postCount: 120,
  followerCount: 850,
  followingCount: 410,
  isPrivate: true,
  mutualCount: 3,
  activityLevel: 'high',
  sourceUsernames: ['source-a', 'source-b'],
};

test('normalizes identity and numeric fields', () => {
  const record = normalizeProspect({ username: '@Jane.Doe', post_count: '42' });
  assert.equal(record.username, 'jane.doe');
  assert.equal(record.postCount, 42);
});

test('qualifies records using configured hard filters', () => {
  assert.equal(qualifyProspect(base).qualified, true);
  const result = qualifyProspect({ ...base, postCount: 19 });
  assert.equal(result.qualified, false);
  assert.deepEqual(result.failures, ['Fewer than 20 posts']);
});

test('scores strong non-sensitive signals highly', () => {
  const scored = scoreProspect(base);
  assert.equal(scored.qualification.qualified, true);
  assert.ok(scored.score.finalScore >= 70);
  assert.ok(scored.score.reasons.includes('Private account'));
});

test('deduplicates case-insensitively and merges source overlap', () => {
  const records = deduplicateProspects([
    { ...base, username: 'SameUser', sourceUsernames: ['one'], postCount: 30 },
    { ...base, username: '@sameuser', sourceUsernames: ['two'], postCount: 80 },
  ]);
  assert.equal(records.length, 1);
  assert.equal(records[0].postCount, 80);
  assert.deepEqual(records[0].sourceUsernames.sort(), ['one', 'two']);
});

test('ranks qualified records before excluded records', () => {
  const ranked = rankProspects([
    { ...base, username: 'excluded', postCount: 1 },
    { ...base, username: 'qualified' },
  ]);
  assert.equal(ranked[0].username, 'qualified');
  assert.equal(ranked[1].score.priorityLabel, 'Excluded');
});
