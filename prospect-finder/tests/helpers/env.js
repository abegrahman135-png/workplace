/** Test environment: fake IndexedDB + minimal chrome shim. */
import 'fake-indexeddb/auto';

globalThis.chrome = globalThis.chrome || {
  runtime: {
    getURL: (p) => `chrome-extension://test/${p}`,
    sendMessage: async () => ({}),
    onMessage: { addListener() {} },
    onConnect: { addListener() {} },
    onStartup: { addListener() {} },
    onInstalled: { addListener() {} },
    getContexts: async () => [],
  },
  alarms: { create() {}, onAlarm: { addListener() {} } },
  storage: {
    session: {
      _d: {},
      async get(k) { return { [k]: this._d[k] }; },
      async set(o) { Object.assign(this._d, o); },
      async remove(k) { delete this._d[k]; },
    },
  },
  notifications: { create() {} },
  tabs: { query: async () => [], sendMessage: async () => {}, create: async () => {} },
  scripting: { executeScript: async () => {} },
  offscreen: null,
};

/** Wipe the database between tests. */
export async function resetDb() {
  const { db } = await import('../../src/db/schema.js');
  db.close();
  await new Promise((resolve) => {
    const r = indexedDB.deleteDatabase('ProspectFinderDB');
    r.onsuccess = r.onerror = r.onblocked = () => resolve();
  });
}

export function makeUsers(n, opts = {}) {
  const female  = ['sadia', 'nusrat', 'fatema', 'ayesha', 'tanjila', 'rumana', 'priya', 'maya', 'nadia', 'farhana'];
  const male    = ['rana', 'arif', 'shakil', 'tanvir', 'imran', 'sabbir', 'mahbub', 'rasel', 'nahid', 'jakir'];
  const neutral = ['zsofia', 'ngozi', 'mei', 'kirra', 'anouk', 'lior', 'sasha', 'rin', 'ola', 'tuuli'];
  const out = [];
  for (let i = 0; i < n; i++) {
    const mod = i % 10;
    const bucket = mod < 3 ? female : mod < 6 ? male : neutral;
    const base = bucket[i % bucket.length];
    out.push({
      username: `${base}_${i}`,
      full_name: `${base[0].toUpperCase()}${base.slice(1)} ${i % 2 ? 'Rahman' : 'Akter'}`,
      profile_pic_url: `https://cdn.test/${i}.jpg`,
      is_private: i % 3 === 0,
      is_verified: i % 97 === 0,
      followed_by_viewer: false,
      requested_by_viewer: false,
      ...opts,
    });
  }
  return out;
}

/** Deterministic fake profile payload for the enricher. */
export function fakeProfile(username, i) {
  return {
    username,
    full_name: `Full ${username}`,
    biography: i % 4 === 0 ? 'photographer · she/her · dhaka' : i % 5 === 0 ? 'married mom of 2' : 'travel and coffee',
    profile_pic_url_hd: `https://cdn.test/${username}.jpg`,
    edge_owner_to_timeline_media: { count: (i * 7) % 400 },
    edge_followed_by: { count: (i * 37) % 5000 },
    edge_follow: { count: (i * 13) % 1200 },
    is_private: i % 3 === 0,
    is_verified: false,
    is_business_account: i % 11 === 0,
    highlight_reel_count: i % 5,
  };
}
