/**
 * schema.js — IndexedDB v2
 *
 * Key differences from v1:
 *   1. tx() spans MULTIPLE stores in ONE transaction  → atomic ingest (fixes P0-1)
 *   2. jobs store                                     → durable queue (fixes P0-2)
 *   3. compound + multiEntry indexes                  → O(page) queries, not O(N)
 *   4. stats singleton                                → one source of truth for counters
 *   5. migration repairs orphaned processedUsernames  → recovers already-lost records
 */

import { DB_NAME, DB_VERSION } from '../lib/constants.js';
// MUST be a static import. A dynamic import() inside onupgradeneeded resolves
// on a later microtask, by which point the versionchange transaction has
// auto-committed and tx.objectStore() throws InvalidStateError.
import { repairInUpgrade } from './migrations/v1_to_v2.js';
import { log } from '../lib/logger.js';

export const STORES = {
  PROSPECTS: 'prospects',
  JOBS: 'jobs',
  SESSIONS: 'sessions',
  PROCESSED: 'processedUsernames',
  STATS: 'stats',
  SAVED_VIEWS: 'savedViews',
  ACTION_LOG: 'actionLog',
  SETTINGS: 'settings',
  // Instagram CDN URLs are HMAC-signed and expire (see the `oe` query param),
  // so a harvested URL 403s within hours and every card silently falls back to
  // an initial. Cache the actual bytes at enrichment time instead.
  AVATARS: 'avatars',
};

const ALL_STORES = Object.values(STORES);

function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Thin promise wrapper around an IDBObjectStore inside an open transaction. */
class StoreHandle {
  constructor(store) {
    this._s = store;
  }
  get(key) { return req(this._s.get(key)); }
  getAll(range, count) { return req(this._s.getAll(range, count)); }
  getAllKeys(range, count) { return req(this._s.getAllKeys(range, count)); }
  put(v) { return req(this._s.put(v)); }
  add(v) { return req(this._s.add(v)); }
  delete(k) { return req(this._s.delete(k)); }
  clear() { return req(this._s.clear()); }
  count(range) { return req(this._s.count(range)); }
  index(name) { return new IndexHandle(this._s.index(name)); }

  /** Iterate with a callback. Return false from cb to stop early. */
  async cursor(range, direction, cb) {
    return new Promise((resolve, reject) => {
      const r = this._s.openCursor(range ?? null, direction ?? 'next');
      r.onsuccess = () => {
        const c = r.result;
        if (!c) return resolve();
        let go;
        try { go = cb(c.value, c); } catch (e) { return reject(e); }
        if (go === false) return resolve();
        c.continue();
      };
      r.onerror = () => reject(r.error);
    });
  }
}

class IndexHandle {
  constructor(index) { this._i = index; }
  get(key) { return req(this._i.get(key)); }
  getAll(range, count) { return req(this._i.getAll(range, count)); }
  getAllKeys(range, count) { return req(this._i.getAllKeys(range, count)); }
  count(range) { return req(this._i.count(range)); }

  async cursor(range, direction, cb) {
    return new Promise((resolve, reject) => {
      const r = this._i.openCursor(range ?? null, direction ?? 'next');
      r.onsuccess = () => {
        const c = r.result;
        if (!c) return resolve();
        let go;
        try { go = cb(c.value, c); } catch (e) { return reject(e); }
        if (go === false) return resolve();
        c.continue();
      };
      r.onerror = () => reject(r.error);
    });
  }

  async keyCursor(range, direction, cb) {
    return new Promise((resolve, reject) => {
      const r = this._i.openKeyCursor(range ?? null, direction ?? 'next');
      r.onsuccess = () => {
        const c = r.result;
        if (!c) return resolve();
        let go;
        try { go = cb(c.primaryKey, c); } catch (e) { return reject(e); }
        if (go === false) return resolve();
        c.continue();
      };
      r.onerror = () => reject(r.error);
    });
  }
}

class Database {
  constructor() {
    this._db = null;
    this._opening = null;
  }

  get isOpen() { return !!this._db; }

  async open() {
    if (this._db) return this._db;
    // `_opening` must be cleared whenever the connection goes away, otherwise
    // open() resolves with a handle that was already closed and every
    // subsequent read throws "Cannot read properties of null". This is what
    // froze enrichment at 0: the worker thought the DB was open, so it never
    // reopened, and every job failed before doing any work.
    if (this._opening) return this._opening;

    this._opening = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB_NAME, DB_VERSION);

