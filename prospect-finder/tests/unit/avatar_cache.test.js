/**
 * avatar_cache.test.js — profile pictures on dashboard cards.
 *
 * The card component ALREADY rendered <img src={profile_pic_url}>, yet the grid
 * showed only coloured initials. Root cause: Instagram CDN URLs are HMAC-signed
 * and carry an expiry:
 *
 *   .../t51.2885-19/449_n.jpg?...&oh=<sig>&oe=<hex unix expiry>
 *
 * A URL harvested during a scan 403s within hours, so every <img> fired onerror
 * and fell back to the initial. Fix: cache the BYTES during enrichment, while
 * the signature is still valid, and render from a local blob.
 */
import '../helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { db, STORES } = await import('../../src/db/schema.js');
const { putAvatar, getAvatar, getAvatars, hasFreshAvatar, avatarCacheSize, clearAvatars, AVATAR_TTL_MS } =
  await import('../../src/db/repo.avatars.js');
const { DB_VERSION } = await import('../../src/lib/constants.js');

const CARD = readFileSync(join(process.cwd(), 'src', 'ui', 'components', 'ProspectCard.js'), 'utf8');
const ENRICHER = readFileSync(join(process.cwd(), 'src', 'background', 'enricher.js'), 'utf8');
const APP = readFileSync(join(process.cwd(), 'src', 'ui', 'app.js'), 'utf8');

const blobOf = (str) => new Blob([str], { type: 'image/webp' });

test('the CDN expiry that caused the bug', async (t) => {
  await t.test('signed URLs carry a decodable expiry', () => {
    const url = 'https://scontent.cdninstagram.com/v/t51.2885-19/449_n.jpg?oh=00_AY&oe=66D4F1A2';
    const oe = new URL(url).searchParams.get('oe');
    const expires = parseInt(oe, 16) * 1000;
    assert.ok(Number.isFinite(expires));
    // This sample is long past — exactly the state a stored URL ends up in.
    assert.ok(expires < Date.now(), 'sample URL should be expired');
  });
});

test('schema carries the avatars store', async (t) => {
  await t.test('DB version was bumped so existing installs upgrade', () => {
    assert.ok(DB_VERSION >= 3, `DB_VERSION is ${DB_VERSION}, needs >= 3 to create the store`);
  });

  await t.test('the store exists after open', async () => {
    await db.open();
    assert.equal(STORES.AVATARS, 'avatars');
    // A write proves the object store was actually created by buildSchema.
    assert.equal(await putAvatar('probe', blobOf('x'), 'http://u'), true);
  });
});

test('cache round-trip', async (t) => {
  await t.test('stores and returns the blob', async () => {
    await putAvatar('alice', blobOf('IMAGEBYTES'), 'https://cdn/alice?oe=1');
    const row = await getAvatar('alice');
    assert.ok(row, 'nothing stored');
    assert.equal(await row.blob.text(), 'IMAGEBYTES');
    assert.equal(row.sourceUrl, 'https://cdn/alice?oe=1');
    assert.ok(row.fetchedAt > 0);
  });

  await t.test('bulk read powers one grid page in a single tx', async () => {
    await putAvatar('bob', blobOf('B'));
    await putAvatar('carol', blobOf('C'));
    const map = await getAvatars(['alice', 'bob', 'carol', 'nobody']);
    assert.equal(map.size, 3, 'missing users must simply be absent');
    assert.equal(await map.get('bob').text(), 'B');
    assert.equal(map.has('nobody'), false);
  });

  await t.test('bulk read tolerates junk input', async () => {
    const map = await getAvatars([null, undefined, '', 'alice', 'alice']);
    assert.equal(map.size, 1);
  });

  await t.test('freshness respects the TTL', async () => {
    await putAvatar('dave', blobOf('D'));
    assert.equal(await hasFreshAvatar('dave'), true);
    // Backdate beyond the TTL.
    const row = await getAvatar('dave');
    await db.put(STORES.AVATARS, { ...row, fetchedAt: Date.now() - AVATAR_TTL_MS - 1000 });
    assert.equal(await hasFreshAvatar('dave'), false);
  });

  await t.test('missing users report as not fresh', async () => {
    assert.equal(await hasFreshAvatar('ghost'), false);
    assert.equal(await getAvatar('ghost'), null);
  });

  await t.test('size accounting and clearing work', async () => {
    const { count, bytes } = await avatarCacheSize();
    assert.ok(count >= 4, `expected several rows, got ${count}`);
    assert.ok(bytes > 0);
    await clearAvatars();
    assert.equal((await avatarCacheSize()).count, 0);
  });
});

