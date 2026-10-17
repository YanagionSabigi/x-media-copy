(function () {
  'use strict';
  if (window.__xCopyMediaHook) return;
  window.__xCopyMediaHook = true;
  const MAX_RESPONSE = 12 * 1024 * 1024;
  function relevant(raw) {
    try { const u = new URL(raw, location.href); return /^(?:api\.)?(?:x|twitter)\.com$/.test(u.hostname) && /\/(?:i\/api\/)?graphql\//i.test(u.pathname); }
    catch { return false; }
  }
  function publish(json) {
    try {
      const records = globalThis.XCopyMedia.collectRecords(json);
      if (records.length) window.postMessage({ channel: 'x-copy-media-v1', records: records.slice(0, 200) }, location.origin);
    } catch { /* Metadata failure must not interfere with X requests. */ }
  }
  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const request = originalFetch.apply(this, args);
    const url = args[0]?.url || String(args[0]);
    if (relevant(url)) request.then(response => {
      if (Number(response.headers.get('content-length')) > MAX_RESPONSE) return;
      response.clone().text().then(value => { if (value.length <= MAX_RESPONSE) publish(JSON.parse(value)); }).catch(() => {});
    }).catch(() => {});
    return request;
  };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...args) {
    this.__xCopyCapture = relevant(url);
    return open.call(this, method, url, ...args);
  };
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    if (this.__xCopyCapture) this.addEventListener('load', () => {
      try {
        if (this.responseType === 'json') publish(this.response);
        else if ((!this.responseType || this.responseType === 'text') && this.responseText.length <= MAX_RESPONSE) publish(JSON.parse(this.responseText));
      } catch { /* Do not disturb response consumers. */ }
    }, { once: true });
    return send.apply(this, args);
  };
})();
