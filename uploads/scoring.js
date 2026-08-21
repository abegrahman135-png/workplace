/**
 * scoring.js — Redesigned scoring engine
 *
 * ARCHITECTURE:
 *   Female + Private = hard gates (binary must-pass, contribute NO points)
 *   100 points come ONLY from: Posts (40) + Followers (35) + Following (25)
 *
 * This means lil.flower_05 (0 posts, 0 followers, 142 following)
 * scores: 0 + 0 + ~18 = 18 pts → Review (not High Priority)
 */

// ─── Post Count (40 pts max) ──────────────────────────────────────────────────
export function scorePostCount(count, maxPts) {
  if (count === 0)   return { score: 0,              tier: 'No Posts' };
  if (count < 10)    return { score: maxPts * 0.05,  tier: 'Barely Active' };
  if (count < 30)    return { score: maxPts * 0.20,  tier: 'Low' };
  if (count < 80)    return { score: maxPts * 0.50,  tier: 'Moderate' };
  if (count < 200)   return { score: maxPts * 0.75,  tier: 'Active' };
  if (count < 500)   return { score: maxPts * 0.90,  tier: 'Very Active' };
  return                    { score: maxPts,          tier: 'Max' }; // 500+ always max (private user, not brand)
}

// ─── Followers Quality (35 pts max) ───────────────────────────────────────────
// Only called for private accounts.
// Sweet spot: 100–2K = real personal engaged followers
export function scoreFollowersQuality(count, maxPts) {
  if (count === 0)   return { score: 0,              tier: 'No Followers' };
  if (count < 20)    return { score: maxPts * 0.05,  tier: 'Ghost Account' };
  if (count < 50)    return { score: maxPts * 0.15,  tier: 'Very Low' };
  if (count < 100)   return { score: maxPts * 0.30,  tier: 'Low' };
  if (count < 500)   return { score: maxPts * 0.80,  tier: 'Good' };
  if (count < 2000)  return { score: maxPts,          tier: 'Sweet Spot' };  // ← max
  if (count < 10000) return { score: maxPts * 0.80,  tier: 'Popular' };
  if (count < 50000) return { score: maxPts * 0.45,  tier: 'Semi-Public' };
  return                    { score: maxPts * 0.10,  tier: 'Too Popular' };  // 50K+ private = unusual
}

// ─── Following Quality (25 pts max) ───────────────────────────────────────────
// Normal personal user follows 100–1K people
export function scoreFollowingQuality(count, maxPts) {
  if (count === 0)   return { score: 0,              tier: 'Not Following Anyone' };
  if (count < 20)    return { score: maxPts * 0.05,  tier: 'Very Low' };
  if (count < 50)    return { score: maxPts * 0.20,  tier: 'Low' };
  if (count < 100)   return { score: maxPts * 0.50,  tier: 'Moderate' };
  if (count < 500)   return { score: maxPts * 0.85,  tier: 'Normal' };
  if (count < 1000)  return { score: maxPts,          tier: 'Active Social' };  // ← max
  if (count < 3000)  return { score: maxPts * 0.60,  tier: 'High' };
  return                    { score: maxPts * 0.20,  tier: 'Mass-Follow Risk' };
}

// ─── Activity bonus (small, secondary) ───────────────────────────────────────
export function scoreActivity(enriched, maxPts) {
  if (!enriched) return { score: 0, level: 'Unknown' };
  let s = 0;
  if (enriched.highlight_reel_count > 3) s += 3;
  else if (enriched.highlight_reel_count > 0) s += 2;
  if (enriched.has_story)  s += 2;
  if (enriched.external_url) s += 1;
  const bio = enriched.biography || '';
  const yr  = new Date().getFullYear();
  if (bio.includes(String(yr)) || bio.includes(String(yr - 1))) s += 1;
  if (!bio && !enriched.highlight_reel_count && !enriched.has_story) s -= 2;
  const normalized = Math.max(0, Math.min(maxPts, (s / 7) * maxPts));
  const level = normalized >= maxPts * 0.7 ? 'High' : normalized >= maxPts * 0.3 ? 'Moderate' : 'Low';
  return { score: normalized, level };
}

// ─── Main Scoring (100 pts: Posts 40 + Followers 35 + Following 25) ──────────
export function scoreProspect(raw, enriched, classification, settings, sourceCount = 1) {
  const w = settings?.weights || {};
  const breakdown = {};

  // ── Dimension 1: Post Count (60 pts) — MAIN PRIORITY ────────────────────
  const maxPost   = w.postCount || 60;
  const postCount = enriched?.post_count ?? raw?.media_count ?? 0;
  const postResult = scorePostCount(postCount, maxPost);
  breakdown.postCount = {
    score: postResult.score, max: maxPost,
    raw: postCount, tier: postResult.tier,
  };

  // ── Dimension 2: Followers Quality (25 pts) ───────────────────────────────
  const maxFollQ  = w.followersQuality || 25;
  const follCount = enriched?.follower_count ?? raw?.follower_count ?? 0;
  const follResult = scoreFollowersQuality(follCount, maxFollQ);
  breakdown.followersQuality = {
    score: follResult.score, max: maxFollQ,
    raw: follCount, tier: follResult.tier,
  };

  // ── Dimension 3: Following Quality (15 pts) ───────────────────────────────
  const maxFollingQ  = w.followingQuality || 15;
  const follingCount = enriched?.following_count ?? raw?.following_count ?? 0;
  const follingResult = scoreFollowingQuality(follingCount, maxFollingQ);
  breakdown.followingQuality = {
    score: follingResult.score, max: maxFollingQ,
    raw: follingCount, tier: follingResult.tier,
  };

  // ── Total ─────────────────────────────────────────────────────────────────
  const finalScore = breakdown.postCount.score
                   + breakdown.followersQuality.score
                   + breakdown.followingQuality.score;

  // ── Priority thresholds (out of 100) ─────────────────────────────────────
  let priorityLabel = '👁 Review';
  if (finalScore >= 70) priorityLabel = '🔥 High Priority';
  else if (finalScore >= 45) priorityLabel = '✅ Qualified';

  const explainReasons = generateExplanation(breakdown, classification);

  return {
    finalScore:    Math.round(finalScore),
    breakdown,
    priorityLabel,
    explainReasons,
  };
}

// ─── Explanation ─────────────────────────────────────────────────────────────
export function generateExplanation(breakdown, classification) {
  const reasons = [];

  const pc = breakdown.postCount;
  if (pc?.raw === 0)
    reasons.push('⚠️ 0 posts — cannot be High Priority');
  else if (pc?.score > 0)
    reasons.push(`${pc.raw} posts (${pc.tier})`);

  const fq = breakdown.followersQuality;
  if (fq?.raw === 0)
    reasons.push('⚠️ 0 followers — ghost account');
  else if (fq?.raw > 0)
    reasons.push(`${fmtNum(fq.raw)} followers (${fq.tier})`);

  const fg = breakdown.followingQuality;
  if (fg?.raw > 0)
    reasons.push(`${fmtNum(fg.raw)} following (${fg.tier})`);

  return reasons;
}

function fmtNum(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

// ─── Sort comparator ─────────────────────────────────────────────────────────
export function compareProspects(a, b) {
  return (b.finalScore || 0) - (a.finalScore || 0);
}
