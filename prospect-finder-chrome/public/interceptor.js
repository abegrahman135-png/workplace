/**
 * interceptor.js — MAIN world network tap.
 *
 * Only captures follower/following lists for the TARGET account being scanned.
 * Previously it captured ALL friendship requests, which included suggested
 * accounts, the user's own following list, and other background requests —
 * that's why 564 followers showed up as 1014 profiles.
 */

(() => {
  if (window.__pfTap) return;
  window.__pfTap = true;

  // Track the target user ID being scanned — set by the content script
  let targetUserId = null;

  // Listen for target updates from the content script
  window.addEventListener('message', (e) => {
    if (e.data?.source === 'PF_CONTENT' && e.data.type === 'SET_TARGET') {
      targetUserId = e.data.userId;
    }
  });

  const send = (payload, url) => {
    try {
      window.postMessage({ source: 'PF_TAP', type: 'LIST_DATA', payload, url }, '*');
    } catch (_) {}
  };

  const isTarget = (u) => {
    // Only capture requests for the specific target user being scanned
    if (!targetUserId) return false;

    // Match friendships/{userId}/followers or friendships/{userId}/following
    const match = u.match(/\/api\/v1\/friendships\/(\d+)\/(followers|following)\//);
    if (match) {
      return match[1] === targetUserId;
    }

    // Don't capture GraphQL queries — those are usually suggested accounts
    return false;
  };

  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
      if (isTarget(url)) {
        res.clone().json().then(d => send(d, url)).catch(() => {});
      }
    } catch (_) {}
    return res;
  };

  const XHR = XMLHttpRequest.prototype;
  const origOpen = XHR.open;
  const origSend = XHR.send;
  XHR.open = function (method, url, ...rest) {
    this.__pfUrl = url;
    return origOpen.call(this, method, url, ...rest);
  };
  XHR.send = function (...args) {
    this.addEventListener('load', () => {
      try {
        if (this.__pfUrl && isTarget(this.__pfUrl) && this.responseText) {
          send(JSON.parse(this.responseText), this.__pfUrl);
        }
      } catch (_) {}
    });
    return origSend.apply(this, args);
  };
})();
