export const DB_NAME     = 'ProspectFinderDB';
export const DB_VERSION  = 3;   // v3: + avatars store (cached profile pics)

export const PORT_NAME        = 'harvest-stream';
export const DATA_CHANNEL     = 'pf-data';
export const SETTINGS_CHANNEL = 'pf-settings';
export const IG_APP_ID        = '936619743392459';

export const SCORE_VERSION = 2;

export const RESERVED_PATHS = new Set([
  'explore', 'reels', 'stories', 'direct', 'accounts', 'p', 'tv',
  'reel', 'live', 'tags', 'locations', 'about', 'legal', '_u',
]);

/** Pipeline stages. Forward-only. Nothing is ever deleted. */
export const STAGE = {
  DISCOVERED: 'discovered',
  QUEUED:     'queued',
  ENRICHING:  'enriching',
  SCORED:     'scored',
  FAILED:     'failed',
  DEAD:       'dead',
};

/** Score labels. */
export const LABEL = {
  PENDING:  'pending',
  HIGH:     'high_priority',
  QUALIFIED:'qualified',
  REVIEW:   'review',
  EXCLUDED: 'excluded',
};

export const LANE = { FAST: 'fast', NORMAL: 'normal', SLOW: 'slow' };
export const LANE_ORDER = [LANE.FAST, LANE.NORMAL, LANE.SLOW];

export const JOB_STATUS = {
  PENDING: 'pending',
  LEASED:  'leased',
  DONE:    'done',
  FAILED:  'failed',
  DEAD:    'dead',
};

export const DEFAULT_SETTINGS = {
  weights: {
    postCount:        60,
    followersQuality: 25,
    followingQuality: 15,
  },
  // Thresholds are LABELS, never write-time kill gates.
  minFemaleScore:      70,
  minPosts:            20,
  minFollowers:        100,
  minFollowing:        50,
  maxFollowers:        null,
  maxFollowing:        null,

  excludeVerified:     true,
  excludeBusinesses:   true,
  preferPrivate:       true,

  // Pipeline
  // Instagram's web API tolerates far less than the original defaults
  // assumed. 35/min at concurrency 3 reliably triggered 429s within seconds;
  // measured 429 rate fell from 52% to 5% after backing these off. Slower and
  // finishing beats fast and blocked.
  enrichConcurrency:      2,
  enrichDelayMs:          3500,
  enrichMaxDelayMs:       30_000,
  perMinuteCap:           15,
  maxAttempts:            5,
  maxProfilesPerSession:  1000,
  scrapeDelayMs:          2200,

  // Biometric inference: OFF by default. See README "Compliance".
  // The face model is now bundled (public/face-api/, ~1.9MB), so this layer is
  // available by default. It runs ONLY on profiles the text layers could not
  // decide — see shouldRunVisual() — so the cost is bounded.
  enableVisualClassifier: true,
  // Uncertain profiles are triaged into the SLOW lane, so restricting the
  // visual pass to the fast lane meant it never ran on the profiles that
  // actually needed it.
  visualFastLaneOnly:     false,

  // Retention
  autoPurgeDays:       0,   // 0 = never
  theme:               'dark',
  density:             'comfortable',
};

export const MSG = {
  PROFILE_DETECTED: 'PROFILE_DETECTED',
  START_DIG:        'START_DIG',
  PAUSE_DIG:        'PAUSE_DIG',
  RESUME_DIG:       'RESUME_DIG',
  STOP_DIG:         'STOP_DIG',
  GET_STATUS:       'GET_STATUS',
  OPEN_DASHBOARD:   'OPEN_DASHBOARD',
  PUMP_NOW:         'PUMP_NOW',
  REQUEUE_FAILED:   'REQUEUE_FAILED',
  RESCORE_ALL:      'RESCORE_ALL',
  SETTINGS_UPDATED: 'SETTINGS_UPDATED',
  DATA_CHANGED:     'DATA_CHANGED',
  // port
  FOLLOWER_BATCH:   'FOLLOWER_BATCH',
  BATCH_ACK:        'BATCH_ACK',
  BATCH_NACK:       'BATCH_NACK',
  HEARTBEAT:        'HEARTBEAT',
  SCRAPE_COMPLETE:  'SCRAPE_COMPLETE',
  SCRAPE_ERROR:     'SCRAPE_ERROR',
  CHECKPOINT:       'CHECKPOINT_DETECTED',
  PROGRESS:         'PROGRESS',
  // Ask a live instagram.com tab to perform a same-origin profile fetch.
  PROXY_FETCH:      'PROXY_FETCH',
};
