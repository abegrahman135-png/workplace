/**
 * background/index.js — Service worker entry. Wiring only.
 *
 * The worker is a stateless orchestrator over the database. Kill it at any
 * moment and the next alarm tick resumes exactly where it stopped, because
 * "where it stopped" is a row in `jobs`, not a variable in RAM.
 */

import { db, STORES } from '../db/schema.js';
import { MSG, PORT_NAME, STAGE } from '../lib/constants.js';
import { log } from '../lib/logger.js';
import { uuid } from '../lib/utils.js';
import { loadSettings, saveSettings } from '../db/repo.settings.js';
import { makeSession, updateSession, getSession, activeSession, allSessions } from '../db/repo.sessions.js';
import { ingestBatch, requeueUnfinished } from './ingest.js';
import { installScheduler, pumpNow, retryFailed, schedulerHealth, ensureSettings } from './scheduler.js';
import { rescoreAll } from './enricher.js';
import { bumpStats, fullSnapshot, rebuildStats } from './stats.js';
import { broadcast } from './broadcast.js';
import { getRuntime, setRuntime, clearRuntime } from './session_state.js';
import { loadNameDb } from '../engines/classifier/index.js';
import { queueDepth, dominantError } from '../db/repo.jobs.js';

installScheduler();

// Warm the DB + name dictionary as early as possible.
(async () => {
  try {
    await db.open();
    await ensureSettings();
    await loadNameDb();
    log.info('bg', 'service worker ready');
  } catch (e) {
    log.error('bg', 'boot failed', e);
  }
})();

chrome.runtime.onInstalled.addListener(async (details) => {
  await db.open();
  await loadNameDb();
  if (details.reason === 'update' || details.reason === 'install') {
    // Pick up anything the old build abandoned mid-flight.
    const n = await requeueUnfinished().catch(() => 0);
    if (n) log.info('bg', `re-queued ${n} unfinished prospects after ${details.reason}`);
    await rebuildStats().catch(() => {});
  }
});

// ─── Port: streaming follower batches from the content script ──────────────
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  log.info('bg', 'harvester connected');

  port.onMessage.addListener(async (msg) => {
    try {
      await db.open();
      switch (msg.type) {
        case MSG.HEARTBEAT:
          break;

        case MSG.FOLLOWER_BATCH: {
          const settings = await loadSettings();
          const rt = await getRuntime();
          const result = await ingestBatch({
            sessionId: msg.sessionId,
            sourceUsername: msg.sourceUsername || rt.currentProfile || '',
            users: msg.batch || [],
            settings,
          });

          await bumpStats({
            seen: result.seen,
            inserted: result.inserted,
            merged: result.merged,
            rejected: result.rejected,
          });

          if (msg.sessionId) {
            const s = await getSession(msg.sessionId);
            if (s) {
              const stats = { ...s.stats };
              stats.seen += result.seen;
              stats.inserted += result.inserted;
              stats.merged += result.merged;
              stats.rejected += result.rejected;
              await updateSession(msg.sessionId, { stats, cursor: msg.cursor ?? s.cursor });
            }
          }

          // ACK only after the transaction committed. On failure we NACK and
          // the harvester replays the batch — no silent loss.
          port.postMessage({ type: MSG.BATCH_ACK, batchId: msg.batchId, result });
          broadcast({ scope: 'prospects', ingest: result });
          pumpNow().catch(() => {});
          break;
        }

        case MSG.SCRAPE_COMPLETE:
          if (msg.sessionId) {
            await updateSession(msg.sessionId, { status: 'completed', completedAt: Date.now() });
          }
          await setRuntime({ activeSessionId: null });
          broadcast({ scope: 'session' });
          notify('Scan complete', 'Enrichment continues in the background — the dashboard updates live.');
          pumpNow().catch(() => {});
          break;

        case MSG.SCRAPE_ERROR:
          if (msg.sessionId) {
            await updateSession(msg.sessionId, { status: 'error', error: msg.error, completedAt: Date.now() });
          }
          await setRuntime({ activeSessionId: null });
          broadcast({ scope: 'session' });
          break;

        case MSG.CHECKPOINT:
          if (msg.sessionId) await updateSession(msg.sessionId, { status: 'paused' });
          notify('Verification required', 'Instagram asked for verification. Complete it, then resume.');
          broadcast({ scope: 'session' });
          break;

        case MSG.PROGRESS:
          broadcast({ scope: 'progress', harvest: msg.payload });
          break;

        default:
          log.warn('bg', 'unknown port message', msg.type);
      }
    } catch (e) {
      log.error('bg', 'port handler failed', e);
      try { port.postMessage({ type: MSG.BATCH_NACK, batchId: msg.batchId, error: String(e?.message || e) }); } catch (_) {}
    }
  });

  port.onDisconnect.addListener(() => log.info('bg', 'harvester disconnected'));
});

