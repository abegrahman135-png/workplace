export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export function clamp(v, min = 0, max = 100) {
  return Math.min(Math.max(v, min), max);
}

export function jitter(ms, pct = 0.3) {
  const delta = ms * pct;
  return Math.round(ms - delta + Math.random() * delta * 2);
}

export function backoffMs(attempt, base = 4000, max = 300000) {
  return Math.min(max, jitter(base * Math.pow(2, Math.max(0, attempt - 1))));
}

export function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

/** Instagram usernames: 1-30 chars, letters/digits/._ only. Guards the keyPath. */
const USERNAME_RE = /^[A-Za-z0-9._]{1,30}$/;
export function isValidUsername(u) {
  return typeof u === 'string' && USERNAME_RE.test(u);
}

export function fmtNum(n) {
  n = Number(n) || 0;
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K';
  return String(n);
}

export function relTime(ts) {
  if (!ts) return '—';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function debounce(fn, ms = 120) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** Parse "7d" | "24h" | "30m" into a ms duration. */
export function parseDuration(str) {
  const m = String(str).match(/^(\d+)\s*([smhdw])$/i);
  if (!m) return null;
  const n = Number(m[1]);
  return n * ({ s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 })[m[2].toLowerCase()];
}

export function deepGet(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}

export function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
