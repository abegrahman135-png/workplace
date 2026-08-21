export async function deduplicateAndMerge(prospect, sessionId, sourceUsername, db) {
  try {
    const existing = await db.prospects.get(prospect.username);
    if (!existing) {
      prospect.sessionIds = [sessionId];
      prospect.sourceUsernames = [sourceUsername];
      prospect.firstSeenAt = Date.now();
      prospect.lastSeenAt = Date.now();
      prospect.status = 'new';
      return { action: 'insert', prospect };
    }

    if (['followed', 'requested', 'rejected'].includes(existing.status)) {
      return { action: 'skip', prospect: existing };
    }

    // Merge: union session/source arrays, update lastSeenAt
    existing.sessionIds = [...new Set([...(existing.sessionIds || []), sessionId])];
    existing.sourceUsernames = [...new Set([...(existing.sourceUsernames || []), sourceUsername])];
    existing.lastSeenAt = Date.now();

    // Re-calculate source overlap in scored breakdown if available
    if (existing.scored && existing.scored.breakdown) {
      const sourceCount = existing.sourceUsernames.length;
      const maxOverlap = existing.scored.breakdown.sourceOverlap?.max || 5;
      existing.scored.breakdown.sourceOverlap = {
        score: Math.min(sourceCount - 1, 3) / 3 * maxOverlap,
        max: maxOverlap,
        sourceCount
      };
      existing.scored.finalScore = Object.values(existing.scored.breakdown).reduce((sum, d) => sum + (d?.score || 0), 0);
    }

    return { action: 'merge', prospect: existing };
  } catch (err) {
    console.error('[dedup] Error:', err);
    return { action: 'insert', prospect };
  }
}
