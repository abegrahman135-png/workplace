import test from 'node:test';
import assert from 'node:assert/strict';
import { qualifyTier1, qualifyTier2, classifyAccountType } from '../src/engines/qualification.js';

const DEFAULT_SETTINGS = {
  weights: { femaleLikelihood:40, postCount:20, privateAccount:15, recentActivity:10, personalAccount:5, audienceRelevance:5, sourceOverlap:5 },
  minFemaleScore: 85, minPosts: 20, excludeVerified: true, excludeBusinesses: true,
  maxFollowers: null, maxFollowing: null,
};

// ─── qualifyTier1 ──────────────────────────────────────────────────────────
// NOTE: qualifyTier1(raw, settings) — femaleScore is on raw object
test('qualifyTier1: passes clean high-score profile', () => {
  const raw = { femaleScore:90, is_verified:false, followed_by_viewer:false, requested_by_viewer:false };
  const r = qualifyTier1(raw, DEFAULT_SETTINGS);
  assert.equal(r.qualified, true);
  assert.equal(r.reason, null);
});
test('qualifyTier1: rejects low femaleScore below minFemaleScore', () => {
  const raw = { femaleScore:40, is_verified:false, followed_by_viewer:false, requested_by_viewer:false };
  const r = qualifyTier1(raw, DEFAULT_SETTINGS);
  assert.equal(r.qualified, false);
  assert.ok(r.reason !== null);
});
test('qualifyTier1: rejects already-following (followed_by_viewer=true)', () => {
  const raw = { femaleScore:90, is_verified:false, followed_by_viewer:true, requested_by_viewer:false };
  const r = qualifyTier1(raw, DEFAULT_SETTINGS);
  assert.equal(r.qualified, false);
  assert.ok(r.reason.toLowerCase().includes('follow'));
});
test('qualifyTier1: rejects already-requested (requested_by_viewer=true)', () => {
  const raw = { femaleScore:90, is_verified:false, followed_by_viewer:false, requested_by_viewer:true };
  const r = qualifyTier1(raw, DEFAULT_SETTINGS);
  assert.equal(r.qualified, false);
  assert.ok(r.reason.toLowerCase().includes('request'));
});
test('qualifyTier1: rejects verified account when excludeVerified=true', () => {
  const raw = { femaleScore:90, is_verified:true, followed_by_viewer:false, requested_by_viewer:false };
  const r = qualifyTier1(raw, DEFAULT_SETTINGS);
  assert.equal(r.qualified, false);
  assert.ok(r.reason.toLowerCase().includes('verif'));
});
test('qualifyTier1: allows verified account when excludeVerified=false', () => {
  const raw = { femaleScore:90, is_verified:true, followed_by_viewer:false, requested_by_viewer:false };
  const settings = { ...DEFAULT_SETTINGS, excludeVerified:false };
  const r = qualifyTier1(raw, settings);
  assert.equal(r.qualified, true);
});
test('qualifyTier1: boundary — femaleScore exactly at minFemaleScore passes', () => {
  const raw = { femaleScore:85, is_verified:false, followed_by_viewer:false, requested_by_viewer:false };
  // minFemaleScore=85, score=85: 85 < 85 is false → should pass
  const r = qualifyTier1(raw, DEFAULT_SETTINGS);
  assert.equal(r.qualified, true);
});
test('qualifyTier1: boundary — femaleScore one below minFemaleScore fails', () => {
  const raw = { femaleScore:84, is_verified:false, followed_by_viewer:false, requested_by_viewer:false };
  const r = qualifyTier1(raw, DEFAULT_SETTINGS);
  assert.equal(r.qualified, false);
});

// ─── qualifyTier2 ──────────────────────────────────────────────────────────
test('qualifyTier2: passes enriched profile with 30 posts non-business', () => {
  const enriched = { post_count:30, is_business_account:false, follower_count:500, following_count:300 };
  const r = qualifyTier2(enriched, DEFAULT_SETTINGS);
  assert.equal(r.qualified, true);
});
test('qualifyTier2: rejects post_count < minPosts (19 < 20)', () => {
  const enriched = { post_count:19, is_business_account:false, follower_count:500, following_count:300 };
  const r = qualifyTier2(enriched, DEFAULT_SETTINGS);
  assert.equal(r.qualified, false);
  assert.ok(r.reason !== null);
});
test('qualifyTier2: boundary — exactly minPosts=20 passes', () => {
  const enriched = { post_count:20, is_business_account:false, follower_count:500, following_count:300 };
  const r = qualifyTier2(enriched, DEFAULT_SETTINGS);
  assert.equal(r.qualified, true);
});
test('qualifyTier2: rejects business account when excludeBusinesses=true', () => {
  const enriched = { post_count:50, is_business_account:true, follower_count:500, following_count:300 };
  const r = qualifyTier2(enriched, DEFAULT_SETTINGS);
  assert.equal(r.qualified, false);
  assert.ok(r.reason.toLowerCase().includes('business'));
});
test('qualifyTier2: allows business account when excludeBusinesses=false', () => {
  const enriched = { post_count:50, is_business_account:true, follower_count:500, following_count:300 };
  const settings = { ...DEFAULT_SETTINGS, excludeBusinesses:false };
  const r = qualifyTier2(enriched, settings);
  assert.equal(r.qualified, true);
});
test('qualifyTier2: adds warning for too many followers when maxFollowers set', () => {
  const enriched = { post_count:50, is_business_account:false, follower_count:200000, following_count:300 };
  const settings = { ...DEFAULT_SETTINGS, maxFollowers:10000 };
  const r = qualifyTier2(enriched, settings);
  // Still qualified (soft filter) but has warning
  assert.ok(Array.isArray(r.warnings));
  assert.ok(r.warnings.some(w => w.toLowerCase().includes('follower')));
});
test('qualifyTier2: maxFollowers=null skips follower count filter', () => {
  const enriched = { post_count:50, is_business_account:false, follower_count:999999, following_count:300 };
  const r = qualifyTier2(enriched, DEFAULT_SETTINGS);
  assert.equal(r.qualified, true);
  assert.deepEqual(r.warnings, []);
});

// ─── classifyAccountType ───────────────────────────────────────────────────
test('classifyAccountType: is_business_account → Business', () => {
  const enriched = { is_business_account:true, is_verified:false, follower_count:1000, biography:'' };
  assert.equal(classifyAccountType(enriched), 'Business');
});
test('classifyAccountType: is_verified → Public Figure', () => {
  const enriched = { is_business_account:false, is_verified:true, follower_count:500000, biography:'' };
  assert.equal(classifyAccountType(enriched), 'Public Figure');
});
test('classifyAccountType: neither → Personal', () => {
  const enriched = { is_business_account:false, is_verified:false, follower_count:500, biography:'just a girl' };
  assert.equal(classifyAccountType(enriched), 'Personal');
});
