/**
 * scheduler.js — THE FIX for P0-2.
 *
 * v1 called processEnrichmentQueue() from exactly one place: the end of
 * handleFollowerBatch(). There was no alarm, no onStartup hook, nothing that
 * ever restarted it. 500 profiles needs 25+ minutes at v1's pacing; Chrome
 * kills an idle MV3 service worker in ~30 seconds. The queue died around
 * profile 30-60 and NEVER resumed — which is why the dashboard showed ~10.
 *
 * v2: a 1-minute chrome.alarm (the MV3 minimum) drives a self-limiting pump.
 * Registered on onStartup AND onInstalled, so it survives worker death,
 * browser restart, and extension reload. Jobs are leased; a worker that dies
 * mid-flight has its lease reclaimed by the next tick.
 */

import { claimBatch, completeJob, failJob, deferJob, queueDepth, requeueDead, makeJob } from '../db/repo.jobs.js';
import { runEnrichJob, markFailed, getProxyStats } from './enricher.js';
import { AdaptiveRateLimiter, CircuitBreaker } from './rate_limiter.js';
import { loadSettings } from '../db/repo.settings.js';
import { db, STORES } from '../db/schema.js';
import { log } from '../lib/logger.js';
import { visualHealth } from '../engines/classifier/visual.js';
import { broadcast } from './broadcast.js';
import { DEFAULT_SETTINGS, STAGE } from '../lib/constants.js';

export const ALARM_PUMP = 'pf-queue-pump';

// Leave headroom inside the alarm window so we never overlap the next tick.
const PUMP_BUDGET_MS = 50_000;

let running = false;
let runningSince = 0;

// If a pump somehow exceeds this, treat it as wedged and let the next tick in.
const PUMP_STUCK_MS = 4 * 60_000;
let limiter = null;
let breaker = null;
let cachedSettings = { ...DEFAULT_SETTINGS };

export function installScheduler() {
  chrome.runtime.onStartup.addListener(bootPump);
  chrome.runtime.onInstalled.addListener(bootPump);
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === ALARM_PUMP) pump().catch(e => log.error('sched', 'pump failed', e));
  });
  // Also arm immediately for the current worker lifetime.
  bootPump();
}

export function bootPump() {
  chrome.alarms.create(ALARM_PUMP, { periodInMinutes: 1, delayInMinutes: 0 });
  log.info('sched', 'queue pump armed');
}

export async function ensureSettings() {
  try { cachedSettings = await loadSettings(); } catch (_) {}
  if (!limiter) {
    limiter = new AdaptiveRateLimiter({
      baseDelayMs: cachedSettings.enrichDelayMs,
      maxDelayMs: cachedSettings.enrichMaxDelayMs,
      perMinuteCap: cachedSettings.perMinuteCap,
    });
  }
  if (!breaker) breaker = new CircuitBreaker();
  // A fresh worker generation MUST inherit the previous one's throttle state,
  // otherwise every alarm tick re-probes Instagram with failures=0 and an
  // empty rate window - which is what pinned the queue at a 52% 429 rate.
  await limiter.hydrate();
  await breaker.hydrate();
  return cachedSettings;
}

export function schedulerHealth() {
  return {
    running,
    limiter: limiter?.snapshot() || null,
    breaker: breaker?.snapshot() || null,
    // Surface a silently-degraded vision layer instead of hiding it.
    visual: visualHealth(),
    // Proxy stats for the dashboard
    proxy: getProxyStats(),
  };
}

/**
 * Drain the queue for up to PUMP_BUDGET_MS, then yield so the worker can
 * idle out cleanly. The next alarm tick continues from the database.
 */
