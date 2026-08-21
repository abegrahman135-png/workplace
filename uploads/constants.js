export const DB_NAME = 'ProspectFinderDB';
export const PORT_NAME = 'scraper-stream';
export const SETTINGS_CHANNEL = 'settings-sync';
export const IG_APP_ID = '936619743392459';

export const RESERVED_PATHS = new Set([
  'explore', 'reels', 'stories', 'direct', 'accounts',
  'p', 'tv', 'reel', 'live', 'tags', 'locations',
]);

export const DEFAULT_SETTINGS = {
  // Scoring weights — ONLY posts + followers + following contribute points
  // Female + Private are hard gates (binary pass/fail, not scored)
  weights: {
    postCount:        60,   // MAIN PRIORITY — posts = 60 pts max
    followersQuality: 25,   // Followers quality = 25 pts max
    followingQuality: 15,   // Following quality = 15 pts max
  },
  // Hard filters
  minFemaleScore:           70,    // Tier 1 gate — must be ≥70% female to qualify
  minPosts:                 20,    // Tier 2 gate
  minFollowers:            100,    // Tier 2 gate — prefer 100+ followers
  minFollowing:             50,    // Tier 2 gate — prefer 50+ following
  maxFollowers:           null,    // null = no cap
  maxFollowing:           null,    // null = no cap
  // Preferences
  preferPrivate:           true,
  excludeVerified:         true,
  excludeBusinesses:       true,
  defaultAccountType:      'personal',
  // Operational
  scrapeDelayMs:           2000,
  enrichmentDelayMs:       3000,
  maxProfilesPerSession:   1000,
  batchSize:               50,
  enableFaceClassifier:    true,   // face-api models bundled — on by default
  enrichmentTier:          'full',
  sampleEnrichmentPercent: 100,
  actionDelayMinMs:        45000,
  actionDelayMaxMs:        90000,
  dailyActionCap:          30,
};
