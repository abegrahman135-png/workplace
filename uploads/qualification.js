export const BUSINESS_CATEGORIES = [
  'Creators & Celebrities', 'Business & Utility Services', 'General Interest',
  'Content & Apps', 'Local Events', 'Publishers', 'Restaurants', 'Home Goods Stores'
];

export const CREATOR_CATEGORIES = [
  'Video Creator', 'Digital creator', 'Public Figure', 'Blogger', 'Artist', 'Musician/Band'
];

// ─── Tier 1: Quick pre-filter (no enrichment needed) ─────────────────────────
// HARD GATES: must pass to proceed to enrichment. Contribute ZERO points.
export function qualifyTier1(raw, settings) {
  // Gate 1: Must be female (threshold 70%) — checked on name only at this stage
  if ((raw.femaleScore || 0) < (settings.minFemaleScore || 70)) {
    return { qualified: false, reason: 'Low female likelihood' };
  }
  // Gate 2: Post count — ONLY exclude if raw API explicitly says 0 posts.
  //   If media_count is undefined (not in follower list data), skip this gate.
  //   Post count is properly verified in Tier 2 after enrichment.
  const rawPostCount = raw.media_count ?? raw.post_count ?? null;
  if (rawPostCount !== null && rawPostCount === 0) {
    return { qualified: false, reason: '0 posts — excluded' };
  }
  // Gate 3: Skip if already following or request pending
  if (raw.followed_by_viewer === true) {
    return { qualified: false, reason: 'Already following' };
  }
  if (raw.requested_by_viewer === true) {
    return { qualified: false, reason: 'Request already sent' };
  }
  if (settings.excludeVerified && raw.is_verified) {
    return { qualified: false, reason: 'Verified account' };
  }
  return { qualified: true, reason: null };
}

// ─── Tier 2: Post-enrichment hard filters ────────────────────────────────────
// Runs after fetching full profile data
export function qualifyTier2(enriched, settings) {
  const warnings = [];

  if (enriched.post_count < (settings.minPosts || 20)) {
    return { qualified: false, reason: `Fewer than ${settings.minPosts || 20} posts`, warnings };
  }

  if (enriched.is_business_account && settings.excludeBusinesses) {
    return { qualified: false, reason: 'Business account', warnings };
  }

  // Follower count filters
  const followers = enriched.follower_count || 0;
  const minFollowers = settings.minFollowers ?? 0;
  if (minFollowers > 0 && followers < minFollowers) {
    warnings.push(`Below min followers (${followers} < ${minFollowers})`);
  }
  if (settings.maxFollowers && followers > settings.maxFollowers) {
    warnings.push(`Too many followers (${followers} > ${settings.maxFollowers})`);
  }

  // Following count filters
  const following = enriched.following_count || 0;
  const minFollowing = settings.minFollowing ?? 0;
  if (minFollowing > 0 && following < minFollowing) {
    warnings.push(`Below min following (${following} < ${minFollowing})`);
  }
  if (settings.maxFollowing && following > settings.maxFollowing) {
    warnings.push(`Too many following (${following} > ${settings.maxFollowing})`);
  }

  return { qualified: true, reason: null, warnings };
}

// ─── Account Type Classification ──────────────────────────────────────────────
export function classifyAccountType(enriched) {
  if (enriched.is_business_account) {
    if (CREATOR_CATEGORIES.includes(enriched.category_name)) return 'Creator';
    return 'Business';
  }
  if (enriched.is_verified) return 'Public Figure';
  // Heuristics for business-like bios
  const bio = (enriched.biography || '').toLowerCase();
  const bizWords = ['dm to order', 'shop link', 'promo available', 'inquiries:', 'contact:', 'official account'];
  if (bizWords.some(w => bio.includes(w))) return 'Business';
  return 'Personal';
}
