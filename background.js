/* Browser service worker. Export the same engine for isolated unit tests. */
if (typeof importScripts === 'function') importScripts('media.js');
(function (root) {
  'use strict';
  const media = typeof module !== 'undefined' && module.exports ? require('./media.js') : root.XCopyMedia;
  const ACTIVE = new Set(['queued', 'converting', 'downloading']);
  const CAT_IDS = ['jfedfbgedapdagkghmgibemcoggfppbb', 'oohmdefbjalncfplafanlagojlakmjci'];
  function createService(api, dependencies = {}) {
    const request = dependencies.fetch || fetch;
    const now = dependencies.now || Date.now;
    const IMAGE_LIMIT = 24 * 1024 ** 2;
    const CACHE_LIMIT = 16 * 1024 ** 2, PREFETCH_LIMIT = 8 * 1024 ** 2;
    const PREFETCH_RAW_LIMIT = 3 * 1024 ** 2 - 128, CACHE_TTL = 120000;
    const originalCache = new Map(), pendingImages = new Map(), imageQueue = [], owners = new Map();
    const later = dependencies.setTimeout || setTimeout, cancelTimer = dependencies.clearTimeout || clearTimeout;
    let cachedImageBytes = 0, activeImages = 0, activePrefetch = 0, expiryTimer;
    let jobs = [], gifQueue = Promise.resolve(), creating;
    const ready = (async () => {
      const saved = await api.storage.session.get('jobs');
      jobs = Array.isArray(saved.jobs) ? saved.jobs.slice(-100) : [];
      for (const job of jobs.filter(item => ACTIVE.has(item.status))) {
        if (job.downloadId) {
          const [item] = await api.downloads.search({ id: job.downloadId });
          job.status = item?.state === 'complete' ? 'complete' : item?.state === 'in_progress' ? 'downloading' : 'failed';
        } else job.status = 'failed';
        if (job.status === 'failed') job.error = '扩展后台已重启，请重试此任务';
      }
    })();
    function senderKind(sender) {
      if (sender?.id !== api.runtime.id) throw new Error('不接受外部调用');
      if (sender.url === api.runtime.getURL('offscreen.html')) return 'offscreen';
      if (sender.url === api.runtime.getURL('popup.html')) return 'popup';
      try {
        const url = new URL(sender.url);
        if (sender.tab?.id >= 0 && url.protocol === 'https:' && ['x.com', 'twitter.com'].includes(url.hostname)) return 'page';
      } catch { /* Reject unknown senders. */ }
      throw new Error('调用来源无效');
    }
    async function save(job, notify = true) {
      await api.storage.session.set({ jobs: JSON.parse(JSON.stringify(jobs)) });
      if (job && notify) {
        try { await api.tabs.sendMessage(job.tabId, { type: 'xCopyJobUpdate', job: { ...job } }); } catch { /* Tab may be closed. */ }
      }
    }
    async function ensureOffscreen() {
      const contexts = await api.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [api.runtime.getURL('offscreen.html')] });
      if (contexts.length) return;
      if (!creating) creating = api.offscreen.createDocument({ url: 'offscreen.html', reasons: ['WORKERS', 'BLOBS'], justification: 'Convert downloaded X animation MP4 to GIF locally and retain its download URL.' }).finally(() => { creating = null; });
      await creating;
    }
    async function offscreen(message) {
      await ensureOffscreen();
      const result = await api.runtime.sendMessage({ target: 'offscreen', ...message });
      if (!result?.ok) throw new Error(result?.error || 'GIF 转换器无响应');
      return result;
    }
    async function readLimited(response, limit, signal) {
      if (!response.ok) throw new Error(`媒体请求失败（HTTP ${response.status}）`);
      const max = () => typeof limit === 'function' ? limit() : limit;
      const oversized = maximum => Object.assign(new Error('原图过大，无法安全写入剪贴板'), { speculativeLimit: maximum === PREFETCH_RAW_LIMIT });
      const advertisedLimit = max();
      if (Number(response.headers.get('content-length')) > advertisedLimit) {
        const error = oversized(advertisedLimit);
        await response.body?.cancel();
        throw error;
      }
      const reader = response.body.getReader(), chunks = [];
      const stop = () => { void reader.cancel().catch(() => {}); };
      signal?.addEventListener('abort', stop, { once: true });
      let size = 0;
      try {
        for (;;) {
          if (signal?.aborted) throw new Error('原图读取已取消');
          const { done, value } = await reader.read();
          if (signal?.aborted) throw new Error('原图读取已取消');
          if (done) break;
          size += value.length;
          const maximum = max();
          if (size > maximum) { const error = oversized(maximum); await reader.cancel(); throw error; }
          chunks.push(value);
        }
      } finally { signal?.removeEventListener('abort', stop); reader.releaseLock(); }
      const data = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
      return data;
    }
    function ownerKey(sender, name = 'default') {
      if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(name)) throw new Error('图片所有者无效');
      return JSON.stringify([sender.tab.id, sender.documentId || `frame:${sender.frameId ?? 0}`, name]);
    }
    function imageOwner(sender, name) {
      const key = ownerKey(sender, name);
      if (!owners.has(key)) {
        if (owners.size >= 256) throw new Error('图片所有者过多，请稍后重试');
        owners.set(key, { key, tabId: sender.tab.id, urls: new Set(), consumers: new Set(), batches: new Set(), live: true });
      }
      return owners.get(key);
    }
    function forgetUrl(url, entry) {
      for (const key of entry.owners) {
        const owner = owners.get(key);
        if (!owner) continue;
        owner.urls.delete(url);
        if (!owner.urls.size && !owner.batches.size && !owner.port) owners.delete(key);
      }
    }
    function removeCachedImage(url) {
      const existing = originalCache.get(url);
      if (existing) { cachedImageBytes -= existing.cost; originalCache.delete(url); forgetUrl(url, existing); }
    }
    function expireImages() {
      expiryTimer = undefined;
      for (const [url, entry] of originalCache) if (entry.expires <= now()) removeCachedImage(url);
      scheduleExpiry();
    }
    function scheduleExpiry() {
      if (expiryTimer) cancelTimer(expiryTimer);
      expiryTimer = undefined;
      if (!originalCache.size) return;
      const expires = Math.min(...Array.from(originalCache.values(), entry => entry.expires));
      expiryTimer = later(expireImages, Math.max(1, expires - now()));
      expiryTimer?.unref?.();
    }
    function releaseOwner(owner, keepUrls) {
      const keep = new Set(keepUrls || []);
      for (const batch of owner.batches) for (const url of batch.allowed) if (!keep.has(url)) batch.allowed.delete(url);
      for (const consumer of owner.consumers) if (!keep.has(consumer.url)) consumer.cancel();
      const referenced = new Set([...owner.urls, ...Array.from(owner.consumers, consumer => consumer.url)]);
      for (const url of referenced) {
        if (keep.has(url)) continue;
        owner.urls.delete(url);
        const cached = originalCache.get(url);
        if (cached) { cached.owners.delete(owner.key); if (!cached.owners.size) removeCachedImage(url); }
        const work = pendingImages.get(url);
        if (work) {
          work.owners.delete(owner.key); work.foreground.delete(owner.key);
          if (!work.owners.size) {
            pendingImages.delete(url);
            work.controller.abort();
            work.reject(new Error('原图读取已取消'));
          }
        }
      }
      if (keepUrls === undefined) { owner.live = false; if (owners.get(owner.key) === owner) owners.delete(owner.key); }
      scheduleExpiry();
      pumpImages();
    }
    function pumpImages() {
      while (activeImages < 3) {
        // A user click can promote an already queued speculative read.
        let index = imageQueue.findIndex(work => work.owners.size && work.foreground.size);
        if (index < 0 && !activePrefetch) index = imageQueue.findIndex(work => work.owners.size);
        if (index < 0) break;
        const work = imageQueue.splice(index, 1)[0];
        const speculative = !work.foreground.size;
        activeImages++; if (speculative) activePrefetch++;
        const finish = (error, image) => {
          if (pendingImages.get(work.url) === work) {
            pendingImages.delete(work.url);
            if (!originalCache.has(work.url)) forgetUrl(work.url, work);
          }
          if (error) work.reject(error); else work.resolve(image);
        };
        void runImage(work).then(image => finish(null, image), error => finish(error)).finally(() => {
          activeImages--; if (speculative) activePrefetch--;
          pumpImages();
        });
      }
      // Released queued work has already been rejected; do not retain its closures.
      for (let index = imageQueue.length - 1; index >= 0; index--) if (!imageQueue[index].owners.size) imageQueue.splice(index, 1);
    }
    async function runImage(work) {
      const { url, controller } = work;
      const timeout = later(() => controller.abort(), 30000);
      timeout?.unref?.();
      let onAbort;
      const cancelled = new Promise((_, reject) => {
        onAbort = () => reject(new Error('原图读取已取消或超时'));
        controller.signal.addEventListener('abort', onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
      });
      const reading = (async () => {
        const response = await request(url, { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal: controller.signal });
        if (controller.signal.aborted) { await response.body?.cancel(); throw new Error('原图读取已取消'); }
        if (response.url && (media.originalImageUrl(response.url) !== url || new URL(response.url).searchParams.get('name') !== 'orig')) throw new Error('原图请求发生了意外跳转，未接受缩略图');
        const type = (response.headers.get('content-type') || '').split(';')[0].trim();
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) throw new Error('服务器没有返回可复制的原图');
        const bytes = await readLimited(response, () => work.foreground.size ? 16 * 1024 ** 2 : PREFETCH_RAW_LIMIT, controller.signal);
        let binary = '';
        for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
        const image = { url, dataUrl: `data:${type};base64,${btoa(binary)}`, size: bytes.length, type };
        if (controller.signal.aborted || !work.owners.size || pendingImages.get(url) !== work) throw new Error('原图读取已取消');
        const cost = image.dataUrl.length * 2;
        // Large click reads still return unchanged bytes, but do not enter the bounded cache.
        if (cost <= CACHE_LIMIT) {
          originalCache.set(url, { image, cost, owners: new Set(work.owners), expires: now() + CACHE_TTL });
          cachedImageBytes += cost;
          while (cachedImageBytes > CACHE_LIMIT || originalCache.size > 24) removeCachedImage(originalCache.keys().next().value);
          scheduleExpiry();
        }
        return image;
      })();
      try { return await Promise.race([reading, cancelled]); }
      finally { cancelTimer(timeout); controller.signal.removeEventListener('abort', onAbort); controller.abort(); }
    }
    async function getOriginalImage(url, owner, speculative, retried = false) {
      if (!owner.live) throw new Error('原图读取已取消');
      const cached = originalCache.get(url);
      if (cached && cached.expires > now()) {
        owner.urls.add(url); cached.owners.add(owner.key);
        originalCache.delete(url); originalCache.set(url, cached);
        return cached.image;
      }
      removeCachedImage(url);
      let work = pendingImages.get(url);
      if (!work) {
        if (pendingImages.size >= 64 || (speculative && Array.from(pendingImages.values()).filter(item => !item.foreground.size).length >= 32)) throw new Error('图片请求过多，请稍后重试');
        let resolve, reject;
        const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
        work = { url, owners: new Set(), foreground: new Set(), controller: new AbortController(), promise, resolve, reject };
        pendingImages.set(url, work); imageQueue.push(work);
      }
      owner.urls.add(url);
      const consumer = { url, live: true };
      const cancelled = new Promise((_, reject) => {
        consumer.cancel = () => { consumer.live = false; reject(new Error('原图读取已取消')); };
      });
      owner.consumers.add(consumer);
      work.owners.add(owner.key);
      if (!speculative) work.foreground.add(owner.key);
      pumpImages();
      try {
        const image = await Promise.race([work.promise, cancelled]);
        if (!owner.live || !consumer.live) throw new Error('原图读取已取消');
        return image;
      } catch (error) {
        // A click can arrive while the speculative stream is already rejecting its size cap.
        if (!speculative && !retried && error.speculativeLimit && owner.live && consumer.live) {
          if (pendingImages.get(url) === work) pendingImages.delete(url);
          return await getOriginalImage(url, owner, false, true);
        }
        throw error;
      } finally {
        owner.consumers.delete(consumer);
        if (!originalCache.has(url) && pendingImages.get(url) !== work) owner.urls.delete(url);
      }
    }
    async function prepareImages(urls, owner, speculative = false) {
      if (!Array.isArray(urls) || urls.length > 16) throw new Error('图片列表无效');
      for (const url of urls) if (!media.originalImageUrl(url) || media.originalImageUrl(url) !== url) throw new Error('只能读取有效的 orig 原图地址');
      if (owner.batches.size >= 64) throw new Error('图片请求过多，请稍后重试');
      const batch = { allowed: new Set(urls) };
      owner.batches.add(batch);
      const result = new Array(urls.length);
      let next = 0, total = 0, failure;
      const workers = Array.from({ length: Math.min(3, urls.length) }, async () => {
        while (!failure && owner.live && next < urls.length) {
          const index = next++;
          if (!batch.allowed.has(urls[index])) continue;
          try {
            const image = await getOriginalImage(urls[index], owner, speculative);
            const cost = speculative ? image.dataUrl.length * 2 : image.size;
            if (speculative && total + cost > PREFETCH_LIMIT) continue;
            total += cost;
            if (!speculative && total > IMAGE_LIMIT) throw new Error('原图合计超过 24 MiB，无法安全写入剪贴板');
            result[index] = image;
          } catch (error) { if (!speculative) failure ||= error; }
        }
      });
      try {
        await Promise.all(workers);
        if (failure) throw failure;
        if (!owner.live && !speculative) throw new Error('原图读取已取消');
        return speculative ? result.filter(image => image && owner.live && batch.allowed.has(image.url)) : result;
      } finally {
        owner.batches.delete(batch);
        if (!owner.urls.size && !owner.batches.size && !owner.port && owners.get(owner.key) === owner) owners.delete(owner.key);
      }
    }
    api.runtime.onConnect?.addListener(port => {
      if (!port.name?.startsWith('xCopyImages:')) return;
      let owner;
      try {
        if (senderKind(port.sender) !== 'page') throw new Error('调用来源无效');
        owner = imageOwner(port.sender, port.name.slice('xCopyImages:'.length));
      } catch { port.disconnect(); return; }
      owner.port = port;
      port.onDisconnect.addListener(() => {
        if (owners.get(owner.key) === owner && owner.port === port) releaseOwner(owner);
      });
    });
    api.tabs.onRemoved?.addListener(tabId => {
      for (const owner of owners.values()) if (owner.tabId === tabId) releaseOwner(owner);
    });
    async function resolveMedia(list, tabId) {
      if (!Array.isArray(list) || list.length > 16) throw new Error('媒体列表无效');
      const items = list.map(media.normalizeMedia).filter(Boolean);
      if (items.every(item => item.type === 'photo' || item.url)) return items;
      let captured = [];
      for (const id of CAT_IDS) {
        let timer;
        try {
          const result = await Promise.race([api.runtime.sendMessage(id, { action: 'getData', tabId }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('猫抓未响应')), 1500); })]);
          if (Array.isArray(result)) captured.push(...result.slice(0, 1000));
        } catch { /* Cat Catch is an optional supplement. */ }
        finally { clearTimeout(timer); }
      }
      const matched = media.matchCaptured(items, captured);
      return items.map(item => matched.find(match => match.type === item.type && (match.id || match.poster) === (item.id || item.poster)) || item);
    }
    function schedule(job, forceMp4 = false) {
      const generation = job.generation || 0;
      const run = () => runJob(job, forceMp4, generation);
      if (job.type === 'animated_gif') gifQueue = gifQueue.then(run).catch(() => {});
      else void run();
    }
    async function runJob(job, forceMp4, generation) {
      const current = () => (job.generation || 0) === generation && job.status !== 'cancelled';
      if (!current()) return;
      let blobUrl;
      try {
        let url = job.url;
        if (job.type === 'animated_gif' && !forceMp4) {
          job.status = 'converting'; job.stage = '读取并转换 GIF'; await save(job);
          if (!current()) return;
          const result = await offscreen({ type: 'convertGif', jobId: job.id, url: job.url });
          blobUrl = result.url;
          if (!blobUrl?.startsWith(`blob:chrome-extension://${api.runtime.id}/`)) throw new Error('转换器返回了无效文件');
          url = blobUrl;
        }
        if (!current()) { if (blobUrl) await offscreen({ type: 'releaseBlob', jobId: job.id }); return; }
        job.status = 'downloading'; job.stage = '浏览器正在下载';
        job.extension = job.type === 'animated_gif' && !forceMp4 ? 'gif' : 'mp4';
        // Persist the state before starting the browser download; completion is event-driven.
        await save(job);
        if (!current()) return;
        const downloadId = await api.downloads.download({ url, filename: `X/${job.postId}_${job.index + 1}.${job.extension}`, conflictAction: 'uniquify', saveAs: false });
        if (!current()) { try { await api.downloads.cancel(downloadId); } catch { /* Download may already be terminal. */ } return; }
        job.downloadId = downloadId;
        await save(job);
        // Very small downloads can finish before downloadId has been assigned.
        const [actual] = await api.downloads.search({ id: job.downloadId });
        if (actual?.state === 'complete' || actual?.state === 'interrupted') await downloadChanged({ id: job.downloadId, state: { current: actual.state }, error: { current: actual.error } });
      } catch (error) {
        if (current()) { job.status = 'failed'; job.error = String(error?.message || error); job.stage = ''; await save(job); }
        if (blobUrl) try { await offscreen({ type: 'releaseBlob', jobId: job.id }); } catch { /* Already gone. */ }
      }
    }
    async function downloadChanged(delta) {
      await ready;
      const job = jobs.find(item => item.downloadId === delta.id);
      if (!job || !['complete', 'interrupted'].includes(delta.state?.current)) return;
      if (job.status !== 'cancelled') {
        job.status = delta.state.current === 'complete' ? 'complete' : 'failed';
        job.error = job.status === 'failed' ? `下载中断：${delta.error?.current || '请重试'}` : '';
        job.stage = '';
      }
      await save(job);
      if (job.extension === 'gif') try { await offscreen({ type: 'releaseBlob', jobId: job.id }); } catch { /* No surviving offscreen document. */ }
    }
    api.downloads.onChanged.addListener(delta => { void downloadChanged(delta).catch(() => {}); });
    async function handle(message, sender) {
      const kind = senderKind(sender);
      await ready;
      if (!message || typeof message.type !== 'string') throw new Error('消息无效');
      if (message.type === 'conversionHeartbeat') {
        if (kind !== 'offscreen') throw new Error('状态来源无效');
        const job = jobs.find(item => item.id === message.jobId && item.status === 'converting');
        if (job) { job.stage = String(message.stage || '正在转换 GIF').slice(0, 100); await save(job, false); }
        return true;
      }
      if (message.type === 'getJobs') return jobs.filter(job => kind !== 'page' || job.tabId === sender.tab.id).map(job => ({ ...job }));
      if (['prepareImages', 'prefetchImages'].includes(message.type) && kind === 'page') return prepareImages(message.urls, imageOwner(sender, message.owner), message.type === 'prefetchImages');
      if (message.type === 'releaseImages' && kind === 'page') {
        const key = ownerKey(sender, message.owner);
        if (message.keepUrls !== undefined && (!Array.isArray(message.keepUrls) || message.keepUrls.length > 32 || message.keepUrls.some(url => typeof url !== 'string'))) throw new Error('图片列表无效');
        const owner = owners.get(key);
        if (owner) releaseOwner(owner, message.keepUrls);
        return true;
      }
      if (message.type === 'resolveMedia' && kind === 'page') return resolveMedia(message.media, sender.tab.id);
      if (message.type === 'downloadMedia' && kind === 'page') {
        if (!/^\d{1,30}$/.test(message.postId) || !Array.isArray(message.media) || message.media.length > 16) throw new Error('帖子或媒体列表无效');
        const selected = message.media.map(media.normalizeMedia).filter(item => item && item.type !== 'photo');
        const added = [];
        for (const [index, item] of selected.entries()) {
          const existing = jobs.find(job => job.postId === message.postId && job.type === item.type && job.url === item.url && ACTIVE.has(job.status));
          if (existing) { added.push({ ...existing }); continue; }
          jobs = jobs.filter(job => ACTIVE.has(job.status) || jobs.indexOf(job) >= jobs.length - 60);
          if (jobs.length >= 100) throw new Error('下载任务过多，请等待现有任务结束');
          const job = { id: crypto.randomUUID(), postId: message.postId, tabId: sender.tab.id, type: item.type, url: item.url, index,
            status: item.url ? 'queued' : 'failed', error: item.url ? '' : '尚未取得该帖完整 MP4；请播放媒体后重试，或使用猫抓处理 HLS', createdAt: Date.now() };
          jobs.push(job); added.push({ ...job });
          await save(job);
          if (item.url) {
            schedule(job);
          }
        }
        return added;
      }
      if (['cancelJob', 'retryMp4', 'retryJob'].includes(message.type) && kind !== 'offscreen') {
        const job = jobs.find(item => item.id === message.jobId && (kind !== 'page' || item.tabId === sender.tab.id));
        if (!job) throw new Error('任务不存在');
        if (message.type === 'cancelJob') {
          const downloadId = job.downloadId;
          job.generation = (job.generation || 0) + 1;
          job.status = 'cancelled'; job.stage = ''; await save(job);
          if (downloadId) try { await api.downloads.cancel(downloadId); } catch { /* Already terminal. */ }
          if (job.type === 'animated_gif') try { await offscreen({ type: 'cancelConversion', jobId: job.id }); } catch { /* Nothing running. */ }
        } else {
          if (ACTIVE.has(job.status)) return { ...job };
          if (!media.validVideoUrl(job.url)) throw new Error('没有完整 MP4 地址，请回到原帖播放媒体后重新点击');
          job.generation = (job.generation || 0) + 1;
          job.status = 'queued'; job.error = ''; delete job.downloadId;
          await save(job);
          const force = message.type === 'retryMp4';
          schedule(job, force);
        }
        return { ...job };
      }
      throw new Error('不支持的操作');
    }
    return { handle };
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { createService };
  else {
    const service = createService(chrome);
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
      if (message?.target === 'offscreen') return false;
      service.handle(message, sender).then(data => respond({ ok: true, data }), error => respond({ ok: false, error: error.message || String(error) }));
      return true;
    });
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