      // A blocked upgrade fires onblocked and then NOTHING until the other
      // connection closes. Without this, open() can hang for the whole life of
      // the worker. Reject so the caller retries on the next alarm tick.
      let blockedTimer = null;

      r.onupgradeneeded = (ev) => {
        const db = r.result;
        const tx = r.transaction;
        const from = ev.oldVersion;
        log.info('db', `upgrading schema ${from} -> ${DB_VERSION}`);
        buildSchema(db, tx);
        // Data repair runs synchronously INSIDE the same upgrade transaction.
        // Only v1 installs need the repair; v2+ already has the right shape and
        // running it again would throw once the tx has closed.
        if (from >= 1 && from < 2) {
          try {
            repairInUpgrade(tx);
          } catch (e) {
            log.error('db', 'migration failed (continuing)', e);
          }
        }
      };

      r.onsuccess = () => {
        if (blockedTimer) { clearTimeout(blockedTimer); blockedTimer = null; }
        this._db = r.result;
        // Another context is upgrading: drop our handle AND the cached promise
        // so the next open() genuinely reconnects.
        this._db.onversionchange = () => {
          log.warn('db', 'versionchange - closing handle so the upgrade can proceed');
          try { this._db?.close(); } catch (_) {}
          this._db = null;
          this._opening = null;
        };
        // Chrome closes a connection on its own if storage is evicted.
        this._db.onclose = () => {
          log.warn('db', 'connection closed unexpectedly');
          this._db = null;
          this._opening = null;
        };
        resolve(this._db);
      };
      r.onerror = () => {
        if (blockedTimer) { clearTimeout(blockedTimer); blockedTimer = null; }
        this._opening = null;
        reject(r.error);
      };
      r.onblocked = () => {
        log.warn('db', 'open blocked by another tab - will retry');
        if (blockedTimer) return;
        blockedTimer = setTimeout(() => {
          this._opening = null;
          reject(new Error('db_open_blocked'));
        }, 5000);
      };
    });

    // A failed open must not leave a poisoned promise behind.
    this._opening.catch(() => { this._opening = null; });

    return this._opening;
  }

  /**
   * Multi-store transaction. THE core primitive.
   *   await db.tx(['prospects','jobs'], 'readwrite', async (t) => { ... })
   * Resolves only after the transaction actually commits.
   * If fn throws, the whole transaction aborts — all-or-nothing across every store.
   */
  async tx(storeNames, mode, fn) {
    await this.open();
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    return new Promise((resolve, reject) => {
      let t;
      try {
        t = this._db.transaction(names, mode);
      } catch (e) {
        return reject(e);
      }
      let result;
      let failed = null;

      t.oncomplete = () => (failed ? reject(failed) : resolve(result));
      t.onabort = () => reject(failed || t.error || new Error('Transaction aborted'));
      t.onerror = (e) => { failed = failed || t.error || e.target?.error; };

      const api = {
        store: (n) => new StoreHandle(t.objectStore(n)),
        index: (n, i) => new StoreHandle(t.objectStore(n)).index(i),
        abort: () => t.abort(),
        raw: t,
      };

      Promise.resolve()
        .then(() => fn(api))
        .then((v) => { result = v; })
        .catch((e) => {
          failed = e;
          try { t.abort(); } catch (_) { /* already finishing */ }
        });
    });
  }

  read(stores, fn) { return this.tx(stores, 'readonly', fn); }
  write(stores, fn) { return this.tx(stores, 'readwrite', fn); }

  async get(store, key) { return this.read([store], t => t.store(store).get(key)); }
  async put(store, value) { return this.write([store], t => t.store(store).put(value)); }
  async delete(store, key) { return this.write([store], t => t.store(store).delete(key)); }
  async getAll(store) { return this.read([store], t => t.store(store).getAll()); }
  async count(store) { return this.read([store], t => t.store(store).count()); }

  async bulkPut(store, items) {
    if (!items.length) return 0;
    return this.write([store], async (t) => {
      const s = t.store(store);
      for (const it of items) await s.put(it);
      return items.length;
    });
  }

  async clearAll() {
    return this.write(ALL_STORES, async (t) => {
      for (const n of ALL_STORES) await t.store(n).clear();
    });
  }

  close() {
    this._db?.close();
    this._db = null;
    this._opening = null;
  }
}

