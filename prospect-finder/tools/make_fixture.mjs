/**
 * make_fixture.mjs — deterministic test fixtures.
 *
 * Emits tests/fixtures/*.json so integration tests and the dev preview can
 * share one realistic dataset instead of each hand-rolling their own. Uses a
 * seeded PRNG: same input always produces the same output, so a fixture change
 * shows up as a reviewable diff rather than nondeterministic test flake.
 *
 *   node tools/make_fixture.mjs [count]      # default 500
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'tests', 'fixtures');

// ── Seeded PRNG (mulberry32) ────────────────────────────────────────────────
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FEMALE_NAMES = ['Sadia Rahman', 'Nusrat Jahan', 'Fatema Akter', 'Ayesha Siddiqua', 'Tanjila Islam', 'Rumana Haque', 'Priya Sharma', 'Maya Chen', 'Nadia Karim', 'Farhana Yasmin', 'Emma Wilson', 'Olivia Brooks', 'Sophia Martinez', 'Isabella Rossi', 'Mia Nakamura', 'Amelia Clarke', 'Layla Hassan', 'Zara Ahmed', 'Aisha Khan', 'Camila Torres'];
const MALE_NAMES = ['Rana Ahmed', 'Arif Hossain', 'Shakil Khan', 'Tanvir Islam', 'Imran Ali', 'Sabbir Rahman', 'James Miller', 'Lucas Silva', 'Omar Farouk', 'Wei Zhang'];
const NEUTRAL_NAMES = ['Sasha Lior', 'Rin Ola', 'Alex Moreau', 'Jordan Reyes', 'Casey Lin', 'Robin Aziz', 'Sam Oyelaran', 'Kirra Tuuli'];

const BIOS_FEMALE = ['photographer · she/her · dhaka', 'makeup artist | dm for bookings', 'art is life · she/her', 'she/her | designer | dhaka', 'nurse · reader · she/her'];
const BIOS_TAKEN = ['married mom of 2', 'engaged · wedding 2026', 'wifey · blessed', 'happily taken'];
const BIOS_BUSINESS = ['shop link below · dm to order', 'wholesale rates · nationwide delivery', 'promo · dm for collab'];
const BIOS_NEUTRAL = ['coffee, books and long walks', 'travel • food • memories', 'just vibes', 'nature lover · slow living', ''];

const SOURCES = ['fashionhub_bd', 'dhaka_foodies', 'travel_bangladesh', 'artlovers_dk'];

const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));

function slugify(name, i) {
  return name.toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, '').slice(0, 20) + '_' + i;
}

/** Raw list-scrape shape — exactly what the content script posts up. */
function makeRaw(r, i) {
  const roll = r();
  const name = roll < 0.5 ? pick(r, FEMALE_NAMES) : roll < 0.8 ? pick(r, NEUTRAL_NAMES) : pick(r, MALE_NAMES);
  return {
    username: slugify(name, i),
    full_name: name,
    profile_pic_url: '',
    is_private: r() < 0.62,
    is_verified: r() < 0.02,
    followed_by_viewer: r() < 0.04,
    requested_by_viewer: r() < 0.03,
    follows_viewer: r() < 0.15,
  };
}

/** Enriched profile shape — what fetchProfile() returns. */
function makeEnriched(r, raw) {
  const business = r() < 0.10;
  const female = FEMALE_NAMES.includes(raw.full_name);
  const bio = business ? pick(r, BIOS_BUSINESS)
    : r() < 0.18 ? pick(r, BIOS_TAKEN)
    : female && r() < 0.5 ? pick(r, BIOS_FEMALE)
    : pick(r, BIOS_NEUTRAL);
  return {
    username: raw.username,
    full_name: raw.full_name,
    biography: bio,
    profile_pic_url: '',
    external_url: r() < 0.12 ? 'https://example.com' : '',
    post_count: r() < 0.08 ? 0 : int(r, 1, 700),
    follower_count: r() < 0.05 ? int(r, 0, 40) : int(r, 60, 9000),
    following_count: int(r, 20, 2600),
    is_private: raw.is_private,
    is_verified: raw.is_verified,
    is_business_account: business,
    highlight_reel_count: int(r, 0, 8),
    has_story: r() < 0.25,
    category_name: business ? 'Digital creator' : null,
  };
}

const count = Number(process.argv[2]) || 500;
const r = rng(20260821);

const rawBatch = [];
const enrichedMap = {};
for (let i = 0; i < count; i++) {
  const raw = makeRaw(r, i);
  rawBatch.push(raw);
  enrichedMap[raw.username] = makeEnriched(r, raw);
}

// A duplicate slice so dedup/merge paths get exercised.
const dupes = rawBatch.slice(0, Math.floor(count * 0.06)).map(x => ({ ...x }));

mkdirSync(OUT, { recursive: true });

const batch = {
  generatedAt: '2026-08-21T00:00:00.000Z',
  seed: 20260821,
  sessionId: 'fixture-session-1',
  sourceUsername: SOURCES[0],
  users: rawBatch,
  duplicates: dupes,
};
writeFileSync(join(OUT, 'follower_batch.json'), JSON.stringify(batch, null, 2));
writeFileSync(join(OUT, 'profiles.json'), JSON.stringify(enrichedMap, null, 2));

// Edge cases that have historically broken the pipeline.
const edge = [
  { username: '', full_name: 'blank username', is_private: true },
  { username: 'no_name_at_all', full_name: '', is_private: false },
  { username: 'UPPER_Case_User', full_name: 'Upper Case', is_private: true },
  { username: 'emoji_name_x', full_name: '✨ Star ✨', is_private: true },
  { username: 'very'.repeat(40), full_name: 'Overlong Slug', is_private: false },
  { username: 'zero_posts_user', full_name: 'Zero Posts', is_private: true },
  { username: 'null_metrics', full_name: null, is_private: null },
];
writeFileSync(join(OUT, 'edge_cases.json'), JSON.stringify(edge, null, 2));

const priv = rawBatch.filter(u => u.is_private).length;
console.log(`fixtures → ${OUT}`);
console.log(`  follower_batch.json  ${rawBatch.length} users (+${dupes.length} dupes), ${priv} private`);
console.log(`  profiles.json        ${Object.keys(enrichedMap).length} enriched`);
console.log(`  edge_cases.json      ${edge.length} hostile inputs`);
