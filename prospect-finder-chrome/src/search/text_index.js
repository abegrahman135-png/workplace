/**
 * text_index.js — Trigram tokens for substring search without full scans.
 * Stored on each prospect as a multiEntry index (`byToken`).
 */

const MAX_TOKENS = 240;

export function tokenizeText(text) {
  const words = String(text || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const out = new Set();
  for (const w of words) {
    if (w.length < 2) continue;
    out.add(w);
    if (w.length > 3) {
      for (let i = 0; i <= w.length - 3; i++) out.add(w.slice(i, i + 3));
    }
  }
  return out;
}

export function buildSearchTokens(p) {
  const parts = [
    p.username,
    p.raw?.full_name || p.enriched?.full_name || '',
    p.enriched?.biography || '',
  ].filter(Boolean).join(' ');
  return [...tokenizeText(parts)].slice(0, MAX_TOKENS);
}

/**
 * Candidate index terms for a query string.
 * Only emits tokens we are guaranteed to have indexed: full words (always)
 * and every trigram of words longer than 3 chars. The caller picks whichever
 * is rarest, so longer queries get MORE selective, not less.
 */
export function queryTerms(q) {
  const words = String(q || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const out = [];
  for (const w of words) {
    if (w.length < 2) continue;
    out.push(w);                       // indexed as a whole word
    if (w.length > 3) {
      for (let i = 0; i <= w.length - 3; i++) out.push(w.slice(i, i + 3));
    }
  }
  return [...new Set(out)];
}

export function matchesText(p, q) {
  if (!q) return true;
  const needle = q.toLowerCase();
  const hay = [
    p.username,
    p.raw?.full_name || '',
    p.enriched?.full_name || '',
    p.enriched?.biography || '',
  ].join(' ').toLowerCase();
  return hay.includes(needle);
}