function ensureStore(db, name, opts) {
  if (db.objectStoreNames.contains(name)) return null;
  return db.createObjectStore(name, opts);
}

function ensureIndex(store, name, keyPath, opts) {
  if (!store) return;
  if (store.indexNames.contains(name)) return;
  store.createIndex(name, keyPath, opts);
}

function getStore(db, tx, name) {
  if (!db.objectStoreNames.contains(name)) return null;
  return tx.objectStore(name);
}

export function buildSchema(db, tx) {
  // ── prospects ──────────────────────────────────────────────────────────
  let prospects = ensureStore(db, STORES.PROSPECTS, { keyPath: 'username' });
  if (!prospects) prospects = getStore(db, tx, STORES.PROSPECTS);
  ensureIndex(prospects, 'byStage',       'stage');
  ensureIndex(prospects, 'byLabel',       'label');
  ensureIndex(prospects, 'byStatus',      'status');
  ensureIndex(prospects, 'byFinalScore',  'finalScore');
  ensureIndex(prospects, 'byFemaleScore', 'femaleScore');
  ensureIndex(prospects, 'byFirstSeen',   'firstSeenAt');
  ensureIndex(prospects, 'byLastSeen',    'lastSeenAt');
  // Compound: tab filter + sort in a single index scan.
  ensureIndex(prospects, 'byLabelScore',  ['label', 'finalScore']);
  ensureIndex(prospects, 'byStatusScore', ['status', 'finalScore']);
  ensureIndex(prospects, 'byPosts',       'metrics.posts');
  ensureIndex(prospects, 'byFollowers',   'metrics.followers');
  ensureIndex(prospects, 'byFollowing',   'metrics.following');
  // Text search without a full scan.
  ensureIndex(prospects, 'byToken',       'searchTokens', { multiEntry: true });
  ensureIndex(prospects, 'bySource',      'sourceUsernames', { multiEntry: true });
  ensureIndex(prospects, 'bySession',     'sessionIds', { multiEntry: true });

  // ── avatars (cached profile-picture blobs) ─────────────────────────────
  ensureStore(db, STORES.AVATARS, { keyPath: 'username' });

  // ── jobs (durable queue) ───────────────────────────────────────────────
  let jobs = ensureStore(db, STORES.JOBS, { keyPath: 'id' });
  if (!jobs) jobs = getStore(db, tx, STORES.JOBS);
  ensureIndex(jobs, 'byStatus',      'status');
  ensureIndex(jobs, 'byLease',       'leaseExpiresAt');
  ensureIndex(jobs, 'bySession',     'sessionId');
  ensureIndex(jobs, 'byStatusLane',  ['status', 'lane', 'priority']);

  // ── sessions ───────────────────────────────────────────────────────────
  let sessions = ensureStore(db, STORES.SESSIONS, { keyPath: 'id' });
  if (!sessions) sessions = getStore(db, tx, STORES.SESSIONS);
  ensureIndex(sessions, 'byStatus',  'status');
  ensureIndex(sessions, 'byCreated', 'createdAt');
  ensureIndex(sessions, 'bySource',  'sourceUsername');

  // ── processedUsernames ─────────────────────────────────────────────────
  let processed = ensureStore(db, STORES.PROCESSED, { keyPath: 'username' });
  if (!processed) processed = getStore(db, tx, STORES.PROCESSED);
  ensureIndex(processed, 'byLastSeen', 'lastSeenAt');

  // ── stats / savedViews / actionLog / settings ──────────────────────────
  ensureStore(db, STORES.STATS, { keyPath: 'key' });
  ensureStore(db, STORES.SAVED_VIEWS, { keyPath: 'id' });

  let actionLog = ensureStore(db, STORES.ACTION_LOG, { keyPath: 'id', autoIncrement: true });
  if (!actionLog) actionLog = getStore(db, tx, STORES.ACTION_LOG);
  ensureIndex(actionLog, 'byUsername',  'username');
  ensureIndex(actionLog, 'byTimestamp', 'timestamp');

  ensureStore(db, STORES.SETTINGS, { keyPath: 'key' });
}

export const db = new Database();
