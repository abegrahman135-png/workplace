import { IG_APP_ID, DEFAULT_SETTINGS, PORT_NAME, SETTINGS_CHANNEL } from './lib/constants.js';
import { uuid } from './lib/utils.js';
import { debug, info, warn, error } from './lib/logger.js';
import { 
  FOLLOWER_BATCH, ENRICHMENT_RESULT, ENRICHMENT_FAILED, SCRAPE_COMPLETE, SCRAPE_ERROR, HEARTBEAT,
  BATCH_ACK, START_DIG, GET_STATUS, STATUS_RESPONSE, OPEN_DASHBOARD, PROFILE_DETECTED,
  DIG_REJECTED, CHECKPOINT_DETECTED
} from './lib/messages.js';
import { AdaptiveRateLimiter } from './lib/rate_limiter.js';
import { db } from './db/schema.js';

import { classifyTier1, classifyTier2 } from './engines/classifier.js';
import { qualifyTier1, qualifyTier2 } from './engines/qualification.js';
import { scoreProspect } from './engines/scoring.js';
import { deduplicateAndMerge } from './engines/deduplication.js';
import { detectGenderFromPic } from './engines/face_gender.js';

const activePorts = new Map();
let currentProfile = null;
let activeSessionId = null;
let cachedSettings = { ...DEFAULT_SETTINGS };
let dbInitPromise = null;

const rateLimiter = new AdaptiveRateLimiter({
  baseDelayMs: 2000,
  maxDelayMs: 30000,
  perMinuteCap: 20
});

const settingsChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(SETTINGS_CHANNEL) : null;
if (settingsChannel) {
  settingsChannel.onmessage = async (e) => {
    info('background', 'Settings update received via BroadcastChannel', e.data);
    await loadSettings();
  };
}

