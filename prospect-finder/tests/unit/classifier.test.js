import '../helpers/env.js';
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadNameDb, classifyTier1 } from '../../src/engines/classifier/index.js';
import { analyzeUsername, lookupName } from '../../src/engines/classifier/names.js';
import { combine, verdictFor } from '../../src/engines/classifier/evidence.js';
import { detectPronouns, analyzeBioKeywords, detectTaken } from '../../src/engines/classifier/bio.js';

before(async () => { await loadNameDb(); });

describe('names', () => {
  test('v1 BUG: substring match made rehmanna/salmanaz read as male', () => {
    // 'man' is in the male token list; v1 used includes() so these all hit.
    assert.equal(analyzeUsername('rehmanna')?.token, undefined);
    assert.equal(analyzeUsername('womanpower')?.score, undefined);
    // 'salmanaz' now resolves via the anchored embedded scan to the FEMALE
    // name 'salma'. The point of this test is that it must never read male.
    assert.ok((analyzeUsername('salmanaz')?.score ?? 50) > 50);
    // Whole tokens still match correctly:
    assert.equal(analyzeUsername('the_man_official').score, 10);
    assert.equal(analyzeUsername('queen.vibes').score, 88);
  });

  test('dictionary lookup is case/diacritic tolerant', () => {
    assert.equal(lookupName('Sadia').score, 96);
    assert.equal(lookupName('RANA').score, 4);
    assert.equal(lookupName('  fatema  ').score, 96);
  });
});

describe('evidence', () => {
  test('no signals => unknown, NOT a rejection', () => {
    const e = combine([]);
    assert.equal(e.value, 50);
    assert.equal(e.confidence, 0);
    assert.equal(e.verdict, 'unknown');
  });

  test('unknown never passes as male or female', () => {
    assert.equal(verdictFor(50, 0), 'unknown');
    assert.equal(verdictFor(90, 0.2), 'unknown');   // high value, low confidence
    assert.equal(verdictFor(90, 0.9), 'likely_female');
  });

  test('pronouns outweigh a weak username signal', () => {
    const e = combine([
      { source: 'username', value: 10, confidence: 0.55 },
      { source: 'pronouns', value: 97, confidence: 1 },
    ]);
    assert.ok(e.value > 75, `expected pronoun dominance, got ${e.value}`);
    assert.equal(e.verdict, 'likely_female');
  });

  test('confidence rises as signals accumulate', () => {
    const one = combine([{ source: 'nameNgram', value: 70, confidence: 0.6 }]);
    const many = combine([
      { source: 'nameExact', value: 96, confidence: 1 },
      { source: 'pronouns', value: 97, confidence: 1 },
    ]);
    assert.ok(many.confidence > one.confidence);
  });
});

describe('bio', () => {
  test('pronoun detection', () => {
    assert.equal(detectPronouns('photographer | she/her | dhaka').label, 'she/her');
    assert.equal(detectPronouns('he/him, engineer').label, 'he/him');
    assert.equal(detectPronouns('no pronouns here'), null);
  });

  test('keyword analysis uses word boundaries', () => {
    // 'man' must not fire inside 'management'
    const r = analyzeBioKeywords('management consultant');
    assert.ok(!r || r.top !== 'man');
  });

  test('taken markers', () => {
    assert.equal(detectTaken('happily married 💍'), true);
    assert.equal(detectTaken('travel + coffee'), false);
  });
});

describe('tier1', () => {
  test('unknown foreign names survive with unknown verdict', () => {
    const e = classifyTier1({ username: 'zsofia_k', full_name: 'Zsófia Kovács' });
    assert.ok(['unknown', 'ambiguous', 'likely_female'].includes(e.female.verdict));
    // The important part: this profile is NOT marked male and NOT dropped.
    assert.notEqual(e.female.verdict, 'likely_male');
  });

  test('known female name is confident', () => {
    const e = classifyTier1({ username: 'sadia_rh', full_name: 'Sadia Rahman' });
    assert.equal(e.female.verdict, 'likely_female');
    assert.ok(e.female.confidence >= 0.6);
  });
});
