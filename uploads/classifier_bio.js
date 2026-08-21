// Pronoun detection patterns (7 languages)
export const PRONOUN_PATTERNS = [
  { pattern: /\b(?:pronouns?[:\s]*)?\(?(she\s*\/\s*(?:her|they|hers))\)?/i, score: 99, label: 'she/her' },
  { pattern: /\b(?:pronouns?[:\s]*)?\(?(he\s*\/\s*(?:him|they|his))\)?/i,   score: 1,  label: 'he/him' },
  { pattern: /\b(?:pronouns?[:\s]*)?\(?(they\s*\/\s*them)\)?/i,             score: 50, label: 'they/them' },
  { pattern: /\b(ella)\b/i,          score: 92, label: 'ella (es)' },
  { pattern: /\b(sie\/ihr)\b/i,      score: 92, label: 'sie/ihr (de)' },
  { pattern: /\b(elle)\b/i,          score: 88, label: 'elle (fr)' },
  { pattern: /\b(ela\/dela)\b/i,     score: 92, label: 'ela/dela (pt)' },
];

// Bio keywords with exact weights from plan
export const BIO_KEYWORDS = [
  // Strong female signals (+12 to +22)
  { pattern: /\bmom(my)?\b/i,          weight: 20, gender: 'F' },
  { pattern: /\bmother\b/i,            weight: 20, gender: 'F' },
  { pattern: /\bdaughter\b/i,          weight: 18, gender: 'F' },
  { pattern: /\bwife\b/i,              weight: 22, gender: 'F' },
  { pattern: /\bgirl\b/i,              weight: 15, gender: 'F' },
  { pattern: /\bqueen\b/i,             weight: 12, gender: 'F' },
  { pattern: /\bsister?\b/i,           weight: 15, gender: 'F' },
  { pattern: /\bfemale\s+\w+/i,        weight: 18, gender: 'F' },
  { pattern: /\bwoman\b/i,             weight: 18, gender: 'F' },
  { pattern: /\bactress\b/i,           weight: 20, gender: 'F' },
  { pattern: /\bwifey\b/i,             weight: 20, gender: 'F' },

  // Moderate female signals (+5 to +15)
  { pattern: /\b(beauty|makeup|skincare)\b/i, weight: 8, gender: 'F' },
  { pattern: /\bnurse\b/i,             weight: 6,  gender: 'F' },
  { pattern: /\byoga\s*(girl|mom|queen|babe)/i, weight: 10, gender: 'F' },
  { pattern: /\bbride\b/i,             weight: 15, gender: 'F' },
  { pattern: /\bfeminist\b/i,          weight: 10, gender: 'F' },
  { pattern: /💅|👸|💄|🌸|🦋|💕|✨/,     weight: 5,  gender: 'F' },

  // Strong male signals (negative weight)
  { pattern: /\bdad(dy)?\b/i,          weight: -20, gender: 'M' },
  { pattern: /\bfather\b/i,            weight: -20, gender: 'M' },
  { pattern: /\bhusband\b/i,           weight: -22, gender: 'M' },
  { pattern: /\bbrother\b/i,           weight: -15, gender: 'M' },
  { pattern: /\bson\b/i,               weight: -12, gender: 'M' },
  { pattern: /\bking\b/i,              weight: -10, gender: 'M' },
  { pattern: /\bactor\b(?!\s*ess)/i,   weight: -18, gender: 'M' },
  { pattern: /\bbusinessman\b/i,       weight: -20, gender: 'M' },
];

// Title/honorific patterns
export const TITLE_PATTERNS = [
  { pattern: /\b(mrs|ms|miss|mme|sra|señora|frau)\b\.?/i, weight: 25, gender: 'F' },
  { pattern: /\b(mr|sir|sr|señor|herr)\b\.?/i,           weight: -25, gender: 'M' },
];

export function detectPronouns(bio) {
  if (!bio) return null;
  for (const { pattern, score, label } of PRONOUN_PATTERNS) {
    const match = bio.match(pattern);
    if (match) {
      return { match: match[1] || match[0], score, label };
    }
  }
  return null;
}

export function analyzeBioKeywords(bio) {
  if (!bio) return { score: 50, hasSignals: false, topKeyword: null };

  let score = 50;
  let topKeyword = null;
  let topWeight = 0;
  let hasSignals = false;

  // Apply keyword rules
  for (const rule of BIO_KEYWORDS) {
    if (rule.pattern.test(bio)) {
      score += rule.weight;
      hasSignals = true;
      if (Math.abs(rule.weight) > Math.abs(topWeight)) {
        topWeight = rule.weight;
        topKeyword = rule.pattern.source.replace(/\\b|\(/g, '').slice(0, 20);
      }
    }
  }

  // Apply title patterns
  for (const rule of TITLE_PATTERNS) {
    if (rule.pattern.test(bio)) {
      score += rule.weight;
      hasSignals = true;
      if (Math.abs(rule.weight) > Math.abs(topWeight)) {
        topWeight = rule.weight;
        topKeyword = rule.pattern.source.replace(/\\b|\(/g, '').slice(0, 20);
      }
    }
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    hasSignals,
    topKeyword,
  };
}
