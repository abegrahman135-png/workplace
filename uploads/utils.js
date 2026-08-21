export function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function jitter(maxMs) {
  return Math.floor(Math.random() * maxMs);
}

export function clamp(value, min = 0, max = 100) {
  return Math.min(Math.max(value, min), max);
}

export function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

export function extractFirstName(fullName) {
  if (!fullName) return '';
  const firstPart = fullName.trim().split(/\s+/)[0];
  return firstPart ? firstPart.toLowerCase() : '';
}

export function sanitizeForCsv(str) {
  if (str == null) return '';
  let sanitized = String(str).replace(/\n|\r/g, ' ');
  sanitized = sanitized.replace(/,/g, ';');
  if (sanitized.includes(';') || sanitized.includes('"')) {
    sanitized = `"${sanitized.replace(/"/g, '""')}"`;
  }
  return sanitized;
}

export function formatDate(timestamp) {
  return new Date(timestamp).toISOString();
}

export function numberOr(value, fallback = 0) {
  const parsed = Number(value);
  return isNaN(parsed) ? fallback : parsed;
}

export function booleanOr(value) {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') {
    const lower = value.toLowerCase().trim();
    return lower === 'true' || lower === '1' || lower === 'yes';
  }
  return Boolean(value);
}
