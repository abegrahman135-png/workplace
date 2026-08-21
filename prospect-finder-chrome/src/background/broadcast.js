/**
 * broadcast.js — Push updates to open dashboards.
 * Replaces v1's setInterval polling that was gated on `state.activeSession`
 * and therefore froze the moment a scan completed (while enrichment kept
 * running for another 20 minutes).
 */

import { DATA_CHANNEL } from '../lib/constants.js';

let channel = null;

function chan() {
  if (channel) return channel;
  if (typeof BroadcastChannel === 'undefined') return null;
  channel = new BroadcastChannel(DATA_CHANNEL);
  return channel;
}

export function broadcast(payload) {
  try { chan()?.postMessage({ ...payload, at: Date.now() }); } catch (_) {}
}

export function onBroadcast(handler) {
  const c = chan();
  if (!c) return () => {};
  const fn = (e) => handler(e.data);
  c.addEventListener('message', fn);
  return () => c.removeEventListener('message', fn);
}
