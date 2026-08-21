/**
 * seed.js — Preview harness.
 * Shims the chrome.* APIs the dashboard touches, seeds a realistic dataset
 * into IndexedDB, then boots the REAL app.js. Everything you click runs the
 * production code paths.
 */

// ── chrome shim ─────────────────────────────────────────────────────────────
const listeners = [];
globalThis.chrome = {
  runtime: {
    getURL: (p) => new URL('../' + p, import.meta.url).href,
    id: 'preview',
    async sendMessage(msg) {
      switch (msg?.type) {
        case 'PUMP_NOW': return { ok: true };
        case 'REQUEUE_FAILED': {
          const { db, STORES } = await import('../src/db/schema.js');
          const all = await db.getAll(STORES.PROSPECTS);
          const bad = all.filter(p => p.stage === 'failed' || p.stage === 'dead');
          for (const p of bad) {
            await db.put(STORES.PROSPECTS, { ...p, stage: 'queued', label: 'pending', lastError: null });
          }
          bc.postMessage({ scope: 'prospects' });
          return { ok: true, requeued: bad.length };
        }
        case 'RESCORE_ALL': {
          const { db } = await import('../src/db/schema.js');
          const { rescoreAll } = await import('../src/background/enricher.js');
          const { loadSettings } = await import('../src/db/repo.settings.js');
          const n = await rescoreAll(await loadSettings());
          bc.postMessage({ scope: 'prospects' });
          return { ok: true, rescored: n };
        }
        default: return { ok: true };
      }
    },
    onMessage: { addListener: (f) => listeners.push(f) },
  },
  storage: {
    session: {
      _d: {},
      async get(k) { return { [k]: this._d[k] }; },
      async set(o) { Object.assign(this._d, o); },
      async remove(k) { delete this._d[k]; },
    },
  },
  tabs: { query: async () => [], create: async () => {}, sendMessage: async () => {} },
  alarms: { create() {}, onAlarm: { addListener() {} } },
  notifications: { create() {} },
};

const bc = new BroadcastChannel('pf-data');

// ── Seed data ───────────────────────────────────────────────────────────────
const FEMALE = ['Sadia Rahman','Nusrat Jahan','Fatema Akter','Ayesha Siddiqua','Tanjila Islam','Rumana Haque','Priya Sharma','Maya Chen','Nadia Karim','Farhana Yasmin','Emma Wilson','Olivia Brooks','Sophia Martinez','Isabella Rossi','Mia Nakamura','Amelia Clarke','Harper Quinn','Layla Hassan','Zara Ahmed','Aisha Khan','Camila Torres','Yuki Tanaka','Ngozi Okafor','Zsofia Nagy','Anouk de Vries'];
const MALE = ['Rana Ahmed','Arif Hossain','Shakil Khan','Tanvir Islam','Imran Ali','Sabbir Rahman','James Miller','Lucas Silva','Omar Farouk','Wei Zhang'];
const NEUTRAL = ['Sasha Lior','Rin Ola','Kirra Tuuli','Alex Moreau','Jordan Reyes','Casey Lin','Robin Aziz','Sam Oyelaran'];

const BIOS = [
  'photographer · she/her · dhaka 📸','coffee, books and long walks','travel • food • memories ✈️',
  'makeup artist 💄 dm for bookings','married mom of 2 💍','fitness enthusiast | gym daily',
  'digital creator · collabs welcome','student @ du | dreamer','art is life 🎨 she/her',
  'nature lover 🌿 slow living','engaged 💍 wedding 2026','shop link below · dm to order',
  'living my best life ✨','tea over coffee ☕ always','she/her | designer | dhaka',
  '', 'just vibes', 'wanderlust 🌍 30 countries', 'cat mom 🐱', 'she/her · nurse · reader',
];
const SOURCES = ['fashionhub_bd','dhaka_foodies','travel_bangladesh','artlovers_dk'];

