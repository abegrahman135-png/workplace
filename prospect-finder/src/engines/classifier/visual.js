/**
 * visual.js — Profile-photo gender inference via an OFFSCREEN DOCUMENT.
 *
 * v1's face_gender.js called importScripts() inside a `"type":"module"`
 * service worker. That always throws, so this 20%-weight signal was dead in
 * 100% of runs. MV3 modules cannot use importScripts at all.
 *
 * v2 delegates to chrome.offscreen, which has a real DOM + canvas.
 *
 * ⚠ COMPLIANCE: biometric inference on people who never consented is
 * special-category data under GDPR Art.9 and separately regulated by BIPA
 * (Illinois) with statutory per-violation damages. Therefore this is:
 *   - OFF by default (DEFAULT_SETTINGS.enableVisualClassifier = false)
 *   - opt-in, with a plain-language warning in Settings
 *   - restricted to the fast lane so it runs on few images
 */

import { log } from '../../lib/logger.js';
import { signal } from './evidence.js';

const OFFSCREEN_PATH = 'src/ui/offscreen.html';

/**
 * CIRCUIT BREAKER for the vision layer.
 *
 * The offscreen document must load a 1.3MB library plus ~620KB of weights on
 * first use. If that fails — or is simply slow — every single job would pay the
 * full timeout, and with 471 queued profiles the pump would appear frozen at 0.
 * After a few consecutive failures we disable the layer for this worker
 * lifetime; text classification continues unaffected.
 */
let visualFails = 0;
let visualDisabled = false;
const VISUAL_FAIL_LIMIT = 3;

export function visualHealth() {
  return { disabled: visualDisabled, fails: visualFails };
}

export function _resetVisualHealth() { visualFails = 0; visualDisabled = false; }
let creating = null;

async function hasOffscreen() {
  if (!chrome.runtime.getContexts) return false;
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return ctx.length > 0;
}

async function ensureOffscreen() {
  if (!chrome.offscreen) return false;
  if (await hasOffscreen()) return true;
  if (creating) { await creating; return true; }
  creating = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['DOM_SCRAPING'],
    justification: 'Run local image analysis on profile pictures (user opt-in).',
  });
  try {
    await creating;
    return true;
  } catch (e) {
    log.warn('visual', 'offscreen create failed', e);
    return false;
  } finally {
    creating = null;
  }
}

/**
 * @returns {Promise<null|{score:number,confidence:number}>}
 */
export async function detectGenderFromPic(picUrl, { timeoutMs = 6000, username = null } = {}) {
  if (!picUrl && !username) return null;
  if (visualDisabled) return null;

  const ok = await ensureOffscreen();
  if (!ok) {
    if (++visualFails >= VISUAL_FAIL_LIMIT) {
      visualDisabled = true;
      log.warn('visual', 'disabling visual layer: offscreen unavailable');
    }
    return null;
  }

  try {
    const res = await Promise.race([
      chrome.runtime.sendMessage({ type: 'OFFSCREEN_ANALYZE_FACE', url: picUrl, username }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs)),
    ]);
    // A real answer (even "no face") proves the pipeline works.
    visualFails = 0;
    if (!res || !res.detected) return null;
    return { score: res.score, confidence: res.confidence, detail: res.detail };
  } catch (e) {
    // Timeouts and messaging errors are what freeze the queue — count them.
    if (++visualFails >= VISUAL_FAIL_LIMIT) {
      visualDisabled = true;
      log.warn('visual', `disabling visual layer after ${visualFails} failures: ${e?.message}`);
    }
    log.debug('visual', 'analysis unavailable', e?.message);
    return null;
  }
}

/**
 * Should the photo layer run for this profile?
 *
 * The point of the visual pass is to RESOLVE UNCERTAINTY, so spend it where
 * the text layers were inconclusive rather than on profiles already decided.
 * A name-dictionary hit at high confidence needs no photo; an `unknown` or
 * `ambiguous` verdict is exactly what this tier exists for.
 *
 * @param {{value:number,confidence:number,verdict:string}} textEvidence
 */
export function shouldRunVisual(textEvidence, settings, lane) {
  if (!settings?.enableVisualClassifier) return false;
  // The model failed repeatedly — never block the queue on it again.
  if (visualDisabled) return false;
  const conf = textEvidence?.confidence ?? 0;
  const verdict = textEvidence?.verdict || 'unknown';

  // A real dictionary name outranks anything a thumbnail can tell us, so never
  // let a photo dilute it. (Combining is a weighted average: a contradicting
  // 0.9-confidence photo drags a certain nameExact hit to "ambiguous".)
  if (textEvidence?.signals?.nameExact?.confidence >= 0.8) return false;

  // Already decisive — don't spend a download/inference on it.
  if (conf >= 0.8) return false;

  // The uncertain band: this is what the layer is for.
  const uncertain = verdict === 'unknown' || verdict === 'ambiguous' || conf < 0.55;
  if (!uncertain) return false;

  // Respect the fast-lane restriction only as a throughput guard.
  if (settings.visualFastLaneOnly && lane !== 'fast') return false;
  return true;
}

export async function visualSignals(picUrl, settings, lane, textEvidence, username) {
  // Back-compat: with no text evidence supplied, fall back to the old rule.
  const gate = textEvidence === undefined
    ? (settings?.enableVisualClassifier && !(settings.visualFastLaneOnly && lane !== 'fast'))
    : shouldRunVisual(textEvidence, settings, lane);
  if (!gate) return [];

  const r = await detectGenderFromPic(picUrl, { username });
  if (!r) return [];
  return [signal('visual', r.score, r.confidence, r.detail)];
}
