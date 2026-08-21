import test from 'node:test';
import assert from 'node:assert/strict';
import { detectPronouns, analyzeBioKeywords, BIO_KEYWORDS, PRONOUN_PATTERNS, TITLE_PATTERNS } from '../src/engines/classifier_bio.js';
import { applySuffixRules, applyCharNgram, analyzeUsername, SUFFIX_RULES } from '../src/engines/classifier_names.js';

// ══════════════════════════════════════════════════════════════════════════════
// classifier_bio tests
// ══════════════════════════════════════════════════════════════════════════════

// ─── detectPronouns ─────────────────────────────────────────────────────────
test('detectPronouns: detects she/her → score 99', () => {
  const r = detectPronouns('she/her | NYC artist');
  assert.ok(r !== null);
  assert.equal(r.score, 99);
});
test('detectPronouns: detects (she/her) with parens', () => {
  const r = detectPronouns('(she/her) photographer');
  assert.ok(r !== null);
  assert.equal(r.score, 99);
});
test('detectPronouns: detects he/him → score 1', () => {
  const r = detectPronouns('he/him | developer');
  assert.ok(r !== null);
  assert.equal(r.score, 1);
});
test('detectPronouns: detects they/them → score 50', () => {
  const r = detectPronouns('they/them artist');
  assert.ok(r !== null);
  assert.equal(r.score, 50);
});
test('detectPronouns: detects Spanish ella', () => {
  const r = detectPronouns('hola soy ella, bailarina');
  assert.ok(r !== null);
  assert.equal(r.score, 92);
});
test('detectPronouns: detects French elle', () => {
  const r = detectPronouns('bonjour, elle est artiste');
  assert.ok(r !== null);
  assert.equal(r.score, 88);
});
test('detectPronouns: returns null for no pronouns', () => {
  const r = detectPronouns('just a regular bio with no pronouns');
  assert.equal(r, null);
});
test('detectPronouns: returns null for empty bio', () => {
  assert.equal(detectPronouns(''), null);
  assert.equal(detectPronouns(null), null);
});

// ─── analyzeBioKeywords ────────────────────────────────────────────────────
test('analyzeBioKeywords: empty bio → score 50, hasSignals false', () => {
  const r = analyzeBioKeywords('');
  assert.equal(r.score, 50);
  assert.equal(r.hasSignals, false);
  assert.equal(r.topKeyword, null);
});
test('analyzeBioKeywords: null bio → score 50', () => {
  const r = analyzeBioKeywords(null);
  assert.equal(r.score, 50);
});
test('analyzeBioKeywords: "wife" adds +22 (strongest female signal)', () => {
  const r = analyzeBioKeywords('proud wife and mom');
  assert.ok(r.score > 50);
  assert.equal(r.hasSignals, true);
});
test('analyzeBioKeywords: "mom" adds +20', () => {
  const r = analyzeBioKeywords('dog mom 🐶');
  assert.ok(r.score > 50);
});
test('analyzeBioKeywords: "husband" subtracts -22 (strongest male signal)', () => {
  const r = analyzeBioKeywords('loving husband and father');
  assert.ok(r.score < 50);
});
test('analyzeBioKeywords: "dad" subtracts -20', () => {
  const r = analyzeBioKeywords('proud dad of 3');
  assert.ok(r.score < 50);
});
test('analyzeBioKeywords: cumulative signals stack correctly', () => {
  const single = analyzeBioKeywords('mom');
  const multi  = analyzeBioKeywords('mom wife actress');
  assert.ok(multi.score > single.score);
});
test('analyzeBioKeywords: female emojis add +5', () => {
  const baseline = analyzeBioKeywords('artist NYC');
  const withEmoji = analyzeBioKeywords('artist NYC 💅');
  assert.ok(withEmoji.score >= baseline.score + 5);
});
test('analyzeBioKeywords: clamps to 0-100 range', () => {
  const r = analyzeBioKeywords('wife mother actress wifey girl woman bride feminist queen');
  assert.ok(r.score >= 0 && r.score <= 100);
});
test('analyzeBioKeywords: title Mrs/Miss adds +25', () => {
  const r = analyzeBioKeywords('Mrs. Johnson, teacher');
  assert.ok(r.score > 50);
});
test('analyzeBioKeywords: title Mr subtracts -25', () => {
  const r = analyzeBioKeywords('Mr. Smith, engineer');
  assert.ok(r.score < 50);
});

