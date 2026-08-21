import { db } from './db/schema.js';

export async function loadSettings() {
  const settings = await db.settings.toArray();
  return settings[0] || {};
}

export async function saveSettings(settings) {
  const existing = await db.settings.toArray();
  if (existing.length > 0) {
    await db.settings.update(existing[0].id, settings);
  } else {
    await db.settings.add({ id: 1, ...settings });
  }
}

export async function loadProspects(filters = {}) {
  // Returns all for now; filters handled in UI
  return await db.prospects.toArray();
}

export async function saveProspect(prospect) {
  await db.prospects.put(prospect);
}

export async function saveProspects(prospectsList) {
  await db.prospects.bulkPut(prospectsList);
}

export async function loadSessions() {
  return await db.sessions.toArray();
}

export async function saveSession(session) {
  await db.sessions.put(session);
}
