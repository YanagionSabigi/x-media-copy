(function () {
  'use strict';
  const index = new Map();
  globalThis.XCopyMediaIndex = index;
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.channel !== 'x-copy-media-v1') return;
    const records = event.data.records;
    if (!Array.isArray(records) || records.length > 200) return;
    for (const record of records) {
      if (!/^\d{1,30}$/.test(record?.postId) || !Array.isArray(record.media)) continue;
      const limit = globalThis.XCopyMedia?.MAX_MEDIA || 20;
      const items = record.media.slice(0, limit).map(globalThis.XCopyMedia.normalizeMedia).filter(Boolean);
      if (items.length) index.set(String(record.postId), items);
      while (index.size > 500) index.delete(index.keys().next().value);
    }
  });
})();