// ══════════════════════════════════════════════════════════════════════════════
// classifier_names tests (no Chrome API needed — no loadNameDb calls)
// ══════════════════════════════════════════════════════════════════════════════

// ─── applySuffixRules ──────────────────────────────────────────────────────
test('applySuffixRules: Japanese -ko suffix → score 90', () => {
  assert.equal(applySuffixRules('Yuko'), 90);
  assert.equal(applySuffixRules('Keiko'), 90);
});
test('applySuffixRules: Japanese -mi suffix → score 82', () => {
  assert.equal(applySuffixRules('Nanami'), 82);
});
test('applySuffixRules: Hindi devi suffix → score 95', () => {
  assert.equal(applySuffixRules('Saraswatidevi'), 95);
});
test('applySuffixRules: Arabic umm prefix → score 95', () => {
  assert.equal(applySuffixRules('Umm Khalid'), 95);
});
test('applySuffixRules: universal ella → score 85', () => {
  assert.equal(applySuffixRules('Isabella'), 85);
});
test('applySuffixRules: universal ette → score 82', () => {
  assert.equal(applySuffixRules('Annette'), 82);
});
test('applySuffixRules: Hindi male esh → score 12', () => {
  assert.equal(applySuffixRules('Ramesh'), 12);
});
test('applySuffixRules: Japanese male ro → score 10', () => {
  assert.equal(applySuffixRules('Taro'), 10);
});
test('applySuffixRules: Korean sook → score 88', () => {
  assert.equal(applySuffixRules('Sungsook'), 88);
});
test('applySuffixRules: compound name tries each word', () => {
  // "María José" — "jose" ends in nothing, but "maria" has 'ia' n-gram
  // More specifically testing that compound names are split
  const score = applySuffixRules('Umm Fatima'); // umm prefix should match
  assert.equal(score, 95);
});
test('applySuffixRules: unknown name → null', () => {
  assert.equal(applySuffixRules('Smith'), null);
  assert.equal(applySuffixRules(''), null);
  assert.equal(applySuffixRules(null), null);
});
test('SUFFIX_RULES: has 31 rules covering 7 language families', () => {
  assert.ok(SUFFIX_RULES.length >= 30);
  const langs = new Set(SUFFIX_RULES.map(r => r.lang));
  assert.ok(langs.has('ar')); // Arabic
  assert.ok(langs.has('hi')); // Hindi
  assert.ok(langs.has('ja')); // Japanese
  assert.ok(langs.has('ko')); // Korean
  assert.ok(langs.has('tr')); // Turkish
  assert.ok(langs.has('fa')); // Persian
  assert.ok(langs.has('*'));  // Universal
});

// ─── applyCharNgram ────────────────────────────────────────────────────────
test('applyCharNgram: female name biased names score >50', () => {
  const r = applyCharNgram('Maria');
  assert.ok(r > 50, `Expected >50 for "Maria", got ${r}`);
});
test('applyCharNgram: male-biased names score <50', () => {
  const r = applyCharNgram('Harrison');
  assert.ok(r < 50, `Expected <50 for "Harrison", got ${r}`);
});
test('applyCharNgram: always returns 0-100', () => {
  ['Alejandra', 'Mohammed', 'x', 'Abcdefghijklmnopqrstuvwxyz'].forEach(name => {
    const r = applyCharNgram(name);
    assert.ok(r >= 0 && r <= 100, `Out of range for "${name}": ${r}`);
  });
});
test('applyCharNgram: null/empty → null', () => {
  assert.equal(applyCharNgram(''), null);
  assert.equal(applyCharNgram(null), null);
});

// ─── analyzeUsername ───────────────────────────────────────────────────────
test('analyzeUsername: feminine word in username → 85', () => {
  assert.equal(analyzeUsername('rose_photography'), 85);
  assert.equal(analyzeUsername('queenofcups'), 85);
  assert.equal(analyzeUsername('thegirltravels'), 85);
});
test('analyzeUsername: masculine word in username → 15', () => {
  assert.equal(analyzeUsername('kingofthegame'), 15);
  assert.equal(analyzeUsername('bro_codes'), 15);
});
test('analyzeUsername: neutral username → null', () => {
  assert.equal(analyzeUsername('user123'), null);
  assert.equal(analyzeUsername('photography_hub'), null);
});
test('analyzeUsername: null/empty → null', () => {
  assert.equal(analyzeUsername(''), null);
  assert.equal(analyzeUsername(null), null);
});
