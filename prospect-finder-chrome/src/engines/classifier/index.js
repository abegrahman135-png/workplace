/**
 * classifier/index.js — Progressive gender classification.
 *
 * Tier 1 (follower-list data only): name + username signals.
 * Tier 2 (after enrichment):        + bio pronouns/keywords + optional visual.
 *
 * CRITICAL INVARIANT: a low or unknown result NEVER removes a profile from
 * the pipeline. It only affects lane priority. This is the fix for the
 * chicken-and-egg gate that made v1 show ~10 of 500.
 */

import { combine } from './evidence.js';
import { nameSignals, loadNameDb } from './names.js';
import { bioSignals, detectTaken } from './bio.js';
import { visualSignals } from './visual.js';

export { loadNameDb, detectTaken };

export function classifyTier1(raw) {
  const sigs = nameSignals({
    username: raw.username,
    fullName: raw.full_name || raw.fullName || '',
  });
  return { female: combine(sigs) };
}

/**
 * Tier 2 runs in two passes so the expensive layer is spent where it helps.
 *
 * Pass 1: cheap text layers (name + username + bio).
 * Pass 2: photo/ML analysis, but ONLY when pass 1 was inconclusive.
 *
 * Combining is order-independent, so adding the visual signal afterwards
 * yields the same result as computing everything at once — just cheaper.
 */
export async function classifyTier2(raw, enriched, settings, lane) {
  const textSigs = [
    ...nameSignals({
      username: raw?.username || enriched?.username,
      fullName: enriched?.full_name || raw?.full_name || '',
    }),
    ...bioSignals(enriched?.biography || ''),
  ];
  const textEvidence = combine(textSigs);

  // The visual pass must never be able to stall enrichment. Even with the
  // per-call timeout and circuit breaker, bound the whole thing again here:
  // a slow model degrades results, it must not freeze the queue.
  let visual = [];
  try {
    visual = await Promise.race([
      visualSignals(
        enriched?.profile_pic_url, settings, lane, textEvidence,
        raw?.username || enriched?.username,
      ),
      new Promise((resolve) => setTimeout(() => resolve([]), 8000)),
    ]);
  } catch (_) {
    visual = [];
  }

  return {
    female: visual.length ? combine([...textSigs, ...visual]) : textEvidence,
    taken: detectTaken(enriched?.biography || ''),
  };
}