function pick(a, i) { return a[i % a.length]; }
function slug(name, i) {
  return name.toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, '').slice(0, 20) + '_' + i;
}

async function seed() {
  const { db, STORES } = await import('../src/db/schema.js');
  const { buildSearchTokens } = await import('../src/search/text_index.js');
  const { scoreProspect } = await import('../src/engines/scoring.js');
  const { classifyTier1, loadNameDb } = await import('../src/engines/classifier/index.js');
  const { classifyAccountType } = await import('../src/engines/qualification.js');
  const { DEFAULT_SETTINGS } = await import('../src/lib/constants.js');
  const { detectTaken, bioSignals } = await import('../src/engines/classifier/bio.js');
  const { combine } = await import('../src/engines/classifier/evidence.js');
  const { nameSignals } = await import('../src/engines/classifier/names.js');

  await db.open();
  await loadNameDb();

  const existing = await db.count(STORES.PROSPECTS);
  if (existing > 100) { document.getElementById('dev-n').textContent = existing.toLocaleString(); return; }

  const N = 520;
  const rows = [];
  const now = Date.now();

  for (let i = 0; i < N; i++) {
    const mod = i % 10;
    const name = mod < 5 ? pick(FEMALE, i) : mod < 8 ? pick(NEUTRAL, i) : pick(MALE, i);
    const username = slug(name, i);
    const bio = pick(BIOS, i * 3);
    const isPrivate = i % 3 !== 2;
    const posts = [0, 4, 18, 45, 92, 160, 240, 380, 620][i % 9];
    const followers = [0, 12, 48, 130, 420, 890, 1500, 3200, 12000, 68000][i % 10];
    const following = [8, 45, 90, 210, 480, 760, 1100, 2400][i % 8];

    const raw = {
      username, full_name: name, profile_pic_url: '',
      is_private: isPrivate, is_verified: i % 97 === 0,
      followed_by_viewer: false, requested_by_viewer: false, follows_viewer: i % 7 === 0,
    };

    // ~12% still queued, ~4% failed — realistic mid-pipeline state
    const stillQueued = i % 8 === 3;
    const failed = i % 25 === 7;

    const enriched = stillQueued ? null : {
      username, full_name: name, biography: bio,
      profile_pic_url: '', external_url: i % 6 === 0 ? 'https://example.com' : '',
      post_count: posts, follower_count: followers, following_count: following,
      is_private: isPrivate, is_verified: raw.is_verified,
      is_business_account: i % 11 === 0,
      highlight_reel_count: i % 5, has_story: i % 4 === 0,
      category_name: i % 11 === 0 ? 'Digital creator' : null,
    };

    const evidence = enriched
      ? { female: combine([...nameSignals({ username, fullName: name }), ...bioSignals(bio)]), taken: detectTaken(bio) }
      : classifyTier1(raw);

    const metrics = { posts: enriched ? posts : 0, followers: enriched ? followers : 0, following: enriched ? following : 0 };
    const scored = enriched ? scoreProspect(metrics, evidence, enriched, DEFAULT_SETTINGS) : null;

    const p = {
      username, raw, enriched, metrics, evidence, scored,
      stage: stillQueued ? 'queued' : failed ? 'failed' : 'scored',
      status: i % 40 === 11 ? 'rejected' : 'active',
      label: stillQueued || failed ? 'pending' : scored.label,
      finalScore: stillQueued || failed ? null : scored.finalScore,
      femaleScore: evidence.female.value,
      femaleConfidence: evidence.female.confidence,
      accountType: enriched ? classifyAccountType(enriched) : null,
      manualPriority: i % 63 === 5,
      lane: 'normal', priority: 50,
      sessionIds: ['demo-1'],
      sourceUsernames: i % 5 === 0 ? [pick(SOURCES, i), pick(SOURCES, i + 1)] : [pick(SOURCES, i)],
      attempts: failed ? 3 : 0,
      lastError: failed ? 'HTTP 429' : null,
      firstSeenAt: now - (N - i) * 90000,
      lastSeenAt: now - i * 1000,
      enrichedAt: enriched ? now - i * 800 : null,
      scoreVersion: 2, schemaVersion: 2,
    };
    p.searchTokens = buildSearchTokens(p);
    rows.push(p);
  }

  for (let i = 0; i < rows.length; i += 200) {
    await db.bulkPut(STORES.PROSPECTS, rows.slice(i, i + 200));
  }

  await db.put(STORES.SESSIONS, {
    id: 'demo-1', sourceUsername: 'fashionhub_bd', digType: 'followers',
    status: 'completed', createdAt: now - 5400000, completedAt: now - 3600000,
    cursor: null, error: null, settingsSnapshot: {},
    stats: { seen: 548, inserted: 520, merged: 22, rejected: 6 },
  });
  await db.put(STORES.SESSIONS, {
    id: 'demo-2', sourceUsername: 'dhaka_foodies', digType: 'followers',
    status: 'running', createdAt: now - 240000, completedAt: null,
    cursor: 'QVFB…', error: null, settingsSnapshot: {},
    stats: { seen: 132, inserted: 118, merged: 14, rejected: 0 },
  });

  const scoredN = rows.filter(r => r.stage === 'scored').length;
  await db.put(STORES.STATS, {
    key: 'global',
    value: { seen: 548, inserted: 520, merged: 22, rejected: 6, enriched: scoredN, failed: rows.filter(r => r.stage === 'failed').length, updatedAt: now },
  });

  // Queue rows for the still-pending prospects so the pipeline bar is real.
  const jobs = rows.filter(r => r.stage === 'queued').map(r => ({
    id: `enrich:${r.username}`, type: 'enrich', username: r.username, sessionId: 'demo-2',
    lane: 'normal', priority: 50, status: 'pending', attempts: 0,
    leaseExpiresAt: 0, nextAttemptAt: 0, createdAt: now, updatedAt: now, lastError: null,
  }));
  await db.bulkPut(STORES.JOBS, jobs);

  document.getElementById('dev-n').textContent = N.toLocaleString();
}

