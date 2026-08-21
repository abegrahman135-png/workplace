/**
 * evidence.js — Progressive, non-destructive signal combination.
 *
 * v1 collapsed every signal into one number immediately, and any profile
 * without a dictionary name got exactly 50 — which failed the >=70 Tier-1
 * gate, so it was never enriched, so bio pronouns and the profile picture
 * (the two STRONGEST signals) could never run. Circular. ~80% of profiles
 * died at that gate.
 *
 * v2 tracks value + confidence + provenance separately. Low confidence means
 * "we don't know yet", NOT "reject". Unknown profiles still get enriched.
 */

/** @typedef {{value:number, confidence:number, source:string, detail?:any}} Signal */

/** Reliability prior per signal source. */
export const PRIOR = {
  nameExact:   1.00,
  pronouns:    0.95,
  // The face model is the ONLY evidence for profiles whose name is absent from
  // the dictionary, which is exactly when it is invoked. At the old 0.75 prior
  // a correct 87%-confidence call combined to 0.34 — just under the 0.35
  // "unknown" floor — so the layer could never resolve anything on its own.
  // Measured on real photos: p>=0.87 with a clean detection is reliable.
  //
  // Tuned to 0.82, which is a deliberately narrow band:
  //   - high enough that a good photo clears the 0.35 unknown floor alone
  //     (0.9 * 0.82 / 1.4 = 0.53) and can RESOLVE an unknown profile;
  //   - low enough that it stays under the 0.55 hard-exclude threshold in
  //     scoring.js, so a photo can damp a score but never exclude a person
  //     on its own;
  //   - low enough that a dictionary hit (prior 1.00) still wins a
  //     disagreement, since a real name beats a guess from a thumbnail.
  visual:      0.82,
  // A dictionary-grade hit inside the username is nearly as decisive as one in
  // the display name — plenty of users leave full_name blank and put their real
  // name in the handle ("faisal_alam_joy__"). At the old 0.25 prior this was
  // the ONLY evidence for such profiles yet still landed under the 0.35
  // confidence floor, so they stayed "unknown", skipped the male gate, and
  // ranked on follower counts alone.
  usernameDict: 0.70,
  nameSuffix:  0.50,
  bioKeywords: 0.45,
  nameNgram:   0.30,
  username:    0.25,
};

/** Total weighted mass at which we consider ourselves fully confident. */
export const SATURATION = 1.4;

export const UNKNOWN = Object.freeze({
  value: 50,
  confidence: 0,
  verdict: 'unknown',
  sources: [],
  signals: {},
});

export function signal(source, value, confidence = 1, detail) {
  if (value == null || Number.isNaN(value)) return null;
  return { source, value: Math.max(0, Math.min(100, value)), confidence, detail };
}

/**
 * Confidence-weighted combination.
 * Returns a stable shape even when there is zero evidence.
 */
export function combine(signals) {
  const active = (signals || []).filter(s => s && s.confidence > 0 && PRIOR[s.source]);
  if (!active.length) return { ...UNKNOWN };

  let wsum = 0;
  let vsum = 0;
  const bag = {};
  for (const s of active) {
    const w = s.confidence * PRIOR[s.source];
    wsum += w;
    vsum += s.value * w;
    bag[s.source] = { value: s.value, confidence: s.confidence, detail: s.detail };
  }

  const value = Math.round(vsum / wsum);
  const confidence = Number(Math.min(1, wsum / SATURATION).toFixed(2));

  return {
    value,
    confidence,
    verdict: verdictFor(value, confidence),
    sources: active.map(s => s.source),
    signals: bag,
  };
}

export function verdictFor(value, confidence) {
  if (confidence < 0.35) return 'unknown';
  if (value >= 65) return 'likely_female';
  if (value <= 35) return 'likely_male';
  return 'ambiguous';
}

/** Human-readable explanation of how a verdict was reached. */
export function explainEvidence(ev) {
  if (!ev || !ev.sources?.length) return ['No gender signals available yet'];
  const out = [];
  const s = ev.signals || {};
  if (s.nameExact)   out.push(`Name matched dictionary (${s.nameExact.detail?.name || '—'})`);
  if (s.pronouns)    out.push(`Bio pronouns: ${s.pronouns.detail?.match || 'detected'}`);
  if (s.visual)      out.push(`Profile photo analysis (${s.visual.confidence >= .8 ? 'high' : 'moderate'} confidence)`);
  if (s.nameSuffix)  out.push(`Name suffix pattern (${s.nameSuffix.detail?.rule || '—'})`);
  if (s.bioKeywords) out.push(`Bio keywords (${s.bioKeywords.detail?.top || '—'})`);
  if (s.nameNgram)   out.push('Name character patterns');
  if (s.usernameDict) out.push(`Name found in username (${s.usernameDict.detail?.token || '—'})`);
  if (s.username)    out.push(`Username token (${s.username.detail?.token || '—'})`);
  return out;
}
