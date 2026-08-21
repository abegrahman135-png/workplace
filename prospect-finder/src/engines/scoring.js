/**
 * scoring.js — Pure, versioned, bounded scoring.
 *
 * v1 problems fixed here:
 *   - models.js mutated the prospect in place (impure, unrepeatable)
 *   - dedup injected a phantom `sourceOverlap` dimension and re-summed,
 *     pushing totals past 100 and reshuffling rank on every re-sighting
 *   - no version field, so a weight change required destroying all data
 *
 * Model: 100 base points from Posts(60) + Followers(25) + Following(15),
 * then MULTIPLICATIVE gates. Multiplication can only ever reduce, so the
 * total is mathematically incapable of exceeding 100.
 */

import { SCORE_VERSION, LABEL } from '../lib/constants.js';
import { fmtNum } from '../lib/utils.js';

export function scorePostCount(count, max) {
  if (count === 0)  return { score: 0,          tier: 'No posts' };
  if (count < 10)   return { score: max * 0.05, tier: 'Barely active' };
  if (count < 30)   return { score: max * 0.20, tier: 'Low' };
  if (count < 80)   return { score: max * 0.50, tier: 'Moderate' };
  if (count < 200)  return { score: max * 0.75, tier: 'Active' };
  if (count < 500)  return { score: max * 0.90, tier: 'Very active' };
  return              { score: max,             tier: 'Max' };
}

export function scoreFollowersQuality(count, max) {
  if (count === 0)     return { score: 0,          tier: 'No followers' };
  if (count < 20)      return { score: max * 0.05, tier: 'Ghost' };
  if (count < 50)      return { score: max * 0.15, tier: 'Very low' };
  if (count < 100)     return { score: max * 0.30, tier: 'Low' };
  if (count < 500)     return { score: max * 0.80, tier: 'Good' };
  if (count < 2000)    return { score: max,        tier: 'Sweet spot' };
  if (count < 10000)   return { score: max * 0.80, tier: 'Popular' };
  if (count < 50000)   return { score: max * 0.45, tier: 'Semi-public' };
  return                 { score: max * 0.10, tier: 'Too popular' };
}

export function scoreFollowingQuality(count, max) {
  if (count === 0)     return { score: 0,          tier: 'Follows nobody' };
  if (count < 20)      return { score: max * 0.05, tier: 'Very low' };
  if (count < 50)      return { score: max * 0.20, tier: 'Low' };
  if (count < 100)     return { score: max * 0.50, tier: 'Moderate' };
  if (count < 500)     return { score: max * 0.85, tier: 'Normal' };
  if (count < 1000)    return { score: max,        tier: 'Active social' };
  if (count < 3000)    return { score: max * 0.60, tier: 'High' };
  return                 { score: max * 0.20, tier: 'Mass-follow risk' };
}

/**
 * @param {object} metrics  {posts, followers, following}
 * @param {object} evidence {female:{value,confidence,verdict}, taken}
 * @param {object} enriched raw enriched profile (may be null)
 * @param {object} settings
 * @returns {object} immutable score result
 */
export function scoreProspect(metrics, evidence, enriched, settings) {
  const w = settings?.weights || { postCount: 60, followersQuality: 25, followingQuality: 15 };
  const posts = metrics?.posts ?? 0;
  const followers = metrics?.followers ?? 0;
  const following = metrics?.following ?? 0;

  const dims = {
    postCount:        { ...scorePostCount(posts, w.postCount), max: w.postCount, raw: posts },
    followersQuality: { ...scoreFollowersQuality(followers, w.followersQuality), max: w.followersQuality, raw: followers },
    followingQuality: { ...scoreFollowingQuality(following, w.followingQuality), max: w.followingQuality, raw: following },
  };

  const base = dims.postCount.score + dims.followersQuality.score + dims.followingQuality.score;

  const fem = evidence?.female || { value: 50, confidence: 0, verdict: 'unknown' };

  // Graduated male suppression. The old single threshold (likely_male AND
  // conf >= 0.7) let anything below it through UNGATED, so a male profile with
  // weak-but-real evidence ranked purely on follower counts and reached High
  // Priority. Now suppression scales with how male-leaning the evidence is.
  let femaleGate = 1;
  if (fem.verdict === 'likely_male') {
    femaleGate = fem.confidence >= 0.7 ? 0.05
               : fem.confidence >= 0.5 ? 0.15
               : 0.35;
  } else if (fem.verdict === 'ambiguous' && fem.value < 45) {
    femaleGate = 0.6;
  } else if (fem.verdict === 'unknown' && fem.value <= 35 && fem.confidence > 0) {
    // Male-leaning but under the confidence floor: hold it out of the top tier
    // without burying it, so the enrichment/visual layers can still promote it.
    femaleGate = 0.7;
  }

  const gates = {
    female: femaleGate,
    // Zero posts can never be high priority.
    posts: posts === 0 ? 0 : 1,
    business: (enriched?.is_business_account && settings?.excludeBusinesses) ? 0.4 : 1,
    verified: (enriched?.is_verified && settings?.excludeVerified) ? 0.5 : 1,
  };

  const multiplier = Object.values(gates).reduce((a, b) => a * b, 1);
  const finalScore = Math.max(0, Math.min(100, Math.round(base * multiplier)));

  // A confidently-male profile is EXCLUDED outright regardless of its metrics.
  // It is never deleted — the Excluded tab keeps it reviewable, and a later
  // visual/ML pass can overturn the call.
  const confidentMale = fem.verdict === 'likely_male' && fem.confidence >= 0.55;

  const label = confidentMale      ? LABEL.EXCLUDED
              : finalScore >= 70   ? LABEL.HIGH
              : finalScore >= 45   ? LABEL.QUALIFIED
              : finalScore > 0     ? LABEL.REVIEW
              : LABEL.EXCLUDED;

  return Object.freeze({
    finalScore,
    base: Math.round(base),
    dims,
    gates,
    multiplier,
    label,
    reasons: explain(dims, gates, fem),
    version: SCORE_VERSION,
  });
}

export function explain(dims, gates, fem) {
  const out = [];
  const p = dims.postCount, f = dims.followersQuality, g = dims.followingQuality;

  if (p.raw === 0) out.push('⚠️ 0 posts — cannot rank high');
  else out.push(`${p.raw.toLocaleString()} posts (${p.tier})`);

  if (f.raw === 0) out.push('⚠️ 0 followers — ghost account');
  else out.push(`${fmtNum(f.raw)} followers (${f.tier})`);

  if (g.raw > 0) out.push(`${fmtNum(g.raw)} following (${g.tier})`);

  if (gates.female <= 0.15) out.push('⛔ Excluded: classified male with high confidence');
  else if (gates.female < 1) out.push('↓ Suppressed: evidence leans male');
  if (gates.business < 1) out.push('↓ Suppressed: business account');
  if (gates.verified < 1) out.push('↓ Suppressed: verified account');
  if (fem.verdict === 'unknown') out.push('ℹ️ Gender unknown — needs review');

  return out;
}

/** Stable ranking: manual boost first, then score, then recency. */
export function compareProspects(a, b) {
  if (!!b.manualPriority !== !!a.manualPriority) return b.manualPriority ? 1 : -1;
  const d = (b.finalScore ?? -1) - (a.finalScore ?? -1);
  if (d) return d;
  return (b.lastSeenAt || 0) - (a.lastSeenAt || 0);
}
