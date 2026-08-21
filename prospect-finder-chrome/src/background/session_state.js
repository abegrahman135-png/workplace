/**
 * session_state.js — Worker-restart-safe state. Fixes P2-15.
 * v1 kept currentProfile / activeSessionId in plain module globals, so a
 * service-worker restart mid-scan lost them: prospects were saved with
 * sourceUsernames:[''] and the popup showed "idle" during an active dig.
 */

const KEY = 'pf_runtime';

export async function getRuntime() {
  try {
    const r = await chrome.storage.session.get(KEY);
    return r[KEY] || { currentProfile: null, activeSessionId: null };
  } catch (_) {
    return { currentProfile: null, activeSessionId: null };
  }
}

export async function setRuntime(patch) {
  const cur = await getRuntime();
  const next = { ...cur, ...patch };
  try { await chrome.storage.session.set({ [KEY]: next }); } catch (_) {}
  return next;
}

export async function clearRuntime() {
  try { await chrome.storage.session.remove(KEY); } catch (_) {}
}
