// Content Script → Service Worker (via Port)
export const FOLLOWER_BATCH = 'FOLLOWER_BATCH';
export const ENRICHMENT_RESULT = 'ENRICHMENT_RESULT';
export const ENRICHMENT_FAILED = 'ENRICHMENT_FAILED';
export const SCRAPE_COMPLETE = 'SCRAPE_COMPLETE';
export const SCRAPE_ERROR = 'SCRAPE_ERROR';
export const HEARTBEAT = 'HEARTBEAT';
export const CHECKPOINT_DETECTED = 'CHECKPOINT_DETECTED';

// Service Worker → Content Script (via Port)
export const BATCH_ACK = 'BATCH_ACK';
export const ENRICH_PROFILE = 'ENRICH_PROFILE';
export const RESUME_DIG = 'RESUME_DIG';
export const PAUSE_DIG = 'PAUSE_DIG';
export const STOP_DIG = 'STOP_DIG';
export const RATE_LIMIT_BACKOFF = 'RATE_LIMIT_BACKOFF';

// One-shot messages
export const PROFILE_DETECTED = 'PROFILE_DETECTED';
export const START_DIG = 'START_DIG';
export const GET_STATUS = 'GET_STATUS';
export const STATUS_RESPONSE = 'STATUS_RESPONSE';
export const OPEN_DASHBOARD = 'OPEN_DASHBOARD';
export const DIG_REJECTED = 'DIG_REJECTED';
export const SETTINGS_UPDATED = 'SETTINGS_UPDATED';
