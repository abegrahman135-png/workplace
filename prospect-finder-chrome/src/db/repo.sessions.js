import { db, STORES } from './schema.js';

export function makeSession({ id, sourceUsername, digType, settingsSnapshot }) {
  return {
    id,
    sourceUsername,
    digType: digType || 'followers',
    status: 'running',
    createdAt: Date.now(),
    completedAt: null,
    cursor: null,
    error: null,
    settingsSnapshot: settingsSnapshot || {},
    stats: { seen: 0, inserted: 0, merged: 0, rejected: 0 },
  };
}

export const getSession   = (id) => db.get(STORES.SESSIONS, id);
export const putSession   = (s)  => db.put(STORES.SESSIONS, s);
export const allSessions  = ()   => db.getAll(STORES.SESSIONS);

export async function updateSession(id, changes) {
  return db.write([STORES.SESSIONS], async (t) => {
    const s = t.store(STORES.SESSIONS);
    const cur = await s.get(id);
    if (!cur) return null;
    const next = { ...cur, ...changes };
    await s.put(next);
    return next;
  });
}

export async function activeSession() {
  const all = await allSessions();
  return all.filter(s => s.status === 'running').sort((a, b) => b.createdAt - a.createdAt)[0] || null;
}