async function loadSettings() {
  try {
    const allSettings = await db.settings.all();
    if (allSettings && allSettings.length > 0) {
      allSettings.forEach(s => {
        cachedSettings[s.key] = s.value;
      });
    }
  } catch (err) {
    error('background', 'Failed to load settings', err);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  info('background', 'Extension installed/updated');
  dbInitPromise = db.open();
  await dbInitPromise;
  chrome.alarms.create('checkpoint-pump', { periodInMinutes: 1 });
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'checkpoint-pump') {
    // Auto-close stale running sessions (no port connected + started >2hrs ago)
    try {
      if (!db._db) await (dbInitPromise || db.open());
      const allSessions = await db.sessions.all();
      const twoHoursAgo = Date.now() - 2 * 60 * 60 * 1000;
      for (const s of allSessions) {
        if (s.status === 'running' && s.createdAt < twoHoursAgo) {
          warn('background', 'Auto-closing stale session', { id: s.id });
          await db.sessions.update(s.id, { status: 'completed', completedAt: Date.now() });
          if (activeSessionId === s.id) activeSessionId = null;
        }
      }
      // Also close active session if port disconnected
      if (activeSessionId && !activePorts.has(activeSessionId)) {
        warn('background', 'Port gone — closing session', { activeSessionId });
        await db.sessions.update(activeSessionId, { status: 'completed', completedAt: Date.now() });
        activeSessionId = null;
      }
    } catch (e) { /* ignore */ }
  }
});

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  // Not strictly necessary for background logic unless we want to track navigation
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;
  
  info('background', 'Port connected', { name: port.name });
  
  port.onMessage.addListener(async (msg) => {
    if (!db._db) await (dbInitPromise || db.open());
    
    try {
      switch (msg.type) {
        case HEARTBEAT:
          // No-op
          break;
        case CHECKPOINT_DETECTED:
          warn('background', 'Instagram checkpoint detected', { sessionId: msg.sessionId });
          if (msg.sessionId) {
            await db.sessions.update(msg.sessionId, { status: 'paused' });
            chrome.notifications.create({
              type: 'basic',
              iconUrl: 'public/icons/icon-128.png',
              title: 'Instagram Verification Required',
              message: 'Instagram requires verification. Complete it, then resume your session.',
            });
            activeSessionId = null;
          }
          break;
        case FOLLOWER_BATCH:
          activePorts.set(msg.sessionId, port);
          await handleFollowerBatch(msg.sessionId, msg.batch, msg.cursor);
          port.postMessage({ type: BATCH_ACK, batchSize: msg.batch.length });
          break;
        case ENRICHMENT_RESULT:
          await handleEnrichmentResult(msg.username, msg.data);
          break;
        case SCRAPE_COMPLETE:
          await handleScrapeComplete(msg.sessionId);
          activePorts.delete(msg.sessionId);
          break;
        case SCRAPE_ERROR:
          await handleScrapeError(msg.sessionId, msg.error);
          activePorts.delete(msg.sessionId);
          break;
        default:
          warn('background', 'Unknown port message', msg);
      }
    } catch (err) {
      error('background', 'Error processing port message', { err, msg });
    }
  });

  port.onDisconnect.addListener(() => {
    info('background', 'Port disconnected');
    for (const [sessionId, p] of activePorts.entries()) {
      if (p === port) {
        activePorts.delete(sessionId);
      }
    }
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!db._db) await (dbInitPromise || db.open());
    
    try {
      switch (msg.type) {
        case PROFILE_DETECTED:
          currentProfile = msg.profile;
          sendResponse({ success: true });
          break;
        case START_DIG: {
          if (activeSessionId) {
            sendResponse({ type: DIG_REJECTED, reason: 'Another session is active' });
            return;
          }
          // Support msg.payload.username OR msg.username OR msg.targetUsername
          const digUsername = (msg.payload && msg.payload.username) || msg.username || msg.targetUsername;
          const digType     = (msg.payload && msg.payload.digType)   || msg.digType   || 'followers';
          const digSession  = (msg.payload && msg.payload.sessionId) || msg.sessionId || uuid();
          activeSessionId = digSession;
          await db.sessions.put({
            id: activeSessionId,
            sourceUsername: digUsername,
            createdAt: Date.now(),
            status: 'running',
            digType,
            settingsSnapshot: { ...cachedSettings },
            checkpoint: null,
            stats: { totalFollowers: 0, scanned: 0, tier1Passed: 0, enriched: 0, qualified: 0, highPriority: 0, selected: 0 }
          });
          info('background', 'Started new dig session', { activeSessionId, target: digUsername });
          // Notify content script to start digging — inject it first if needed
          const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (activeTab) {
            const sendDig = () => chrome.tabs.sendMessage(activeTab.id, {
              type: START_DIG,
              username: digUsername,
              digType,
              sessionId: activeSessionId
            });
            try {
              // Try sending immediately
              await sendDig();
            } catch (_) {
              // Content script not injected (tab existed before extension load) — inject now
              try {
                await chrome.scripting.executeScript({
                  target: { tabId: activeTab.id },
                  files: ['src/content.js']
                });
                // Also inject interceptor into page context
                await chrome.scripting.executeScript({
                  target: { tabId: activeTab.id, world: 'MAIN' },
                  files: ['public/interceptor.js']
                });
                await new Promise(r => setTimeout(r, 800));
                await sendDig();
              } catch (injectErr) {
                warn('background', 'Could not inject content script', injectErr);
              }
            }
          }
          sendResponse({ success: true, sessionId: activeSessionId });
          break;
        }
        case GET_STATUS: {
          let activeSession = null;
          let highPriorityCount = 0;
          if (activeSessionId) {
            try {
              const sess = await db.sessions.get(activeSessionId);
              if (sess) {
                activeSession = {
                  id: sess.id,
                  digType: sess.digType || 'followers',
                  scanned: sess.stats?.scanned || 0,
                  highPriority: sess.stats?.highPriority || 0,
                  expectedTotal: sess.stats?.totalFollowers || 0,
                };
                highPriorityCount = sess.stats?.highPriority || 0;
              }
            } catch(e) { /* ignore */ }
          }
          // Determine state string for popup CSS classes
          let popupState = 'idle';
          if (!currentProfile) popupState = 'not-instagram';
          else if (activeSessionId && activeSession) popupState = 'digging';
          else if (currentProfile) popupState = 'profile';
          sendResponse({
            type: STATUS_RESPONSE,
            state: popupState,
            currentProfile,
            activeSession,
            highPriorityCount,
          });
          break;
        }
        case OPEN_DASHBOARD:
          const dashboardUrl = chrome.runtime.getURL('dashboard.html');
          chrome.tabs.query({ url: dashboardUrl }, (tabs) => {
            if (tabs.length > 0) {
              chrome.tabs.update(tabs[0].id, { active: true });
              chrome.windows.update(tabs[0].windowId, { focused: true });
            } else {
              chrome.tabs.create({ url: dashboardUrl });
            }
          });
          sendResponse({ success: true });
          break;
        default:
          sendResponse({ error: 'Unknown message type' });
      }
    } catch (err) {
      error('background', 'Error handling one-shot message', err);
      sendResponse({ error: err.message });
    }
  })();
  return true; // Indicate async response
});