await seed();
await import('../src/ui/app.js');

// Simulate live enrichment so the rail/pipeline animates like a real run.
setInterval(async () => {
  const { db, STORES } = await import('../src/db/schema.js');
  const { scoreProspect } = await import('../src/engines/scoring.js');
  const { DEFAULT_SETTINGS } = await import('../src/lib/constants.js');
  const jobs = await db.getAll(STORES.JOBS);
  const next = jobs.find(j => j.status === 'pending');
  if (!next) return;
  const p = await db.get(STORES.PROSPECTS, next.username);
  if (p) {
    const posts = 30 + Math.floor(Math.random() * 300);
    const followers = 100 + Math.floor(Math.random() * 3000);
    const following = 80 + Math.floor(Math.random() * 900);
    const enriched = {
      ...(p.enriched || {}), username: p.username, full_name: p.raw.full_name,
      biography: 'newly enriched profile · she/her', post_count: posts,
      follower_count: followers, following_count: following,
      is_private: p.raw.is_private, is_verified: false, is_business_account: false,
      highlight_reel_count: 2, has_story: false,
    };
    const metrics = { posts, followers, following };
    const scored = scoreProspect(metrics, p.evidence, enriched, DEFAULT_SETTINGS);
    await db.put(STORES.PROSPECTS, {
      ...p, enriched, metrics, scored, stage: 'scored',
      label: scored.label, finalScore: scored.finalScore, enrichedAt: Date.now(),
    });
  }
  await db.delete(STORES.JOBS, next.id);
  const st = (await db.get(STORES.STATS, 'global'))?.value || {};
  await db.put(STORES.STATS, { key: 'global', value: { ...st, enriched: (st.enriched || 0) + 1 } });
  bc.postMessage({ scope: 'progress' });
}, 2600);
