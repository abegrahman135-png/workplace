/**
 * repo.jobs.js — Durable, leased job queue. THE fix for P0-2.
 *
 * v1 ran enrichment in a plain for-loop inside the service worker with no
 * persistence. Chrome kills MV3 workers after ~30s idle; 500 profiles needs
 * 25+ minutes. Nothing ever restarted it, so ~90% of profiles stayed
 * `pending` forever and the dashboard showed ~10.
 *
 * Here the queue lives in IndexedDB. A worker LEASES jobs; if it dies the
 * lease expires and the next alarm tick reclaims them. Work always completes.
 */

import { db, STORES } from './schema.js';
import { JOB_STATUS, LANE_ORDER } from '../lib/constants.js';
import { backoffMs } from '../lib/utils.js';

export const LEASE_MS = 90_000;

export function jobId(type, username) {
  return `${type}:${username}`;
}

export function makeJob({ type = 'enrich', username, sessionId, lane = 'normal', priority = 50 }) {
  return {
    id: jobId(type, username),
    type,
    username,
    sessionId: sessionId || null,
    lane,
    priority,
    status: JOB_STATUS.PENDING,
    attempts: 0,
    leaseExpiresAt: 0,
    nextAttemptAt: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastError: null,
  };
}

/**
 * Reclaim expired leases, then atomically claim up to `n` jobs.
 * Claim order: fast lane first, then by descending priority.
 */
export async function claimBatch(n = 3) {
  const now = Date.now();
  return db.write([STORES.JOBS], async (t) => {
    const s = t.store(STORES.JOBS);
    const byLease = s.index('byLease');

    // 1. Reclaim anything whose worker died mid-flight.
    const expired = await byLease.getAll(IDBKeyRange.bound(1, now));
    for (const j of expired) {
      if (j.status !== JOB_STATUS.LEASED) continue;
      j.status = JOB_STATUS.PENDING;
      j.leaseExpiresAt = 0;
      j.updatedAt = now;
      await s.put(j);
    }

    // 2. Claim by lane priority.
    const claimed = [];
    const idx = s.index('byStatusLane');
    for (const lane of LANE_ORDER) {
      if (claimed.length >= n) break;
      const range = IDBKeyRange.bound(
        [JOB_STATUS.PENDING, lane, -Infinity],
        [JOB_STATUS.PENDING, lane, Infinity],
      );
      const rows = [];
      await idx.cursor(range, 'prev', (v) => {   // 'prev' => highest priority first
        if (v.nextAttemptAt && v.nextAttemptAt > now) return true; // still backing off
        rows.push(v);
        return rows.length < (n - claimed.length);
      });
      for (const j of rows) {
        j.status = JOB_STATUS.LEASED;
        j.attempts += 1;
        j.leaseExpiresAt = now + LEASE_MS;
        j.updatedAt = now;
        await s.put(j);
        claimed.push(j);
      }
    }
    return claimed;
  });
}

export async function completeJob(id) {
  return db.write([STORES.JOBS], async (t) => {
    await t.store(STORES.JOBS).delete(id);
  });
}

export async function failJob(id, error, maxAttempts = 5) {
  const now = Date.now();
  return db.write([STORES.JOBS], async (t) => {
    const s = t.store(STORES.JOBS);
    const j = await s.get(id);
    if (!j) return null;
    j.lastError = String(error?.message || error || 'unknown');
    j.updatedAt = now;
    if (j.attempts >= maxAttempts) {
      j.status = JOB_STATUS.DEAD;
      j.leaseExpiresAt = 0;
    } else {
      j.status = JOB_STATUS.PENDING;
      j.leaseExpiresAt = 0;
      j.nextAttemptAt = now + backoffMs(j.attempts);
    }
    await s.put(j);
    return j;
  });
}

