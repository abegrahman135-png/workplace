import { db, STORES } from './schema.js';
import { DEFAULT_SETTINGS } from '../lib/constants.js';

const KEY = 'userSettings';

export async function loadSettings() {
  const row = await db.get(STORES.SETTINGS, KEY);
  return { ...DEFAULT_SETTINGS, ...(row?.value || {}) };
}

export async function saveSettings(patch) {
  const cur = await loadSettings();
  const next = { ...cur, ...patch };
  await db.put(STORES.SETTINGS, { key: KEY, value: next });
  return next;
}

export async function resetSettings() {
  await db.put(STORES.SETTINGS, { key: KEY, value: { ...DEFAULT_SETTINGS } });
  return { ...DEFAULT_SETTINGS };
}
