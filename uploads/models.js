import { DEFAULT_SETTINGS } from './constants.js';

export { DEFAULT_SETTINGS };

export function normalizeProspect(raw) {
  return {
    username: raw.username || '',
    fullName: raw.fullName || raw.full_name || '',
    profilePicUrl: raw.profilePicUrl || raw.profile_pic_url || '',
    isPrivate: Boolean(raw.isPrivate || raw.is_private),
    isVerified: Boolean(raw.isVerified || raw.is_verified),
    bio: raw.bio || raw.biography || '',
    stats: {
      posts: raw.stats?.posts || raw.edge_owner_to_timeline_media?.count || 0,
      followers: raw.stats?.followers || raw.edge_followed_by?.count || 0,
      following: raw.stats?.following || raw.edge_follow?.count || 0
    },
    classification: {
      femaleScore: raw.classification?.femaleScore || 0,
      confidence: raw.classification?.confidence || 0,
      isProcessed: raw.classification?.isProcessed || false
    },
    sourceProfiles: raw.sourceProfiles || [],
    firstSeen: raw.firstSeen || Date.now(),
    lastSeen: raw.lastSeen || Date.now(),
    status: raw.status || 'new',
    priorityScore: raw.priorityScore || 0,
    priorityLabel: raw.priorityLabel || 'low'
  };
}

export function qualifyProspect(prospect, settings = DEFAULT_SETTINGS) {
  const s = settings;
  const f = prospect.stats.followers;
  const fo = prospect.stats.following;
  const fs = prospect.classification.femaleScore;
  
  if (s.filterMinFollowers && f < s.minFollowers) return false;
  if (s.filterMaxFollowers && f > s.maxFollowers) return false;
  if (s.filterMinFollowing && fo < s.minFollowing) return false;
  if (s.filterMaxFollowing && fo > s.maxFollowing) return false;
  
  if (s.excludePrivate && prospect.isPrivate) return false;
  if (s.excludeVerified && prospect.isVerified) return false;
  
  // Exclude bad keywords in bio
  if (s.excludeKeywords && s.excludeKeywords.length > 0 && prospect.bio) {
    const bioLower = prospect.bio.toLowerCase();
    for (const kw of s.excludeKeywords) {
      if (bioLower.includes(kw.toLowerCase())) return false;
    }
  }
  
  // Female filter
  if (s.requireFemaleLikelihood && fs < s.minFemaleLikelihood) return false;
  
  return true;
}

export function scoreProspect(prospect, settings = DEFAULT_SETTINGS) {
  let score = 0;
  
  // Scoring logic based on female score, followers/following ratio, etc.
  if (prospect.classification.femaleScore > 0.8) score += 30;
  else if (prospect.classification.femaleScore > 0.5) score += 10;
  
  if (prospect.isPrivate) score -= 10;
  
  const f = prospect.stats.followers;
  const fo = prospect.stats.following;
  if (f > 0 && fo > 0) {
    const ratio = f / fo;
    if (ratio > 1 && ratio < 3) score += 20; // healthy ratio
  }
  
  prospect.priorityScore = Math.max(0, Math.min(100, score));
  
  if (prospect.priorityScore >= 70) prospect.priorityLabel = 'high';
  else if (prospect.priorityScore >= 40) prospect.priorityLabel = 'medium';
  else prospect.priorityLabel = 'low';
  
  return prospect;
}

export function rankProspects(prospects) {
  return prospects.sort((a, b) => b.priorityScore - a.priorityScore);
}

export function deduplicateProspects(prospects) {
  const map = new Map();
  for (const p of prospects) {
    if (!map.has(p.username) || p.lastSeen > map.get(p.username).lastSeen) {
      map.set(p.username, p);
    }
  }
  return Array.from(map.values());
}
