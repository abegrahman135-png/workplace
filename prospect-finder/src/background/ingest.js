/**
 * ingest.js — Atomic batch ingestion. THE fix for P0-1.
 *
 * v1 sequence (broken):
 *   1. processedUsernames.put(user)      <- committed immediately
 *   2. ...build record...
 *   3. prospects.bulkPut(all)            <- ONE all-or-nothing transaction
 *
 * One malformed username aborted step 3 and discarded all 50 records — but
 * step 1 had already committed, so `alreadyProcessed` skipped those users on
 * every future scan. They became permanently invisible with no repair path.
 *
 * v2 writes prospects + jobs + processedUsernames in ONE transaction, so the
 * processed-marker cannot outlive the record it refers to. Invalid usernames
 * are filtered out before the transaction opens.
 */

import { db, STORES } from '../db/schema.js';
import { makeProspect } from '../db/repo.prospects.js';
import { makeJob } from '../db/repo.jobs.js';
import { mergeProspect } from '../engines/dedup.js';
import { classifyTier1 } from '../engines/classifier/index.js';
import { triage } from '../engines/qualification.js';
import { isValidUsername } from '../lib/utils.js';
import { JOB_STATUS } from '../lib/constants.js';
import { log } from '../lib/logger.js';

export function normalizeRawUser(raw) {
  // Instagram's list payloads can contain null/undefined slots and occasionally
  // primitives. Guard here: a single bad entry must never abort the batch,
  // which is the P0-1 silent-data-loss failure mode this rewrite exists to fix.
  if (!raw || typeof raw !== 'object') return { username: '' };
  return {
    username: String(raw.username || raw.userName || '').trim(),
    full_name: raw.full_name || raw.fullName || '',
    profile_pic_url: raw.profile_pic_url || raw.profilePicUrl || '',
    is_private: Boolean(raw.is_private ?? raw.isPrivate),
    is_verified: Boolean(raw.is_verified ?? raw.isVerified),
    followed_by_viewer: Boolean(raw.followed_by_viewer ?? raw.followedByViewer),
    requested_by_viewer: Boolean(raw.requested_by_viewer ?? raw.requestedByViewer),
    follows_viewer: Boolean(raw.follows_viewer ?? raw.followsViewer),
    media_count: raw.media_count ?? raw.post_count ?? undefined,
    follower_count: raw.follower_count ?? undefined,
    following_count: raw.following_count ?? undefined,
  };
}

/**
 * @returns {{seen:number, inserted:number, merged:number, rejected:number, invalid:string[]}}
 */
export async function ingestBatch({ sessionId, sourceUsername, users, settings }) {
  const seen = users.length;
  const invalid = [];
  const clean = [];

  for (const u of users) {
    const n = normalizeRawUser(u);
    if (!isValidUsername(n.username)) { invalid.push(n.username || '(empty)'); continue; }
    clean.push(n);
  }

  // De-dupe within the batch itself (IG pagination can repeat entries).
  const byName = new Map();
  for (const u of clean) byName.set(u.username, u);
  const unique = [...byName.values()];

  let inserted = 0;
  let merged = 0;

  if (unique.length) {
    await db.write(
      [STORES.PROSPECTS, STORES.JOBS, STORES.PROCESSED],
      async (t) => {
        const P = t.store(STORES.PROSPECTS);
        const J = t.store(STORES.JOBS);
        const U = t.store(STORES.PROCESSED);

        for (const u of unique) {
          const existing = await P.get(u.username);

          if (existing) {
            await P.put(mergeProspect(existing, { sessionId, sourceUsername }));
            merged++;
          } else {
            const evidence = classifyTier1(u);
            const { priority, lane } = triage(u, evidence, settings);

            const prospect = makeProspect({
              username: u.username,
              raw: u,
              sessionId,
              sourceUsername,
              evidence,
              lane,
              priority,
            });
            await P.put(prospect);

            const existingJob = await J.get(`enrich:${u.username}`);
            if (!existingJob) {
              await J.put(makeJob({ username: u.username, sessionId, lane, priority }));
            }
            inserted++;
          }

          // Marker commits in the SAME transaction as the record.
          await U.put({ username: u.username, lastSeenAt: Date.now() });
        }
      },
    );
  }

  if (invalid.length) {
    log.warn('ingest', `${invalid.length} invalid usernames skipped`, invalid.slice(0, 5));
  }

  return { seen, inserted, merged, rejected: invalid.length, invalid };
}

/** Requeue anything that is not fully scored (used by migration + repair). */
export async function requeueUnfinished() {
  const jobs = [];
  await db.read([STORES.PROSPECTS], async (t) => {
    await t.store(STORES.PROSPECTS).cursor(null, 'next', (p) => {
      if (p.stage !== 'scored' && p.status !== 'rejected') {
        jobs.push(makeJob({
          username: p.username,
          sessionId: p.sessionIds?.[0] || null,
          lane: p.lane || 'normal',
          priority: p.priority ?? 50,
        }));
      }
      return true;
    });
  });
  if (!jobs.length) return 0;
  return db.write([STORES.JOBS], async (t) => {
    const J = t.store(STORES.JOBS);
    let n = 0;
    for (const j of jobs) {
      const ex = await J.get(j.id);
      if (ex && ex.status !== JOB_STATUS.DEAD) continue;
      await J.put(j);
      n++;
    }
    return n;
  });
}
