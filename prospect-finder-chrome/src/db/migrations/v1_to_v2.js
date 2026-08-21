/**
 * v1_to_v2.js — Schema migration + DATA REPAIR
 *
 * The repair here is the important part. In v1, `processedUsernames.put()`
 * committed BEFORE `prospects.bulkPut()`, and bulkPut was one all-or-nothing
 * transaction. A single malformed record aborted the whole batch — but the
 * users were already marked "processed", so re-scanning skipped them forever.
 *
 * Step 1 below deletes every processed-marker that has no matching prospect
 * row, making those users re-scannable. On a real v1 install this typically
 * resurrects hundreds of silently-lost profiles.
 */

import { STORES } from '../schema.js';
import { STAGE, LABEL, LANE, JOB_STATUS, SCORE_VERSION } from '../../lib/constants.js';
import { log } from '../../lib/logger.js';

/**
 * Runs INSIDE the versionchange transaction. Must use raw IDB request APIs
 * only — no awaiting outside the transaction's microtask window, or Chrome
 * auto-commits it out from under us.
 */
export function repairInUpgrade(tx) {
  const report = { orphansRemoved: 0, prospectsUpgraded: 0, jobsRequeued: 0 };

  let prospects, processed, jobs;
  try {
    prospects = tx.objectStore(STORES.PROSPECTS);
    processed = tx.objectStore(STORES.PROCESSED);
    jobs = tx.objectStore(STORES.JOBS);
  } catch (e) {
    log.warn('migrate', 'stores unavailable during upgrade', e);
    return;
  }

  // ── Pass 1: upgrade every prospect row to the v2 shape ──────────────────
  const known = new Set();
  prospects.openCursor().onsuccess = (ev) => {
    const cur = ev.target.result;
    if (!cur) {
      // Pass 1 finished -> run pass 2 (orphan sweep) with the collected keys.
      sweepOrphans(processed, known, report);
      return;
    }
    const v = cur.value;
    known.add(v.username);

    const upgraded = upgradeProspect(v);
    if (upgraded) {
      cur.update(upgraded);
      report.prospectsUpgraded++;

      // Anything not fully scored gets re-queued so the new durable queue
      // finishes the work v1 abandoned when its worker died.
      if (upgraded.stage !== STAGE.SCORED && upgraded.stage !== STAGE.DEAD) {
        jobs.put({
          id: `enrich:${upgraded.username}`,
          type: 'enrich',
          username: upgraded.username,
          sessionId: (upgraded.sessionIds && upgraded.sessionIds[0]) || null,
          lane: LANE.NORMAL,
          priority: 50,
          status: JOB_STATUS.PENDING,
          attempts: 0,
          leaseExpiresAt: 0,
          createdAt: Date.now(),
          lastError: null,
        });
        report.jobsRequeued++;
      }
    }
    cur.continue();
  };

  tx.addEventListener('complete', () => {
    log.info('migrate', 'v1->v2 complete', report);
    try {
      // Surface the repair result to the UI on next boot.
      localStorage?.setItem('pf_migration_report', JSON.stringify({ ...report, at: Date.now() }));
    } catch (_) { /* no localStorage in SW context */ }
  });
}

function sweepOrphans(processedStore, known, report) {
  processedStore.openCursor().onsuccess = (ev) => {
    const cur = ev.target.result;
    if (!cur) return;
    const uname = cur.value?.username ?? cur.key;
    if (!known.has(uname)) {
      // Orphan: marked processed but never persisted. Free it for re-scan.
      cur.delete();
      report.orphansRemoved++;
    }
    cur.continue();
  };
}

/** Map a v1 prospect record onto the v2 shape. Returns null if already v2. */
export function upgradeProspect(v) {
  if (v && v.schemaVersion === 2) return null;

  const raw = v.raw || {};
  const enr = v.enriched || null;

  const posts = enr?.post_count ?? raw.media_count ?? 0;
  const followers = enr?.follower_count ?? raw.follower_count ?? 0;
  const following = enr?.following_count ?? raw.following_count ?? 0;

  // v1 stored enrichmentStatus: pending | enriched | failed | skipped
  const es = v.enrichmentStatus;
  let stage;
  if (v.status === 'deleted') stage = STAGE.DEAD;
  else if (es === 'enriched' && v.scored) stage = STAGE.SCORED;
  else if (es === 'failed') stage = STAGE.FAILED;
  else stage = STAGE.QUEUED; // pending | skipped | undefined -> re-queue

  // v1's 'excluded'/'skipped' records were dropped from the funnel by the
  // Tier-1 female gate. v2 has no kill gate, so give them a real second pass.
  const femaleScore = Number(v.femaleScore) || 0;

  const status = v.status === 'rejected' ? 'rejected'
               : v.status === 'followed' ? 'followed'
               : v.status === 'deleted' ? 'archived'
               : 'active';

  return {
    username: v.username,
    raw,
    enriched: enr,
    metrics: { posts, followers, following },
    evidence: {
      female: {
        value: femaleScore,
        confidence: femaleScore ? 0.4 : 0,
        verdict: 'unknown',
        sources: [],
      },
    },
    scored: null,          // force a clean re-score under SCORE_VERSION 2
    stage,
    status,
    label: LABEL.PENDING,
    femaleScore,
    femaleConfidence: femaleScore ? 0.4 : 0,
    finalScore: null,
    accountType: v.accountType || null,
    manualPriority: !!v.manualPriority,
    sessionIds: v.sessionIds || [],
    sourceUsernames: (v.sourceUsernames || []).filter(Boolean),
    searchTokens: [],      // rebuilt on next write / rescore
    attempts: 0,
    lastError: null,
    firstSeenAt: v.firstSeenAt || Date.now(),
    lastSeenAt: v.lastSeenAt || Date.now(),
    enrichedAt: v.enrichedAt || null,
    scoreVersion: 0,       // < SCORE_VERSION -> eligible for rescore
    schemaVersion: 2,
  };
}
