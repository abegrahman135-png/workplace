/**
 * saved_views.js — Built-in presets + user-defined saved queries.
 */

import { db, STORES } from '../db/schema.js';
import { LABEL } from '../lib/constants.js';

export const BUILTIN_VIEWS = [
  {
    id: 'builtin:best',
    name: 'Best Bets',
    icon: 'fire',
    builtin: true,
    query: {
      filters: [
        { field: 'label', op: 'eq', value: LABEL.HIGH },
        { field: 'isPrivate', op: 'eq', value: true },
        { field: 'posts', op: 'gte', value: 30 },
        { field: 'followers', op: 'between', value: [100, 2000] },
        { field: 'femaleConfidence', op: 'gte', value: 0.6 },
      ],
      sort: { field: 'score', dir: 'desc' },
    },
  },
  {
    id: 'builtin:gems',
    name: 'Hidden Gems',
    icon: 'gem',
    builtin: true,
    query: {
      filters: [
        { field: 'label', op: 'eq', value: LABEL.QUALIFIED },
        { field: 'followers', op: 'lt', value: 500 },
        { field: 'posts', op: 'gte', value: 50 },
        { field: 'ratio', op: 'gte', value: 0.8 },
      ],
      sort: { field: 'score', dir: 'desc' },
    },
  },
  {
    id: 'builtin:unknown',
    name: 'Needs Review',
    icon: 'question',
    builtin: true,
    // The bucket v1 silently deleted.
    query: {
      filters: [
        { field: 'verdict', op: 'eq', value: 'unknown' },
        { field: 'stage', op: 'eq', value: 'scored' },
      ],
      sort: { field: 'score', dir: 'desc' },
    },
  },
  {
    id: 'builtin:retry',
    name: 'Retry Failed',
    icon: 'recycle',
    builtin: true,
    query: {
      filters: [{ field: 'stage', op: 'in', value: ['failed', 'dead'] }],
      sort: { field: 'newest', dir: 'desc' },
    },
  },
  {
    id: 'builtin:fresh',
    name: 'Fresh Today',
    icon: 'sparkNew',
    builtin: true,
    query: {
      filters: [{ field: 'firstSeenAt', op: 'within', value: '1d' }],
      sort: { field: 'newest', dir: 'desc' },
    },
  },
];

export async function listViews() {
  const custom = await db.getAll(STORES.SAVED_VIEWS).catch(() => []);
  return [...BUILTIN_VIEWS, ...(custom || [])];
}

export async function saveView(view) {
  const v = { ...view, id: view.id || `view:${Date.now()}`, builtin: false, createdAt: Date.now() };
  await db.put(STORES.SAVED_VIEWS, v);
  return v;
}

export async function deleteView(id) {
  if (String(id).startsWith('builtin:')) return false;
  await db.delete(STORES.SAVED_VIEWS, id);
  return true;
}
