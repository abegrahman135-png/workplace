/**
 * bio.js — Bio-derived gender signals.
 * These are among the strongest signals available, and in v1 they were
 * unreachable for ~80% of profiles because the Tier-1 gate rejected before
 * enrichment ever fetched a bio.
 */

import { signal } from './evidence.js';

export const PRONOUN_PATTERNS = [
  { re: /\b(she\s*\/\s*her|she\s*\|\s*her|she-her)\b/i,  score: 97, label: 'she/her' },
  { re: /\b(he\s*\/\s*him|he\s*\|\s*him|he-him)\b/i,     score: 3,  label: 'he/him' },
  { re: /\b(they\s*\/\s*them)\b/i,                        score: 50, label: 'they/them' },
  { re: /(তিনি|তার)\s*(\/|\|)\s*(তাকে)/,                  score: 92, label: 'bn-pronoun' },
  { re: /\bher\s*\/\s*hers\b/i,                           score: 95, label: 'her/hers' },
];

export function detectPronouns(bio) {
  if (!bio) return null;
  for (const p of PRONOUN_PATTERNS) {
    const m = bio.match(p.re);
    if (m) return { score: p.score, match: m[0].trim(), label: p.label };
  }
  return null;
}

const FEMALE_KW = [
  { w: 'girl', s: 8 }, { w: 'woman', s: 9 }, { w: 'mom', s: 9 }, { w: 'mother', s: 9 },
  { w: 'wife', s: 10 }, { w: 'sister', s: 7 }, { w: 'daughter', s: 8 }, { w: 'queen', s: 6 },
  { w: 'makeup', s: 6 }, { w: 'beauty', s: 4 }, { w: 'skincare', s: 5 }, { w: 'nails', s: 6 },
  { w: 'lashes', s: 6 }, { w: 'hijab', s: 8 }, { w: 'saree', s: 7 }, { w: 'boutique', s: 3 },
  { w: 'ballet', s: 5 }, { w: 'dancer', s: 3 }, { w: 'nurse', s: 3 }, { w: 'mua', s: 6 },
  { w: 'bride', s: 8 }, { w: 'mrs', s: 8 }, { w: 'miss', s: 6 }, { w: 'ms.', s: 5 },
  { w: 'girly', s: 7 }, { w: 'princess', s: 7 }, { w: 'mama', s: 8 },
];
const MALE_KW = [
  { w: 'boy', s: 8 }, { w: 'man', s: 7 }, { w: 'dad', s: 9 }, { w: 'father', s: 9 },
  { w: 'husband', s: 10 }, { w: 'brother', s: 7 }, { w: 'son of', s: 7 }, { w: 'king', s: 5 },
  { w: 'gym rat', s: 5 }, { w: 'bodybuilder', s: 5 }, { w: 'beard', s: 7 }, { w: 'mr.', s: 7 },
  { w: 'engineer', s: 2 }, { w: 'bhai', s: 7 }, { w: 'gamer', s: 3 }, { w: 'footballer', s: 4 },
];

/** Word-boundary matching. No substring false positives. */
function hasWord(hay, needle) {
  if (needle.includes(' ') || needle.includes('.')) return hay.includes(needle);
  return new RegExp(`(^|[^a-z])${needle}([^a-z]|$)`, 'i').test(hay);
}

export function analyzeBioKeywords(bio) {
  if (!bio) return null;
  const b = bio.toLowerCase();
  let f = 0, m = 0, top = null, topW = 0;

  for (const k of FEMALE_KW) {
    if (hasWord(b, k.w)) { f += k.s; if (k.s > topW) { topW = k.s; top = k.w; } }
  }
  for (const k of MALE_KW) {
    if (hasWord(b, k.w)) { m += k.s; if (k.s > topW) { topW = k.s; top = k.w; } }
  }
  if (!f && !m) return null;

  const net = f - m;
  const mass = f + m;
  const score = 50 + (net / Math.max(mass, 1)) * 45;
  const confidence = Math.min(1, mass / 14);
  return { score: Math.round(score), confidence, top };
}

/** Relationship-status markers — surfaced as a filter, not a gender signal. */
export const TAKEN_MARKERS = [
  '💍','👰','🤵','engaged','married','taken','wifey','wife of','hubby','husband',
  'mom of','mama of','mother of','my hubby','fiance','fiancé','fiancée','nikah','biye',
];

export function detectTaken(bio) {
  if (!bio) return false;
  const b = bio.toLowerCase();
  return TAKEN_MARKERS.some(m => b.includes(m));
}

export function bioSignals(bio) {
  const out = [];
  const pr = detectPronouns(bio);
  if (pr) out.push(signal('pronouns', pr.score, 1, { match: pr.match, label: pr.label }));
  const kw = analyzeBioKeywords(bio);
  if (kw) out.push(signal('bioKeywords', kw.score, kw.confidence, { top: kw.top }));
  return out;
}
