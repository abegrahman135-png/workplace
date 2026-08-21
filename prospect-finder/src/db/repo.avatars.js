/**
 * repo.avatars.js — Cached profile-picture bytes.
 *
 * WHY THIS EXISTS
 * Instagram serves profile pictures from a CDN with HMAC-signed URLs that carry
 * an expiry (`?oe=<hex unix ts>&oh=<sig>`). A URL harvested during a scan stops
 * working within hours, so `<img src={harvestedUrl}>` on a dashboard opened
 * later 403s and every card silently falls back to a coloured initial.
 *
 * Fix: fetch the bytes DURING enrichment, while the URL is still valid, and
 * store them as a Blob. The dashboard then renders from a local object URL,
 * which never expires and works offline.
 *
 * Storage cost is bounded: images are downscaled to 96x96 WebP before storing,
 * which measures ~2-4 KB each, so 10k prospects is roughly 20-40 MB. The
 * extension holds `unlimitedStorage`.
 */

import { db, STORES } from './schema.js';
import { log } from '../lib/logger.js';

/** Longest we keep a cached avatar before refetching. */
export const AVATAR_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days

export async function getAvatar(username) {
  if (!username) return null;
  try {
    return (await db.get(STORES.AVATARS, username)) || null;
  } catch (_) {
    return null;
  }
}

/**
 * Bulk read for the dashboard grid — one transaction for a whole page of cards
 * instead of N round trips.
 * @returns {Promise<Map<string, Blob>>}
 */
export async function getAvatars(usernames) {
  const out = new Map();
  const list = [...new Set((usernames || []).filter(Boolean))];
  if (!list.length) return out;

  try {
    await db.read([STORES.AVATARS], async (t) => {
      const S = t.store(STORES.AVATARS);
      for (const u of list) {
        const row = await S.get(u);
        if (row?.blob) out.set(u, row.blob);
      }
    });
  } catch (e) {
    log.debug('avatars', 'bulk read failed', e?.message);
  }
  return out;
}

export async function putAvatar(username, blob, sourceUrl) {
  if (!username || !blob) return false;
  try {
    await db.put(STORES.AVATARS, {
      username,
      blob,
      bytes: blob.size,
      sourceUrl: sourceUrl || '',
      fetchedAt: Date.now(),
    });
    return true;
  } catch (e) {
    log.debug('avatars', 'write failed', e?.message);
    return false;
  }
}

export async function hasFreshAvatar(username) {
  const row = await getAvatar(username);
  return !!row && (Date.now() - (row.fetchedAt || 0)) < AVATAR_TTL_MS;
}

/** Total bytes held, for the Settings screen. */
export async function avatarCacheSize() {
  let bytes = 0, count = 0;
  try {
    await db.read([STORES.AVATARS], async (t) => {
      await t.store(STORES.AVATARS).cursor(null, 'next', (row) => {
        bytes += row.bytes || 0; count++;
        return true;
      });
    });
  } catch (_) {}
  return { bytes, count };
}

export async function clearAvatars() {
  try {
    await db.write([STORES.AVATARS], async (t) => { await t.store(STORES.AVATARS).clear(); });
    return true;
  } catch (_) {
    return false;
  }
}
