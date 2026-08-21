/**
 * harvest_fallback.test.js — "12 collected, waiting for more… (10/25)"
 *
 * Diagnosis from the HUD text itself:
 *   - "waiting for more…" is emitted ONLY by domHarvest(), so the run was on
 *     the DOM fallback, not the API engine.
 *   - progressLine() renders "12 / 432 (3%)" whenever expectedTotal is set.
 *     The screenshot showed a BARE "12 collected" => expectedTotal === 0
 *     => resolveUser() threw => apiHarvest() was never entered.
 *
 * Three defects, each fixed and guarded here.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'src', 'content', 'index.js'), 'utf8');

/** Run the real progressLine() from source rather than a copy. */
function progressLine(harvested, collected, expectedTotal, extra = '') {
  const body = SRC.match(/function progressLine[\s\S]*?\n  \}/)[0];
  return new Function(
    'harvested', 'collected', 'expectedTotal', 'extra',
    `${body}; return progressLine(extra);`,
  )(harvested, collected, expectedTotal, extra);
}
const strip = (s) => s.replace(/<[^>]+>/g, '').replace(/📥/g, '').trim();

test('the HUD text pinpoints the failing path', async (t) => {
  await t.test('a missing total is the fingerprint of a failed resolveUser', () => {
    assert.match(strip(progressLine(0, 12, 432)), /12 \/ 432 \(3%\)/);
    assert.match(strip(progressLine(0, 12, 0)), /^12 collected/);
  });

  await t.test('"waiting for more" belongs to the DOM path only', () => {
    const dom = SRC.slice(SRC.indexOf('async function domHarvest'));
    assert.match(dom, /waiting for more/);
    const api = SRC.slice(SRC.indexOf('async function apiHarvest'), SRC.indexOf('async function domHarvest'));
    assert.equal(/waiting for more/.test(api), false);
  });
});

test('fix 1 — a failed profile lookup no longer forfeits the API engine', async (t) => {
  await t.test('scrapeUserId recovers an id from inline JSON', () => {
    const body = SRC.match(/function scrapeUserId[\s\S]*?\n  \}/)[0];
    const fn = new Function('document', `${body}; return scrapeUserId();`);
    const doc = {
      documentElement: { innerHTML: '{"profile_id":"48291733","x":1}' },
      querySelector: () => null,
    };
    assert.equal(fn(doc), '48291733');
  });

  await t.test('scrapeUserId recovers an id from the profile picture URL', () => {
    const body = SRC.match(/function scrapeUserId[\s\S]*?\n  \}/)[0];
    const fn = new Function('document', `${body}; return scrapeUserId();`);
    const doc = {
      documentElement: { innerHTML: '<html>no ids here</html>' },
      querySelector: () => ({ src: 'https://scontent.cdninstagram.com/v/t51.2885-19/123456789_n.jpg' }),
    };
    assert.equal(fn(doc), '123456789');
  });

  await t.test('returns null when nothing is available', () => {
    const body = SRC.match(/function scrapeUserId[\s\S]*?\n  \}/)[0];
    const fn = new Function('document', `${body}; return scrapeUserId();`);
    assert.equal(fn({ documentElement: { innerHTML: '' }, querySelector: () => null }), null);
  });

  await t.test('a rescued id is used to run apiHarvest', () => {
    assert.match(SRC, /const rescuedId = scrapeUserId\(\)/);
    assert.match(SRC, /Profile API unavailable — using page data/);
  });
});

test('fix 2 — cap and fallback use collected, not ACK count', async (t) => {
  await t.test('cap checks no longer read the ACK counter', () => {
    assert.equal(/harvested >= maxProfiles/.test(SRC), false,
      'harvested only increments on BATCH_ACK; a dropped port would freeze the cap');
    assert.match(SRC, /collected >= maxProfiles/);
  });

  await t.test('ingest() increments collected immediately', () => {
    assert.match(SRC, /collected \+= fresh\.length/);
  });

  await t.test('the fallback decision uses collected', () => {
    assert.match(SRC, /!result\.ok \|\| collected === 0/);
  });

  await t.test('HUD shows the larger of the two counters', () => {
    assert.match(SRC, /Math\.max\(harvested, collected\)/);
    // ACKs lagging must not make progress appear frozen at 0.
    assert.match(strip(progressLine(0, 37, 432)), /^37 \/ 432/);
  });
});

test('fix 3 — the DOM fallback can escape back to the API', async (t) => {
  await t.test('the network tap captures the numeric id from the request URL', () => {
    const re = /friendships\/(\d+)\/(followers|following)/;
    const url = 'https://www.instagram.com/api/v1/friendships/48291733/followers/?count=50';
    assert.equal(url.match(re)[1], '48291733');
    assert.match(SRC, /rescueUserId = idm\[1\]/);
  });

  await t.test('a stalled scroll switches instead of dying at 25 stale ticks', () => {
    assert.match(SRC, /rescueUserId && stale >= 3/);
    assert.match(SRC, /reason: 'switch_to_api'/);
  });

  await t.test('startDig honours the switch and resumes on the API', () => {
    assert.match(SRC, /result\.reason === 'switch_to_api'/);
    assert.match(SRC, /result = await apiHarvest\(sid, result\.userId\)/);
  });

  await t.test('rescue state resets between runs', () => {
    assert.match(SRC, /rescueUserId = null/);
  });
});

test('content script still has no ESM syntax', () => {
  assert.equal(/^\s*(import|export)\s/m.test(SRC), false);
});