// ─── One-shot messages ─────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await db.open();
    switch (msg.type) {
      case MSG.PROFILE_DETECTED:
        await setRuntime({ currentProfile: msg.profile });
        return { ok: true };

      case MSG.START_DIG: {
        const rt = await getRuntime();
        if (rt.activeSessionId) {
          const s = await getSession(rt.activeSessionId);
          if (s && s.status === 'running') return { ok: false, reason: 'A scan is already running' };
        }
        const settings = await loadSettings();
        const sessionId = uuid();
        const target = msg.username || rt.currentProfile;
        if (!target) return { ok: false, reason: 'No profile detected' };

        await db.put(STORES.SESSIONS, makeSession({
          id: sessionId,
          sourceUsername: target,
          digType: msg.digType || 'followers',
          settingsSnapshot: settings,
        }));
        await setRuntime({ activeSessionId: sessionId, currentProfile: target });

        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) {
          const send = () => chrome.tabs.sendMessage(tab.id, {
            type: MSG.START_DIG, username: target, digType: msg.digType || 'followers', sessionId,
            maxProfiles: settings.maxProfilesPerSession,
          });
          try {
            await send();
          } catch (_) {
            try {
              await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content/index.js'] });
              await new Promise(r => setTimeout(r, 700));
              await send();
            } catch (e) {
              return { ok: false, reason: 'Could not inject into the page. Reload Instagram and retry.' };
            }
          }
        }
        broadcast({ scope: 'session' });
        return { ok: true, sessionId };
      }

      case MSG.PAUSE_DIG:
      case MSG.RESUME_DIG:
      case MSG.STOP_DIG: {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) { try { await chrome.tabs.sendMessage(tab.id, { type: msg.type }); } catch (_) {} }
        const rt = await getRuntime();
        if (msg.type === MSG.STOP_DIG && rt.activeSessionId) {
          await updateSession(rt.activeSessionId, { status: 'completed', completedAt: Date.now() });
          await setRuntime({ activeSessionId: null });
        }
        if (msg.type === MSG.PAUSE_DIG && rt.activeSessionId) {
          await updateSession(rt.activeSessionId, { status: 'paused' });
        }
        if (msg.type === MSG.RESUME_DIG && rt.activeSessionId) {
          await updateSession(rt.activeSessionId, { status: 'running' });
        }
        broadcast({ scope: 'session' });
        return { ok: true };
      }

      case MSG.GET_STATUS: {
        const rt = await getRuntime();
        const sess = await activeSession();
        const snap = await fullSnapshot();
        return {
          ok: true,
          currentProfile: rt.currentProfile,
          session: sess,
          ...snap,
          health: schedulerHealth(),
        };
      }

      case MSG.PUMP_NOW:
        pumpNow().catch(() => {});
        return { ok: true };

      case MSG.REQUEUE_FAILED: {
        const n = await retryFailed();
        broadcast({ scope: 'prospects' });
        return { ok: true, requeued: n };
      }

      case MSG.RESCORE_ALL: {
        const settings = await loadSettings();
        const n = await rescoreAll(settings);
        broadcast({ scope: 'prospects' });
        return { ok: true, rescored: n };
      }

      case MSG.SETTINGS_UPDATED:
        await saveSettings(msg.settings || {});
        await ensureSettings();
        return { ok: true };

      case MSG.OPEN_DASHBOARD: {
        const url = chrome.runtime.getURL('src/ui/dashboard.html');
        const tabs = await chrome.tabs.query({ url });
        if (tabs.length) {
          await chrome.tabs.update(tabs[0].id, { active: true });
          await chrome.windows.update(tabs[0].windowId, { focused: true });
        } else {
          await chrome.tabs.create({ url });
        }
        return { ok: true };
      }

      case 'GET_QUEUE':
        return { ok: true, queue: await queueDepth() };

      default:
        return { ok: false, reason: 'unknown_message' };
    }
  })()
    .then(sendResponse)
    .catch((e) => {
      log.error('bg', 'message handler failed', e);
      sendResponse({ ok: false, reason: String(e?.message || e) });
    });
  return true;
});

function notify(title, message) {
  try {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('public/icons/icon-128.png'),
      title,
      message,
    });
  } catch (_) {}
}
