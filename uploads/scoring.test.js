import test from 'node:test';
import assert from 'node:assert/strict';
import { scorePostCount, scoreActivity, scoreProspect, generateExplanation, compareProspects } from '../src/engines/scoring.js';

const DEFAULT_SETTINGS = {
  weights: { femaleLikelihood:40, postCount:20, privateAccount:15, recentActivity:10, personalAccount:5, audienceRelevance:5, sourceOverlap:5 }
};

// ─── scorePostCount ────────────────────────────────────────────────────────
test('scorePostCount: <20 posts → score=0, tier=Excluded', () => {
  const r = scorePostCount(0,  20); assert.equal(r.score, 0);   assert.equal(r.tier, 'Excluded');
  const r2= scorePostCount(19, 20); assert.equal(r2.score, 0);  assert.equal(r2.tier, 'Excluded');
});
test('scorePostCount: 20-39 posts → 40% of max, tier=Qualified', () => {
  const r = scorePostCount(20, 20); assert.equal(r.score, 8);   assert.equal(r.tier, 'Qualified');
  const r2= scorePostCount(39, 20); assert.equal(r2.score, 8);
});
test('scorePostCount: 40-79 posts → 65% of max, tier=Strong', () => {
  const r = scorePostCount(40, 20); assert.equal(r.score, 13);  assert.equal(r.tier, 'Strong');
});
test('scorePostCount: 80-149 posts → 85%, tier=Very Strong', () => {
  const r = scorePostCount(80, 20); assert.equal(r.score, 17);  assert.equal(r.tier, 'Very Strong');
});
test('scorePostCount: 150-299 posts → 95%, tier=Very Strong', () => {
  const r = scorePostCount(150,20); assert.equal(r.score, 19);  assert.equal(r.tier, 'Very Strong');
});
test('scorePostCount: 300+ posts → 100%, tier=Strong (capped)', () => {
  const r = scorePostCount(300,20); assert.equal(r.score, 20);  assert.equal(r.tier, 'Strong (capped)');
  const r2= scorePostCount(999,20); assert.equal(r2.score, 20);
});

// ─── scoreActivity ─────────────────────────────────────────────────────────
test('scoreActivity: null enriched → score=0, level=Unknown', () => {
  const r = scoreActivity(null, 10);
  assert.equal(r.score, 0); assert.equal(r.level, 'Unknown');
});
test('scoreActivity: highlights>3 gives +3 points', () => {
  const r = scoreActivity({ highlight_reel_count:4, has_story:false, post_count:50, follower_count:500, biography:'', external_url:null }, 10);
  assert.ok(r.score > 0);
});
test('scoreActivity: has_story adds signal', () => {
  const r = scoreActivity({ highlight_reel_count:0, has_story:true, post_count:50, follower_count:500, biography:'', external_url:null }, 10);
  assert.ok(r.score > 0);
});
test('scoreActivity: empty bio + no highlights + no story → negative', () => {
  const r = scoreActivity({ highlight_reel_count:0, has_story:false, post_count:5, follower_count:1000, biography:'', external_url:null }, 10);
  assert.equal(r.score, 0); // clamped at 0
});
test('scoreActivity: high activity → level=High', () => {
  const r = scoreActivity({ highlight_reel_count:5, has_story:true, post_count:200, follower_count:500, biography:`${new Date().getFullYear()}`, external_url:'https://x.com' }, 10);
  assert.equal(r.level, 'High');
});

// ─── scoreProspect ─────────────────────────────────────────────────────────
const mockRaw = { username:'jane_doe', full_name:'Jane Doe', is_private:true, is_verified:false, follows_viewer:false, followed_by_viewer:false };
const mockEnriched = { post_count:147, follower_count:823, following_count:412, biography:'mom of 2 💕', external_url:null, highlight_reel_count:3, has_story:false, is_business_account:false, is_professional_account:false };
const mockClassification = { femaleScore:96, label:'high_priority', confidence:'high', signals:[] };

test('scoreProspect: private account gets full privateAccount points', () => {
  const r = scoreProspect(mockRaw, mockEnriched, mockClassification, DEFAULT_SETTINGS);
  assert.equal(r.breakdown.privateAccount.score, 15);
  assert.equal(r.breakdown.privateAccount.isPrivate, true);
});
test('scoreProspect: high femaleScore contributes to femaleLikelihood', () => {
  const r = scoreProspect(mockRaw, mockEnriched, mockClassification, DEFAULT_SETTINGS);
  assert.ok(r.breakdown.femaleLikelihood.score > 30);
});
test('scoreProspect: returns structured breakdown with all 7 dimensions', () => {
  const r = scoreProspect(mockRaw, mockEnriched, mockClassification, DEFAULT_SETTINGS);
  const keys = Object.keys(r.breakdown);
  assert.ok(keys.includes('femaleLikelihood'));
  assert.ok(keys.includes('postCount'));
  assert.ok(keys.includes('privateAccount'));
  assert.ok(keys.includes('recentActivity'));
  assert.ok(keys.includes('personalAccount'));
  assert.ok(keys.includes('audienceRelevance'));
  assert.ok(keys.includes('sourceOverlap'));
});
test('scoreProspect: finalScore is integer, priorityLabel is string', () => {
  const r = scoreProspect(mockRaw, mockEnriched, mockClassification, DEFAULT_SETTINGS);
  assert.equal(typeof r.finalScore, 'number');
  assert.equal(r.finalScore, Math.round(r.finalScore));
  assert.ok(['🔥 High Priority','✅ Qualified','👁 Review'].includes(r.priorityLabel));
});
test('scoreProspect: source overlap scales with sourceCount', () => {
  const r1 = scoreProspect(mockRaw, mockEnriched, mockClassification, DEFAULT_SETTINGS, 1);
  const r2 = scoreProspect(mockRaw, mockEnriched, mockClassification, DEFAULT_SETTINGS, 4);
  assert.ok(r2.breakdown.sourceOverlap.score > r1.breakdown.sourceOverlap.score);
});
test('scoreProspect: non-private account gets 0 privateAccount score', () => {
  const r = scoreProspect({ ...mockRaw, is_private:false }, mockEnriched, mockClassification, DEFAULT_SETTINGS);
  assert.equal(r.breakdown.privateAccount.score, 0);
});
test('scoreProspect: follows_viewer adds audienceRelevance', () => {
  const r = scoreProspect({ ...mockRaw, follows_viewer:true }, mockEnriched, mockClassification, DEFAULT_SETTINGS);
  assert.ok(r.breakdown.audienceRelevance.score > 0);
});

// ─── compareProspects ──────────────────────────────────────────────────────
test('compareProspects: female score diff >15 dominates', () => {
  const a = { classification:{ femaleScore:90 }, scored:{ finalScore:60 } };
  const b = { classification:{ femaleScore:50 }, scored:{ finalScore:80 } };
  assert.ok(compareProspects(a, b) < 0); // a ranks first (higher femaleScore)
});
test('compareProspects: small female diff → sort by finalScore', () => {
  const a = { classification:{ femaleScore:90 }, scored:{ finalScore:80 } };
  const b = { classification:{ femaleScore:88 }, scored:{ finalScore:95 } };
  assert.ok(compareProspects(a, b) > 0); // b ranks first (higher finalScore)
});