async function handleFollowerBatch(sessionId, batch, cursor) {
  info('background', 'Handling follower batch', { sessionId, batchSize: batch.length });
  const prospectsToSave = [];
  
  for (const user of batch) {
    try {
      const alreadyProcessed = await db.processedUsernames.has(user.username);
      if (alreadyProcessed) continue;

      const classification = classifyTier1(user);
      const qualResult = qualifyTier1({ ...user, femaleScore: classification.femaleScore }, cachedSettings);

      await db.processedUsernames.put({
        username: user.username,
        status: 'scanned',
        lastSeenAt: Date.now()
      });

      // Keep all profiles in database; route qualified ones to enrichment queue
      const isQualified = qualResult.qualified;
      const initialStatus = isQualified ? 'new' : 'excluded';
      const enrichmentStatus = isQualified ? 'pending' : 'skipped';
      const classLabel = isQualified ? 'review' : 'excluded';

      const prospectRecord = {
        username:         user.username,
        raw:              user,
        enriched:         null,
        classification:   { ...classification, label: classLabel, reason: qualResult.reason },
        scored:           null,
        sessionIds:       [sessionId],
        sourceUsernames:  [currentProfile || ''],
        status:           initialStatus,
        enrichmentStatus: enrichmentStatus,
        firstSeenAt:      Date.now(),
        lastSeenAt:       Date.now(),
        femaleScore:      classification.femaleScore,
        finalScore:       0,
      };

      const { action, prospect } = await deduplicateAndMerge(
        prospectRecord, sessionId, currentProfile || '', db
      );

      if (action !== 'skip') {
        prospectsToSave.push(prospect);
      }
    } catch (err) {
      warn('background', 'Error processing user in batch', { username: user.username, err });
    }
  }
  
  // Update session stats
  try {
    const session = await db.sessions.get(sessionId);
    if (session) {
      const stats = session.stats || {};
      stats.scanned = (stats.scanned || 0) + batch.length;
      stats.tier1Passed = (stats.tier1Passed || 0) + prospectsToSave.length;
      stats.qualified = (stats.qualified || 0) + prospectsToSave.length;
      await db.sessions.update(sessionId, { stats, checkpoint: { cursor, scannedCount: stats.scanned, lastBatchTimestamp: Date.now() } });
    }
  } catch (e) {
    warn('background', 'Failed to update session stats', e);
  }

  if (prospectsToSave.length > 0) {
    await db.prospects.bulkPut(prospectsToSave);
  }
  
  // Process enrichment queue in background
  processEnrichmentQueue(sessionId).catch(e => error('background', 'Enrichment queue error', e));
}

async function handleEnrichmentResult(username, data) {
  info('background', 'Handling enrichment result', { username });
  try {
    const prospect = await db.prospects.get(username);
    if (!prospect) return;
    
    // In full implementation, re-run classifier, qualify, and score with enriched data
    const enrichedProspect = { ...prospect, ...data, enrichedAt: Date.now() };
    await db.prospects.put(enrichedProspect);
  } catch (err) {
    error('background', 'Error in handleEnrichmentResult', err);
  }
}

async function handleScrapeComplete(sessionId) {
  info('background', 'Scrape complete', { sessionId });
  try {
    await db.sessions.update(sessionId, { status: 'completed', completedAt: Date.now() });
    // Fix: use chrome.runtime.getURL so icon resolves from extension bundle
    chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('public/icons/icon-128.png'),
      title: 'Prospect Finder',
      message: 'Scan complete! Open the dashboard to view results.'
    });
    chrome.action.setBadgeText({ text: '' });
  } catch (err) {
    error('background', 'Error completing scrape', err);
  } finally {
    activeSessionId = null;
  }
}

async function handleScrapeError(sessionId, errData) {
  error('background', 'Scrape error', { sessionId, errData });
  try {
    await db.sessions.update(sessionId, { status: 'error', error: errData, completedAt: Date.now() });
  } catch (err) {
    error('background', 'Error updating session error state', err);
  } finally {
    activeSessionId = null;
  }
}

let isEnrichmentRunning = false;
let stopEnrichmentRequested = false;
let pendingEnrichmentTrigger = false;