test('enrichment populates the cache while the URL is valid', async (t) => {
  await t.test('caching happens during enrichment', () => {
    assert.match(ENRICHER, /async function cacheAvatar/);
    assert.match(ENRICHER, /await cacheAvatar\(job\.username, enriched\.profile_pic_url\)/);
  });

  await t.test('it runs before classification so the visual layer can reuse it', () => {
    const iCache = ENRICHER.indexOf('await cacheAvatar(');
    const iClass = ENRICHER.indexOf('await classifyTier2(');
    assert.ok(iCache > 0 && iCache < iClass, 'avatar must be cached before classifyTier2');
  });

  await t.test('downscales to keep the cache small', () => {
    assert.match(ENRICHER, /OffscreenCanvas/);
    assert.match(ENRICHER, /image\/webp/);
  });

  await t.test('a skipped avatar never fails the job', () => {
    // The whole helper body is wrapped so enrichment cannot break on an image.
    assert.match(ENRICHER, /Never let avatar caching break enrichment/);
  });

  await t.test('re-enrichment does not refetch a fresh avatar', () => {
    assert.match(ENRICHER, /if \(await hasFreshAvatar\(username\)\) return/);
  });
});

test('the card prefers cached bytes over the expiring URL', async (t) => {
  await t.test('blob takes precedence', () => {
    assert.match(CARD, /const blob = avatarBlobs\.get\(p\.username\)/);
    assert.match(CARD, /const src = blob \? avatarUrlFor\(p\.username, blob\) : netPic/);
  });

  await t.test('object URLs are reference-counted, not re-minted per repaint', () => {
    // The grid is virtualised: minting a URL on every patch would leak.
    assert.match(CARD, /objectUrls/);
    assert.match(CARD, /e\.refs\+\+/);
    assert.match(CARD, /export function releaseAvatarUrls/);
  });

  await t.test('a broken image still degrades to the initial', () => {
    assert.match(CARD, /addEventListener\('error'/);
    assert.match(CARD, /class="ini"/);
  });

  await t.test('the cache key distinguishes blob-backed from url-backed', () => {
    assert.match(CARD, /'blob:' \+ p\.username/);
  });
});

test('dashboard integration', async (t) => {
  await t.test('avatars load before the grid paints', () => {
    const iLoad = APP.indexOf('await loadAvatarsFor(state.rows)');
    const iPaint = APP.indexOf('grid.setItems(state.rows)');
    assert.ok(iLoad > 0 && iLoad < iPaint, 'must load blobs before painting');
  });

  await t.test('the map is bounded so infinite scroll cannot grow it forever', () => {
    assert.match(APP, /AVATAR_MAP_CAP/);
  });

  await t.test('object URLs are released on unload', () => {
    assert.match(APP, /addEventListener\('pagehide', releaseAvatarUrls\)/);
  });

  await t.test('clicking a photo opens a large view', () => {
    assert.match(APP, /function showPhoto/);
    assert.match(CARD, /handlers\.onAvatar/);
  });
});

test('manifest permits rendering images', async (t) => {
  const mf = JSON.parse(readFileSync(join(process.cwd(), 'manifest.json'), 'utf8'));
  await t.test('CSP allows blob: and the Instagram CDN', () => {
    const csp = mf.content_security_policy.extension_pages;
    assert.match(csp, /img-src/);
    assert.match(csp, /blob:/);
    assert.match(csp, /cdninstagram\.com/);
  });
});
