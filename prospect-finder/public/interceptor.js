/**
 * interceptor.js — MAIN world network tap.
 * Observes Instagram's own follower/following requests and forwards the
 * payloads (plus pagination cursors) to the content script.
 */
(() => {
  if (window.__pfTap) return;
  window.__pfTap = true;

  const send = (payload, url) => {
    try {
      window.postMessage({ source: 'PF_TAP', type: 'LIST_DATA', payload, url }, '*');
    } catch (_) {}
  };

  const isTarget = (u) =>
    /\/api\/v1\/friendships\/\d+\/(followers|following)\//.test(u) ||
    /\/graphql\/query/.test(u);

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
