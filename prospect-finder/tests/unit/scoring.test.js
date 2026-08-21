import '../helpers/env.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { scoreProspect, compareProspects } from '../../src/engines/scoring.js';
import { DEFAULT_SETTINGS } from '../../src/lib/constants.js';

const S = DEFAULT_SETTINGS;
const femaleEv = { female: { value: 95, confidence: 0.9, verdict: 'likely_female' } };
const unknownEv = { female: { value: 50, confidence: 0, verdict: 'unknown' } };

describe('scoring', () => {
  test('is bounded to 0..100 for random inputs (property test)', () => {
    for (let i = 0; i < 5000; i++) {
      const metrics = {
        posts: Math.floor(Math.random() * 3000),
        followers: Math.floor(Math.random() * 200000),
        following: Math.floor(Math.random() * 9000),
      };
      const ev = Math.random() > .5 ? femaleEv : unknownEv;
      const enr = { is_business_account: Math.random() > .8, is_verified: Math.random() > .9 };
      const r = scoreProspect(metrics, ev, enr, S);
      assert.ok(r.finalScore >= 0 && r.finalScore <= 100, `out of range: ${r.finalScore}`);
    }
  });

  test('is pure — same input, same output, no mutation', () => {
    const metrics = { posts: 120, followers: 800, following: 400 };
    const frozen = JSON.stringify(metrics);
    const a = scoreProspect(metrics, femaleEv, {}, S);
    const b = scoreProspect(metrics, femaleEv, {}, S);
    assert.deepEqual(a, b);
    assert.equal(JSON.stringify(metrics), frozen, 'input must not be mutated');
  });

  test('zero posts can never be high priority', () => {
    const r = scoreProspect({ posts: 0, followers: 5000, following: 500 }, femaleEv, {}, S);
    assert.equal(r.finalScore, 0);
    assert.equal(r.label, 'excluded');
  });

  test('confident-male suppresses but does not erase', () => {
    const male = { female: { value: 5, confidence: 0.95, verdict: 'likely_male' } };
    const r = scoreProspect({ posts: 200, followers: 900, following: 500 }, male, {}, S);
    assert.ok(r.finalScore > 0, 'still visible');
    assert.ok(r.finalScore < 30, 'but heavily suppressed');
  });

  test('unknown gender is NOT penalised', () => {
    const m = { posts: 200, followers: 900, following: 500 };
    const known = scoreProspect(m, femaleEv, {}, S);
    const unk = scoreProspect(m, unknownEv, {}, S);
    assert.equal(known.finalScore, unk.finalScore, 'unknown must not be punished');
  });

  test('ideal personal account lands high', () => {
    const r = scoreProspect({ posts: 250, followers: 1200, following: 600 }, femaleEv, { is_private: true }, S);
    assert.ok(r.finalScore >= 70, `expected high priority, got ${r.finalScore}`);
    assert.equal(r.label, 'high_priority');
  });

  test('manual boost sorts first', () => {
    const rows = [
      { finalScore: 95, manualPriority: false, lastSeenAt: 1 },
      { finalScore: 20, manualPriority: true, lastSeenAt: 1 },
    ];
    rows.sort(compareProspects);
    assert.equal(rows[0].finalScore, 20);
  });
});
