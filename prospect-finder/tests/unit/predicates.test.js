import '../helpers/env.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildMatcher, evalCondition, OPS } from '../../src/search/predicates.js';
import { parseShorthand } from '../../src/search/parse.js';

const p = {
  username: 'sadia_photo',
  raw: { full_name: 'Sadia Rahman', is_private: true },
  enriched: { biography: 'photographer she/her dhaka', is_private: true, full_name: 'Sadia Rahman' },
  metrics: { posts: 120, followers: 900, following: 450 },
  femaleScore: 92, femaleConfidence: 0.8,
  evidence: { female: { verdict: 'likely_female' } },
  finalScore: 78, label: 'high_priority', stage: 'scored', status: 'active',
  sourceUsernames: ['targetA', 'targetB'], sessionIds: ['s1'],
  firstSeenAt: Date.now() - 3600e3, lastSeenAt: Date.now(),
};

describe('predicates', () => {
  test('numeric ops', () => {
    assert.ok(evalCondition(p, { field: 'posts', op: 'gte', value: 100 }));
    assert.ok(!evalCondition(p, { field: 'posts', op: 'gt', value: 500 }));
    assert.ok(evalCondition(p, { field: 'followers', op: 'between', value: [100, 2000] }));
  });

  test('ratio is derived', () => {
    assert.ok(evalCondition(p, { field: 'ratio', op: 'gte', value: 2 }));
  });

  test('bio containsNone', () => {
    assert.ok(evalCondition(p, { field: 'bio', op: 'containsNone', value: ['married', 'engaged'] }));
    assert.ok(!evalCondition(p, { field: 'bio', op: 'containsNone', value: ['photographer'] }));
  });

  test('multi-source membership', () => {
    assert.ok(evalCondition(p, { field: 'sourceUsernames', op: 'containsAll', value: ['targetA'] }));
    assert.ok(evalCondition(p, { field: 'sourceCount', op: 'gte', value: 2 }));
  });

  test('time window', () => {
    assert.ok(evalCondition(p, { field: 'firstSeenAt', op: 'within', value: '1d' }));
    assert.ok(!evalCondition(p, { field: 'firstSeenAt', op: 'within', value: '5m' }));
  });

  test('AND/OR group logic', () => {
    const m = buildMatcher({
      group: {
        logic: 'OR',
        conditions: [
          { field: 'posts', op: 'gt', value: 9999 },
          { field: 'label', op: 'eq', value: 'high_priority' },
        ],
      },
    });
    assert.ok(m(p));
  });

  test('text search matches bio', () => {
    assert.ok(buildMatcher({ text: 'photographer' })(p));
    assert.ok(!buildMatcher({ text: 'plumbing' })(p));
  });
});

describe('shorthand', () => {
  test('parses mixed query', () => {
    const q = parseShorthand('private posts>50 @sadia !married coffee');
    assert.equal(q.text, 'coffee');
    assert.ok(q.filters.some(f => f.field === 'isPrivate' && f.value === true));
    assert.ok(q.filters.some(f => f.field === 'posts' && f.op === 'gt' && f.value === 50));
    assert.ok(q.filters.some(f => f.field === 'sourceUsernames'));
    assert.ok(q.filters.some(f => f.field === 'bio' && f.op === 'notContains'));
  });
});
