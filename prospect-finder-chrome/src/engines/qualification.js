/**
 * qualification.js — Triage, NOT rejection.
 *
 * v1's qualifyTier1() returned {qualified:false} and the caller then set
 * enrichmentStatus:'skipped', permanently removing the profile from the
 * funnel. Because the female score at that stage was derived from name data
 * alone (50 for anything not in a ~130-entry dictionary), it silently killed
 * the majority of every scan.
 *
 * v2 returns a LANE. Every profile is enriched; likely matches simply go
 * first. Nothing is ever dropped.
 */

import { LANE } from '../lib/constants.js';
import { clamp } from '../lib/utils.js';

export const BUSINESS_CATEGORIES = [
  'Creators & Celebrities', 'Business & Utility Services', 'General Interest',
  'Content & Apps', 'Local Events', 'Publishers', 'Restaurants', 'Home Goods Stores',
];

export const CREATOR_CATEGORIES = [
  'Video Creator', 'Digital creator', 'Public Figure', 'Blogger', 'Artist', 'Musician/Band',
];

export function triage(raw, evidence, settings) {
  let p = 50;
  const notes = [];
  const fem = evidence?.female || { value: 50, confidence: 0, verdict: 'unknown' };

  if (fem.verdict === 'likely_female' && fem.confidence >= 0.6) { p += 30; notes.push('likely female'); }
  else if (fem.value >= 60) { p += 15; notes.push('possibly female'); }
  else if (fem.verdict === 'likely_male' && fem.confidence >= 0.7) { p -= 35; notes.push('likely male'); }

  if (raw.is_verified && settings?.excludeVerified) { p -= 20; notes.push('verified'); }
  if (raw.media_count === 0) { p -= 25; notes.push('0 posts'); }

  // Already-connected accounts are deprioritised, never erased.
  if (raw.followed_by_viewer) { p -= 60; notes.push('already following'); }
  if (raw.requested_by_viewer) { p -= 60; notes.push('request pending'); }

  const priority = clamp(p, 0, 100);
  const lane = priority >= 65 ? LANE.FAST : priority >= 30 ? LANE.NORMAL : LANE.SLOW;
  return { priority, lane, notes };
}

/** Post-enrichment warnings. Advisory only — never removes a record. */
export function qualifyTier2(enriched, settings) {
  const warnings = [];
  const posts = enriched?.post_count ?? 0;
  const followers = enriched?.follower_count ?? 0;
  const following = enriched?.following_count ?? 0;

  if (posts < (settings?.minPosts ?? 0)) warnings.push(`Under ${settings.minPosts} posts`);
  if (settings?.minFollowers && followers < settings.minFollowers) warnings.push(`Under ${settings.minFollowers} followers`);
  if (settings?.maxFollowers && followers > settings.maxFollowers) warnings.push(`Over ${settings.maxFollowers} followers`);
  if (settings?.minFollowing && following < settings.minFollowing) warnings.push(`Under ${settings.minFollowing} following`);
  if (settings?.maxFollowing && following > settings.maxFollowing) warnings.push(`Over ${settings.maxFollowing} following`);
  if (enriched?.is_business_account && settings?.excludeBusinesses) warnings.push('Business account');

  return { warnings };
}

export function classifyAccountType(enriched) {
  if (!enriched) return 'Unknown';
  if (enriched.is_business_account) {
    return CREATOR_CATEGORIES.includes(enriched.category_name) ? 'Creator' : 'Business';
  }
  if (enriched.is_verified) return 'Public Figure';
  const bio = (enriched.biography || '').toLowerCase();
  const biz = ['dm to order', 'shop link', 'promo available', 'inquiries:', 'contact:', 'official account', 'whatsapp'];
  if (biz.some(w => bio.includes(w))) return 'Business';
  return 'Personal';
}
