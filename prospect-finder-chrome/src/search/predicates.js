/**
 * predicates.js — Composable filter atoms.
 * Every advanced-search operator resolves to one of these.
 */

import { deepGet, parseDuration } from '../lib/utils.js';
import { detectTaken } from '../engines/classifier/bio.js';
import { matchesText } from './text_index.js';

export const FIELD_ACCESSORS = {
  username:        p => p.username || '',
  fullName:        p => p.enriched?.full_name || p.raw?.full_name || '',
  bio:             p => p.enriched?.biography || '',
  posts:           p => p.metrics?.posts ?? 0,
  followers:       p => p.metrics?.followers ?? 0,
  following:       p => p.metrics?.following ?? 0,
  ratio:           p => { const f = p.metrics?.following ?? 0; return f > 0 ? (p.metrics?.followers ?? 0) / f : 0; },
  femaleScore:     p => p.femaleScore ?? 0,
  femaleConfidence:p => p.femaleConfidence ?? 0,
  verdict:         p => p.evidence?.female?.verdict || 'unknown',
  finalScore:      p => p.finalScore ?? -1,
  label:           p => p.label || 'pending',
  stage:           p => p.stage || 'queued',
  status:          p => p.status || 'active',
  accountType:     p => p.accountType || 'Unknown',
  isPrivate:       p => Boolean(p.enriched?.is_private ?? p.raw?.is_private),
  isVerified:      p => Boolean(p.enriched?.is_verified ?? p.raw?.is_verified),
  isBusiness:      p => Boolean(p.enriched?.is_business_account),
  hasExternalUrl:  p => Boolean(p.enriched?.external_url),
  hasStory:        p => Boolean(p.enriched?.has_story),
  hasHighlights:   p => (p.enriched?.highlight_reel_count ?? 0) > 0,
  followsViewer:   p => Boolean(p.raw?.follows_viewer),
  followedByViewer:p => Boolean(p.raw?.followed_by_viewer),
  requested:       p => Boolean(p.raw?.requested_by_viewer),
  isTaken:         p => detectTaken(p.enriched?.biography || ''),
  sourceCount:     p => (p.sourceUsernames || []).filter(Boolean).length,
  sourceUsernames: p => p.sourceUsernames || [],
  sessionIds:      p => p.sessionIds || [],
  firstSeenAt:     p => p.firstSeenAt || 0,
  lastSeenAt:      p => p.lastSeenAt || 0,
  attempts:        p => p.attempts || 0,
  manualPriority:  p => Boolean(p.manualPriority),
};

function val(p, field) {
  const acc = FIELD_ACCESSORS[field];
  return acc ? acc(p) : deepGet(p, field);
}

export const OPS = {
  eq:        (a, b) => a === b,
  neq:       (a, b) => a !== b,
  gt:        (a, b) => Number(a) > Number(b),
  gte:       (a, b) => Number(a) >= Number(b),
  lt:        (a, b) => Number(a) < Number(b),
  lte:       (a, b) => Number(a) <= Number(b),
  between:   (a, b) => {
    const [lo, hi] = b || [];
    const n = Number(a);
    if (lo != null && n < Number(lo)) return false;
    if (hi != null && n > Number(hi)) return false;
    return true;
  },
  in:        (a, b) => Array.isArray(b) && b.includes(a),
  notIn:     (a, b) => Array.isArray(b) && !b.includes(a),
  contains:  (a, b) => String(a).toLowerCase().includes(String(b).toLowerCase()),
  notContains: (a, b) => !String(a).toLowerCase().includes(String(b).toLowerCase()),
  containsAny: (a, b) => {
    const s = String(a).toLowerCase();
    return (b || []).some(x => s.includes(String(x).toLowerCase()));
  },
  containsNone: (a, b) => {
    const s = String(a).toLowerCase();
    return !(b || []).some(x => s.includes(String(x).toLowerCase()));
  },
  containsAll: (a, b) => {
    const arr = Array.isArray(a) ? a.map(x => String(x).toLowerCase()) : [String(a).toLowerCase()];
    return (b || []).every(x => arr.includes(String(x).toLowerCase()));
  },
  hasAny:    (a, b) => Array.isArray(a) && (b || []).some(x => a.includes(x)),
  within:    (a, b) => {
    const ms = parseDuration(b);
    return ms == null ? true : (Date.now() - Number(a)) <= ms;
  },
  older:     (a, b) => {
    const ms = parseDuration(b);
    return ms == null ? true : (Date.now() - Number(a)) > ms;
  },
};

export function evalCondition(p, cond) {
  const fn = OPS[cond.op];
  if (!fn) return true;
  return fn(val(p, cond.field), cond.value);
}

/** Recursively evaluate a filter group tree. */
export function evalGroup(p, group) {
  if (!group) return true;
  const { logic = 'AND', conditions = [], groups = [] } = group;
  const results = [
    ...conditions.map(c => evalCondition(p, c)),
    ...groups.map(g => evalGroup(p, g)),
  ];
  if (!results.length) return true;
  return logic === 'OR' ? results.some(Boolean) : results.every(Boolean);
}

export function buildMatcher(query) {
  const { text, filters, group } = query || {};
  const g = group || (filters?.length ? { logic: query.logic || 'AND', conditions: filters } : null);
  return (p) => {
    if (text && !matchesText(p, text)) return false;
    return evalGroup(p, g);
  };
}