async function processEnrichmentQueue(sessionId) {
  if (isEnrichmentRunning) {
    pendingEnrichmentTrigger = true;
    return;
  }
  isEnrichmentRunning = true;
  pendingEnrichmentTrigger = false;
  stopEnrichmentRequested = false;

  try {
    // Single pass — no while loop
    const allProspects = await db.prospects.getAll();
    const queue = allProspects.filter(p =>
      p.enrichmentStatus === 'pending' && p.status !== 'deleted'
    );

    info('background', `Enrichment queue processing: ${queue.length} pending`);

    for (const prospect of queue) {
      if (stopEnrichmentRequested) break;

      try {
        const enriched = await fetchProfileEnrichment(prospect.username);
        if (enriched) {
          // ── Step A: Face-based gender detection on profile pic ──
          let faceResult = null;
          const picUrl = enriched.profile_pic_url || prospect.raw?.profile_pic_url;
          if (picUrl && cachedSettings.enableFaceClassifier !== false) {
            try {
              faceResult = await detectGenderFromPic(picUrl);
            } catch (_) { /* face detection is non-blocking fallback */ }
          }

          // ── Step B: Re-classify with enriched data + face result ──────────
          const classification = classifyTier2(prospect.raw, enriched, faceResult, {
            ...cachedSettings,
            enableFaceClassifier: !!faceResult,
          });

          // ── Step C: Female gate check ─────────────────────────────────────
          const femThreshold = cachedSettings.minFemaleScore || 70;
          if (classification.femaleScore < femThreshold) {
            await db.prospects.update(prospect.username, {
              enriched,
              classification: { ...classification, label: 'excluded' },
              scored: null,
              enrichmentStatus: 'enriched',
              femaleScore: classification.femaleScore,
              finalScore: 0,
              lastSeenAt: Date.now(),
            });
            continue;
          }

          // ── Step D: Tier 2 qualification (posts > 0, account type) ────────
          const tier2qual = qualifyTier2(enriched, cachedSettings);
          const postCount = enriched.post_count ?? 0;

          // ── Step E: Score using posts(60) + followers(25) + following(15) ─
          let scored = null;
          let classLabel = 'excluded';
          if (tier2qual.qualified && postCount > 0) {
            scored = scoreProspect(
              prospect.raw, enriched, classification, cachedSettings,
              prospect.sourceUsernames?.length || 1
            );
            classLabel = scored.finalScore >= 70 ? 'high_priority'
                       : scored.finalScore >= 45 ? 'qualified'
                       : 'review';
          }

          // Update session high-priority count if applicable
          if (classLabel === 'high_priority' && sessionId) {
            try {
              const sess = await db.sessions.get(sessionId);
              if (sess) {
                const stats = { ...sess.stats };
                stats.highPriority = (stats.highPriority || 0) + 1;
                await db.sessions.update(sessionId, { stats });
              }
            } catch (_) {}
          }

          await db.prospects.update(prospect.username, {
            enriched,
            classification: { ...classification, label: classLabel },
            scored,
            enrichmentStatus: 'enriched',
            femaleScore: classification.femaleScore,
            finalScore: scored?.finalScore ?? 0,
            accountType: enriched.account_type || 'Personal',
            lastSeenAt: Date.now(),
          });
        } else {
          await db.prospects.update(prospect.username, { enrichmentStatus: 'failed' });
        }
      } catch (e) {
        warn('background', `Enrichment failed for ${prospect.username}`, e);
        try { await db.prospects.update(prospect.username, { enrichmentStatus: 'failed' }); } catch (_) {}
      }
      // Rate-limited delay between enrichments
      if (!stopEnrichmentRequested) {
        await new Promise(r => setTimeout(r, cachedSettings.enrichmentDelayMs || 2000));
      }
    }
  } catch (e) {
    error('background', 'processEnrichmentQueue error', e);
  } finally {
    isEnrichmentRunning = false;
    // If new batches triggered while we were running, do one more pass
    if (pendingEnrichmentTrigger && !stopEnrichmentRequested) {
      pendingEnrichmentTrigger = false;
      setTimeout(() => processEnrichmentQueue(sessionId), 500);
    }
  }
}

async function fetchProfileEnrichment(username) {
  await rateLimiter.waitForSlot();
  try {
    const res = await fetch(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${username}`, {
      headers: { 'X-IG-App-ID': IG_APP_ID },
      credentials: 'include'
    });
    
    if (res.status === 429) {
      rateLimiter.reportError(429);
      throw new Error('Rate limited');
    }
    if (!res.ok) {
      rateLimiter.reportError(res.status);
      throw new Error(`HTTP ${res.status}`);
    }
    
    rateLimiter.reportSuccess();
    const data = await res.json();
    const user = data?.data?.user;
    if (!user) return null;

    // Normalize Instagram web_profile_info response structure
    return {
      ...user,
      post_count:           user.post_count ?? user.media_count ?? user.edge_owner_to_timeline_media?.count ?? 0,
      follower_count:       user.follower_count ?? user.edge_followed_by?.count ?? 0,
      following_count:      user.following_count ?? user.edge_follow?.count ?? 0,
      biography:            user.biography ?? '',
      full_name:            user.full_name ?? '',
      profile_pic_url:      user.profile_pic_url_hd ?? user.profile_pic_url ?? '',
      is_private:           Boolean(user.is_private),
      is_verified:          Boolean(user.is_verified),
      is_business_account:  Boolean(user.is_business_account || user.is_professional_account),
      highlight_reel_count: user.highlight_reel_count ?? 0,
      has_story:            Boolean(user.has_story || user.latest_reel_media),
    };
  } catch (err) {
    error('background', 'Fetch profile enrichment failed', { username, err });
    throw err;
  }
}

// Initial DB load
(async () => {
  dbInitPromise = db.open();
  await dbInitPromise;
  await loadSettings();
})();