/** Push a job back without consuming an attempt (rate limit / breaker open). */
/**
 * Defer = "not the job's fault" (rate budget, open breaker), so the attempt is
 * refunded and the job stays alive.
 *
 * DANGER, and the bug that hid a total enrichment outage for three releases:
 * refunding unconditionally means a permanent upstream failure (IG answering
 * 403 to every request) defers every job forever. attempts never reaches
 * maxAttempts, nothing is ever marked dead, no lastError is ever written - the
 * dashboard just shows "Queued N / 0 enriched" with no visible error at all.
 * `defers` is therefore counted separately and never refunded past its own cap.
 */
export const MAX_DEFERS = 20;

export async function deferJob(id, delayMs, reason = null) {
  const now = Date.now();
  return db.write([STORES.JOBS], async (t) => {
    const s = t.store(STORES.JOBS);
    const j = await s.get(id);
    if (!j) return null;
    j.defers = (j.defers || 0) + 1;
    if (reason) j.lastError = String(reason);
    if (j.defers >= MAX_DEFERS) {
      // Stop pretending this is transient - make it visible.
      j.status = JOB_STATUS.DEAD;
      j.leaseExpiresAt = 0;
      j.nextAttemptAt = 0;
      j.updatedAt = now;
      j.lastError = String(reason || j.lastError || 'deferred too many times');
      await s.put(j);
      return j;
    }
    j.status = JOB_STATUS.PENDING;
    j.attempts = Math.max(0, j.attempts - 1);
    j.leaseExpiresAt = 0;
    j.nextAttemptAt = now + delayMs;
    j.updatedAt = now;
    await s.put(j);
    return j;
  });
}

export async function enqueueMany(jobs) {
  if (!jobs.length) return 0;
  return db.write([STORES.JOBS], async (t) => {
    const s = t.store(STORES.JOBS);
    let n = 0;
    for (const j of jobs) {
      const existing = await s.get(j.id);
      if (existing && existing.status !== JOB_STATUS.DEAD) continue;
      await s.put(j);
      n++;
    }
    return n;
  });
}

export async function queueDepth() {
  return db.read([STORES.JOBS], async (t) => {
    const idx = t.index(STORES.JOBS, 'byStatus');
    const [pending, leased, dead] = await Promise.all([
      idx.count(IDBKeyRange.only(JOB_STATUS.PENDING)),
      idx.count(IDBKeyRange.only(JOB_STATUS.LEASED)),
      idx.count(IDBKeyRange.only(JOB_STATUS.DEAD)),
    ]);
    return { pending, leased, dead, total: pending + leased + dead };
  });
}

/**
 * The most common error currently blocking the queue, so the UI can say WHY
 * nothing is enriching instead of only that nothing is.
 */
export async function dominantError(sample = 200) {
  return db.read([STORES.JOBS], async (t) => {
    const tally = new Map();
    let n = 0;
    await t.store(STORES.JOBS).cursor(null, 'next', (j) => {
      if (j.lastError) {
        tally.set(j.lastError, (tally.get(j.lastError) || 0) + 1);
        n++;
      }
      return n < sample;
    });
    let top = null;
    for (const [msg, count] of tally) if (!top || count > top.count) top = { msg, count };
    return top;
  });
}

/** Resurrect dead jobs so the user can retry failures from the UI. */
export async function requeueDead() {
  return db.write([STORES.JOBS], async (t) => {
    const s = t.store(STORES.JOBS);
    const dead = await s.index('byStatus').getAll(IDBKeyRange.only(JOB_STATUS.DEAD));
    for (const j of dead) {
      j.status = JOB_STATUS.PENDING;
      j.attempts = 0;
      j.nextAttemptAt = 0;
      j.leaseExpiresAt = 0;
      j.lastError = null;
      j.updatedAt = Date.now();
      await s.put(j);
    }
    return dead.length;
  });
}

export async function clearJobs() {
  return db.write([STORES.JOBS], async (t) => { await t.store(STORES.JOBS).clear(); });
}