export async function pump() {
  // A pump that dies between `running = true` and its finally block (worker
  // eviction, uncaught rejection) would otherwise latch this flag forever and
  // every subsequent alarm would no-op. That is indistinguishable from a
  // frozen queue. Time-box the guard.
  if (running && Date.now() - runningSince < PUMP_STUCK_MS) {
    return { skipped: 'already_running' };
  }
  if (running) log.warn('sched', 'previous pump wedged; forcing a new pass');

  running = true;
  const started = Date.now();
  runningSince = started;
  let processed = 0;
  let failures = 0;

  try {
    await db.open();
    const settings = await ensureSettings();
    const concurrency = Math.max(1, Math.min(6, settings.enrichConcurrency || 3));

    // Check the breaker ONCE, before claiming anything. Previously the pump
    // claimed a batch and let each job discover the open breaker itself, which
    // leased-then-deferred 3 jobs and burned 3 real requests on every tick of
    // a block - the exact behaviour that kept Instagram angry.
    if (breaker.isOpen) {
      const wait = breaker.remaining();
      log.warn('sched', `throttled by Instagram; cooling down ${Math.round(wait / 1000)}s`);
      broadcast({ scope: 'progress', cooldownMs: wait });
      return { processed: 0, failures: 0, cooling: wait, depth: await queueDepth() };
    }

    while (Date.now() - started < PUMP_BUDGET_MS) {
      const jobs = await claimBatch(concurrency);
      if (!jobs.length) break;

      const results = await Promise.all(jobs.map(async (job) => {
        try {
          const r = await runEnrichJob(job, {
            limiter, breaker, settings, deadline: started + PUMP_BUDGET_MS,
          });
          if (r.outcome === 'done') { await completeJob(job.id); return 'done'; }
          if (r.outcome === 'dead') { await completeJob(job.id); return 'dead'; }
          if (r.reason === 'rate_budget_exhausted') {
            await deferJob(job.id, r.after, null);   // genuinely our own pacing
            return 'rate_budget';
          }
          if (r.after) await deferJob(job.id, r.after, r.reason);
          else await failJob(job.id, r.reason, settings.maxAttempts);
          return 'retry';
        } catch (e) {
          log.warn('sched', `job ${job.id} threw`, e?.message);
          await markFailed(job.username, e?.message);
          await failJob(job.id, e, settings.maxAttempts);
          return 'error';
        }
      }));

      processed += results.filter(r => r === 'done' || r === 'dead').length;
      failures += results.filter(r => r === 'retry' || r === 'error').length;

      broadcast({ scope: 'progress' });

      // Everything is backing off - stop burning the budget.
      if (results.every(r => r !== 'done')) {
        if (breaker.isOpen) break;
      }
      // Rate budget is spent for this window; yield to the next alarm tick.
      if (results.some(r => r === 'rate_budget')) break;
    }

    const depth = await queueDepth();
    broadcast({ scope: 'progress', queue: depth });

    if (depth.pending === 0 && depth.leased === 0) {
      log.info('sched', 'queue drained');
    }
    return { processed, failures, depth };
  } finally {
    running = false;
  }
}

/** Manual kick from the dashboard/popup — no need to wait for the alarm. */
export async function pumpNow() {
  return pump();
}

export async function retryFailed() {
  // Two distinct populations must be revived:
  //  1. Jobs parked as DEAD (exhausted attempts) — the job row still exists.
  //  2. Prospects marked STAGE.DEAD/FAILED whose job row was already consumed
  //     (e.g. a 404 terminates the job). Without this, the dashboard's Retry
  //     button reported "0 requeued" while dead prospects sat unreachable.
  const n = await requeueAllFailed();
  await pumpNow();
  return n;
}

/** Pure requeue: revive dead jobs AND dead prospects. No network, no pump. */
export async function requeueAllFailed() {
  const n = await requeueDead();
  const m = await requeueDeadProspects();
  return n + m;
}

/** Re-create enrich jobs for prospects stuck in a terminal stage. */
async function requeueDeadProspects() {
  const stuck = [];
  await db.read([STORES.PROSPECTS], async (t) => {
    await t.store(STORES.PROSPECTS).cursor(null, 'next', (p) => {
      if (p.stage === STAGE.DEAD || p.stage === STAGE.FAILED) stuck.push(p);
      return true;
    });
  });
  if (!stuck.length) return 0;

  const jobs = stuck.map((p) => makeJob({
    type: 'enrich',
    username: p.username,
    sessionId: (p.sessionIds && p.sessionIds[p.sessionIds.length - 1]) || null,
    lane: p.lane || 'normal',
    priority: p.priority ?? 50,
  }));

  await db.write([STORES.PROSPECTS, STORES.JOBS], async (t) => {
    const P = t.store(STORES.PROSPECTS);
    const J = t.store(STORES.JOBS);
    for (const p of stuck) {
      await P.put({ ...p, stage: STAGE.QUEUED, lastError: null, attempts: 0 });
    }
    for (const j of jobs) await J.put(j);
  });
  return stuck.length;
}
