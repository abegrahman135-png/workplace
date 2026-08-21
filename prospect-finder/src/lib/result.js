/**
 * result.js — Explicit success/failure values.
 * Bans the `catch {}` pattern that silently ate 50 prospects at a time in v1.
 */

export function Ok(value) {
  return { ok: true, value, error: null };
}

export function Err(error, meta = {}) {
  return { ok: false, value: null, error: normalizeError(error), meta };
}

export function normalizeError(e) {
  if (e instanceof Error) return { name: e.name, message: e.message, stack: e.stack };
  if (typeof e === 'string') return { name: 'Error', message: e, stack: null };
  return { name: 'Error', message: String(e), stack: null };
}

/** Run an async fn, never throw, always return a Result. */
export async function attempt(fn, meta = {}) {
  try {
    return Ok(await fn());
  } catch (e) {
    return Err(e, meta);
  }
}

export function unwrapOr(result, fallback) {
  return result && result.ok ? result.value : fallback;
}
