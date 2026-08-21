/**
 * gender_layers.test.js — multi-layer gender detection.
 *
 * Regression corpus taken from real dashboard screenshots where obviously-male
 * profiles sat in High Priority at 87-94 with an "Unknown" verdict:
 *   سلمان صاقب (94), Syed Roushan Ferdous (94), Faisal Alam Joy (89),
 *   Tawhid Ahmmed (87)
 *
 * Root cause: nameSignals() only inspected the FIRST token of full_name, so
 * names where the given name is second/third, written in Arabic script, or
 * only present in the handle produced ZERO signal → verdict `unknown` →
 * skipped the male gate → ranked on follower counts alone.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { nameSignals, _setDict, analyzeUsername, SURNAMES, MALE_MARKERS } =
  await import('../../src/engines/classifier/names.js');
const { combine } = await import('../../src/engines/classifier/evidence.js');
const { bioSignals } = await import('../../src/engines/classifier/bio.js');
const { shouldRunVisual } = await import('../../src/engines/classifier/visual.js');
const { scoreProspect } = await import('../../src/engines/scoring.js');
const { DEFAULT_SETTINGS } = await import('../../src/lib/constants.js');

const names = JSON.parse(readFileSync(join(process.cwd(), 'public', 'data', 'names.json'), 'utf8'));
_setDict(Object.entries(names));

const verdictOf = (username, fullName, bio = '') =>
  combine([...nameSignals({ username, fullName }), ...bioSignals(bio)]);

const scoreOf = (username, fullName, bio, m) => {
  const ev = verdictOf(username, fullName, bio);
  return scoreProspect(m, { female: ev },
    { post_count: m.posts, is_business_account: false, is_verified: false },
    DEFAULT_SETTINGS);
};

test('layer 1 — dictionary scans every name token', async (t) => {
  await t.test('given name in second position is found', () => {
    const ev = verdictOf('ferdous_shukh', 'Syed Roushan Ferdous');
    assert.equal(ev.verdict, 'likely_male');
    assert.ok(ev.confidence >= 0.55, `conf ${ev.confidence}`);
  });

  await t.test('given name in first position still wins over a surname', () => {
    const ev = verdictOf('x', 'Tasnim Rahman');
    assert.notEqual(ev.verdict, 'likely_male', 'female given name must not be overridden by surname');
  });

  await t.test('unisex surnames carry no gender signal', () => {
    for (const sn of ['rahman', 'islam', 'khan', 'ahmed', 'chowdhury']) {
      assert.equal(names[sn], undefined, `${sn} must not be in the dictionary`);
    }
  });
});

test('layer 2 — honorifics and markers', async (t) => {
  await t.test('male honorific is recognised', () => {
    assert.ok(MALE_MARKERS.has('syed') && MALE_MARKERS.has('md'));
    const ev = verdictOf('x', 'Md Shakil Ahmed');
    assert.equal(ev.verdict, 'likely_male');
  });

  await t.test('female marker is recognised', () => {
    const ev = verdictOf('x', 'Mst Rokeya Begum');
    assert.equal(ev.verdict, 'likely_female');
  });
});

test('layer 3 — Arabic script', async (t) => {
  await t.test('Arabic male name is classified', () => {
    const ev = verdictOf('salmansaqif', 'سلمان صاقب');
    assert.equal(ev.verdict, 'likely_male');
    assert.ok(ev.confidence >= 0.7);
  });

  await t.test('Arabic female name is classified', () => {
    const ev = verdictOf('x', 'فاطمة');
    assert.equal(ev.verdict, 'likely_female');
  });
});

test('layer 4 — username analysis', async (t) => {
  await t.test('name in the handle when full_name is empty', () => {
    const ev = verdictOf('faisal_alam_joy__', '');
    assert.equal(ev.verdict, 'likely_male');
  });

  await t.test('embedded name inside a concatenated handle', () => {
    const r = analyzeUsername('tanvirahmed');
    assert.ok(r && r.score < 40, JSON.stringify(r));
  });

  await t.test('short tokens do not produce spurious matches', () => {
    assert.equal(analyzeUsername('ab.cd'), null);
  });
});

test('layer 5 — visual pass targets uncertainty only', async (t) => {
  const on = { ...DEFAULT_SETTINGS, enableVisualClassifier: true, visualFastLaneOnly: false };

  await t.test('runs when text evidence is unknown', () => {
    assert.equal(shouldRunVisual({ verdict: 'unknown', confidence: 0 }, on, 'normal'), true);
  });

  await t.test('runs when ambiguous', () => {
    assert.equal(shouldRunVisual({ verdict: 'ambiguous', confidence: 0.4 }, on, 'normal'), true);
  });

  await t.test('skips profiles already decided with high confidence', () => {
    assert.equal(shouldRunVisual({ verdict: 'likely_female', confidence: 0.95 }, on, 'normal'), false);
  });

  await t.test('never runs when disabled', () => {
    // DEFAULT_SETTINGS now ENABLES this layer (the weights ship in the build),
    // so construct an explicitly-disabled settings object.
    const off = { ...DEFAULT_SETTINGS, enableVisualClassifier: false };
    assert.equal(shouldRunVisual({ verdict: 'unknown', confidence: 0 }, off, 'fast'), false);
  });
});

test('scoring gate — males leave High Priority', async (t) => {
  // Real metrics from the screenshots.
  const CASES = [
    ['salmansaqif', 'سلمان صاقب', '', { posts: 233, followers: 641, following: 646 }],
    ['ferdous_shukh', 'Syed Roushan Ferdous', '', { posts: 295, followers: 677, following: 704 }],
    ['faisal_alam_joy__', '', '', { posts: 242, followers: 162, following: 935 }],
    ['_ta.hi._', 'Tawhid Ahmmed', '', { posts: 402, followers: 465, following: 312 }],
  ];

  await t.test('every screenshot male is excluded from high priority', () => {
    for (const [u, f, b, m] of CASES) {
      const sc = scoreOf(u, f, b, m);
      assert.notEqual(sc.label, 'high_priority', `${f || u} still high priority (${sc.finalScore})`);
      assert.ok(sc.finalScore < 45, `${f || u} scored ${sc.finalScore}`);
    }
  });

  await t.test('women are unaffected', () => {
    const sc = scoreOf('sadia.rahman', 'Sadia Rahman', 'photographer she/her',
      { posts: 233, followers: 641, following: 646 });
    assert.equal(sc.label, 'high_priority');
    assert.ok(sc.finalScore >= 70);
  });

  await t.test('excluded profiles are kept, never deleted', () => {
    const sc = scoreOf('_ta.hi._', 'Tawhid Ahmmed', '', { posts: 402, followers: 465, following: 312 });
    assert.equal(sc.label, 'excluded');
    assert.ok(sc.reasons.some(r => /male/i.test(r)), 'reason explains the exclusion');
  });
});

test('no false exclusions across a female corpus', () => {
  const FEMALE = [
    ['sadia.rahman', 'Sadia Rahman'], ['x', 'Nusrat Jahan'], ['x', 'Fatema Akter'],
    ['x', 'Ayesha Siddiqua'], ['x', 'Tanjila Islam'], ['x', 'Rumana Haque'],
    ['x', 'Mst Rokeya Begum'], ['x', 'Farhana Yasmin'], ['x', 'Sharmin Sultana'],
    ['x', 'Umme Habiba'], ['x', 'Emma Wilson'], ['x', 'Priya Sharma'],
    ['neehabaae', 'Neeha Kazi'], ['x', 'Tasnim Rahman'], ['x', 'Nabila Islam'],
    ['x', 'Sumaiya Akter'], ['x', 'Maria Garcia'], ['x', 'Aisha Khan'],
  ];
  const wrong = [];
  for (const [u, f] of FEMALE) {
    const ev = verdictOf(u, f);
    if (ev.verdict === 'likely_male' && ev.confidence >= 0.55) wrong.push(f);
  }
  assert.deepEqual(wrong, [], `women wrongly classified male: ${wrong.join(', ')}`);
});
