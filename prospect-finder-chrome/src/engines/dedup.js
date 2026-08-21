/**
 * dedup.js — Merge re-sightings WITHOUT touching scores.
 *
 * v1 injected a `sourceOverlap` dimension that the scoring model didn't have,
 * then re-summed the breakdown — so a prospect's score changed every time it
 * was seen again and could exceed 100. Merging is now idempotent.
 */

export function mergeProspect(existing, { sessionId, sourceUsername }) {
  const next = { ...existing };
  if (sessionId && !next.sessionIds?.includes(sessionId)) {
    next.sessionIds = [...(next.sessionIds || []), sessionId];
  }
  if (sourceUsername && !next.sourceUsernames?.includes(sourceUsername)) {
    next.sourceUsernames = [...(next.sourceUsernames || []), sourceUsername];
  }
  next.lastSeenAt = Date.now();
  return next;   // scored / finalScore / label deliberately untouched
}

export function sourceCount(p) {
  return (p.sourceUsernames || []).filter(Boolean).length;
}
