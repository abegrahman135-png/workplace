/**
 * rate_limiter.js — Adaptive pacing + circuit breaker.
 *
 * State REALLY persists in chrome.storage.session now. It previously only
 * claimed to: both classes were plain module variables, and Chrome evicts an
 * idle MV3 worker in ~30s. Every alarm tick therefore booted a breaker with
 * failures=0 and a limiter with an empty rate window, immediately re-hammered
 * Instagram, took a 429, tripped, and died again before the cooldown could
 * elapse. Measured effect: a permanent freeze at 20/60 with a 52% 429 rate.
 *
 * A cooldown that does not outlive the process is not a cooldown.
 */

import { sleep, jitter } from '../lib/utils.js';

/**
 * Separate keys per component. A single shared key plus fire-and-forget
 * read-modify-write meant the limiter's frequent pacing writes silently
 * clobbered the breaker's openedAt/trips - the cooldown vanished from storage
 * and every new worker re-probed Instagram immediately.
 */
const LIMITER_KEY = 'pf-limiter-state';
const BREAKER_KEY = 'pf-breaker-state';

async function readKey(key) {
  try {
    const o = await chrome.storage.session.get(key);
    return o?.[key] || null;
  } catch (_) { return null; }
}

async function writeKey(key, value) {
  try {
    await chrome.storage.session.set({ [key]: value });
  } catch (_) { /* storage unavailable in tests */ }
}

export class AdaptiveRateLimiter {
  constructor({ baseDelayMs = 1500, maxDelayMs = 8000, perMinuteCap = 35 } = {}) {
    this.base = baseDelayMs;
    this.max = maxDelayMs;
    this.cap = perMinuteCap;
    this.current = baseDelayMs;
    this.errors = 0;
    this.count = 0;
    this.windowStart = Date.now();
  }

  /**
   * Reserve a request slot.
   *
   * `deadline` is the pump's budget. Sleeping past it is what made the queue
   * appear stuck: with perMinuteCap=35 and concurrency=3, the cap is hit
   * ~12s into a 50s budget, and the old code then slept the remaining ~48s of
   * the minute window INSIDE the pump. The pump overran its budget, the alarm
   * refused to start a second pass (`running` was still true), and throughput
   * collapsed to a trickle that looked like a freeze.
   *
   * Now we refuse the slot instead of oversleeping, and the caller stops
   * cleanly so the next alarm tick picks up with a fresh window.
   *
   * @returns {Promise<boolean>} false => no slot available before the deadline
   */
  /** Reload the rolling window written by a previous worker generation. */
  async hydrate() {
    const st = await readKey(LIMITER_KEY);
    if (!st) return this;
    if (typeof st.windowStart === 'number') this.windowStart = st.windowStart;
    if (typeof st.count === 'number') this.count = st.count;
    if (typeof st.current === 'number') this.current = st.current;
    return this;
  }

  async persist() {
    await writeKey(LIMITER_KEY, {
      windowStart: this.windowStart, count: this.count, current: this.current,
    });
  }

  async waitForSlot(deadline = Infinity) {
    const now = Date.now();
    if (now - this.windowStart >= 60_000) {
      this.windowStart = now;
      this.count = 0;
    }
    if (this.count >= this.cap) {
      const wait = Math.max(0, 60_000 - (now - this.windowStart));
      if (wait > 0) {
        if (Date.now() + wait > deadline) return false;  // don't blow the budget
        await sleep(wait);
      }
      this.windowStart = Date.now();
      this.count = 0;
    }
    const pace = jitter(this.current, 0.35);
    if (Date.now() + pace > deadline) return false;
    this.count++;
    await this.persist();          // survive worker eviction mid-window
    await sleep(pace);
    return true;
  }

  reportSuccess() {
    this.errors = 0;
    this.current = Math.max(this.base, this.current * 0.9);
    void this.persist();
  }

  reportError(status) {
    this.errors++;
    if (status === 429) this.current = Math.min(this.max, this.current * Math.pow(2, this.errors));
    else if (status === 401 || status === 403) this.current = this.max;
    void this.persist();
  }

  snapshot() {
    return { currentDelay: Math.round(this.current), errors: this.errors, thisMinute: this.count };
  }
}

export class CircuitBreaker {
  constructor({ threshold = 5, cooldownMs = 5 * 60_000 } = {}) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
    this.failures = 0;
    this.openedAt = 0;
    this.until = 0;   // honours an explicit Retry-After
  }

  /** Restore an in-flight cooldown from a previous worker generation. */
  async hydrate() {
    const st = await readKey(BREAKER_KEY);
    if (!st) return this;
    if (typeof st.openedAt === 'number') this.openedAt = st.openedAt;
    if (typeof st.failures === 'number') this.failures = st.failures;
    if (typeof st.until === 'number') this.until = st.until;
    if (typeof st.cooldownMs === 'number') this.cooldownMs = st.cooldownMs;
    if (typeof st.trips === 'number') this.trips = st.trips;
    return this;
  }

  async persist() {
    await writeKey(BREAKER_KEY, {
      openedAt: this.openedAt, failures: this.failures, until: this.until,
      cooldownMs: this.cooldownMs, trips: this.trips || 0,
    });
  }
  get isOpen() {
    if (this.until && Date.now() < this.until) return true;
    if (!this.openedAt) return false;
    if (Date.now() - this.openedAt > this.cooldownMs) { this.reset(); return false; }
    return true;
  }
  remaining() {
    const byUntil = this.until ? Math.max(0, this.until - Date.now()) : 0;
    const byOpen = this.openedAt ? Math.max(0, this.cooldownMs - (Date.now() - this.openedAt)) : 0;
    return Math.max(byUntil, byOpen);
  }
  /**
   * @param {number} [retryAfterMs] honour Instagram's own Retry-After when it
   *   sends one; otherwise back off exponentially per consecutive trip so a
   *   sustained block widens the gap instead of re-probing every 5 minutes.
   */
  trip(retryAfterMs = 0) {
    this.openedAt = Date.now();
    this.trips = (this.trips || 0) + 1;
    const backoff = Math.min(30 * 60_000, 60_000 * Math.pow(2, this.trips - 1));
    this.cooldownMs = Math.max(backoff, 60_000);
    if (retryAfterMs > 0) this.until = Date.now() + retryAfterMs;
    void this.persist();
  }
  fail() { if (++this.failures >= this.threshold) this.trip(); else void this.persist(); }
  reset() {
    this.failures = 0; this.openedAt = 0; this.until = 0; this.trips = 0;
    this.cooldownMs = 5 * 60_000;
    void this.persist();
  }
  snapshot() {
    return {
      open: this.isOpen, failures: this.failures,
      cooldownRemainingMs: this.remaining(), trips: this.trips || 0,
    };
  }
}
