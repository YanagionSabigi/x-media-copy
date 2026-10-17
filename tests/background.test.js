const test = require('node:test');
const assert = require('node:assert/strict');
const bg = require('../background.js');

function setup(options = {}) {
  const stored = {}, calls = [], notifications = [];
  let listener, connectListener, removedListener;
  const api = {
    runtime: { onConnect: { addListener(fn) { connectListener = fn; } }, id: 'extension', getURL: path => `chrome-extension://extension/${path}`, getContexts: async () => [{ contextType: 'OFFSCREEN_DOCUMENT' }],
      sendMessage: async message => options.convert ? options.convert(message) : { ok: true, url: 'blob:chrome-extension://extension/test' } },
    storage: { session: { get: async () => stored, set: async value => Object.assign(stored, value) } },
    offscreen: { createDocument: async () => {} },
    tabs: { onRemoved: { addListener(fn) { removedListener = fn; } }, sendMessage: async (id, message) => notifications.push(message) },
    downloads: { download: async args => { calls.push(args); return calls.length; }, search: async () => [], cancel: async () => {}, onChanged: { addListener(fn) { listener = fn; } } }
  };
  const service = bg.createService(api, { fetch: options.fetch || global.fetch, now: options.now || Date.now, setTimeout: options.setTimeout, clearTimeout: options.clearTimeout });
  return { service, api, calls, notifications, change: event => listener(event), connect: port => connectListener(port), removeTab: id => removedListener(id) };
}
const page = { id: 'extension', tab: { id: 7 }, url: 'https://x.com/home' };
const popup = { id: 'extension', url: 'chrome-extension://extension/popup.html' };

test('background rejects external senders and arbitrary media fetch URLs', async () => {
  const { service } = setup();
  await assert.rejects(service.handle({ type: 'prepareImages', urls: ['https://evil.test/a.jpg'] }, page));
  await assert.rejects(service.handle({ type: 'getJobs' }, { id: 'other', url: 'https://x.com/' }));
  await assert.rejects(service.handle({ type: 'prepareImages', urls: ['https://pbs.twimg.com/profile_images/a.jpg'] }, page));
});

test('orig fetch rejects a redirected thumbnail instead of silently copying it', async () => {
  const response = new Response('image', { headers: { 'content-type': 'image/png' } });
  Object.defineProperty(response, 'url', { value: 'https://pbs.twimg.com/media/ABC?format=png&name=small' });
  const { service } = setup({ fetch: async () => response });
  await assert.rejects(service.handle({ type: 'prepareImages', urls: ['https://pbs.twimg.com/media/ABC?format=png&name=orig'] }, page), /跳转/);
});

test('three original photos fetch concurrently while preserving input order and exact bytes', async t => {
  let active = 0, peak = 0;
  const urls = ['A','B','C'].map(id => `https://pbs.twimg.com/media/${id}?format=png&name=orig`);
  const { service } = setup({ fetch: async url => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, url.includes('/A?') ? 60 : 20));
    active--;
    const response = new Response(Buffer.from('original-bytes:' + url), { headers: { 'content-type': 'image/png' } });
    Object.defineProperty(response, 'url', { value: url }); return response;
  } });
  const start = performance.now();
  const result = await service.handle({ type: 'prepareImages', urls }, page);
  t.diagnostic(`Three-image elapsed: ${(performance.now()-start).toFixed(1)} ms; peak requests: ${peak}`);
  assert.equal(peak, 3);
  assert.deepEqual(result.map(item => item.url), urls);
  result.forEach((item, index) => assert.equal(Buffer.from(item.dataUrl.split(',')[1], 'base64').toString(), 'original-bytes:' + urls[index]));
});

test('concurrent and repeated original-image requests share an unchanged cached result', async () => {
  let calls = 0;
  const { service } = setup({ fetch: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 15)); return new Response('unchanged-original', { headers: { 'content-type': 'image/png' } }); } });
  const request = { type: 'prepareImages', urls: ['https://pbs.twimg.com/media/CACHE?format=png&name=orig'] };
  const [a,b] = await Promise.all([service.handle(request, page), service.handle(request, page)]);
  const c = await service.handle(request, page);
  assert.equal(calls, 1);
  assert.equal(a[0].dataUrl, b[0].dataUrl); assert.equal(a[0].dataUrl, c[0].dataUrl);
});

test('failed original-image requests are retriable and successful cache expires', async () => {
  let calls = 0, now = 1000;
  const { service } = setup({ now: () => now, fetch: async () => { calls++; if (calls===1) throw new Error('network'); return new Response('original', { headers: { 'content-type': 'image/png' } }); } });
  const request = { type: 'prepareImages', urls: ['https://pbs.twimg.com/media/TTL?format=png&name=orig'] };
  await assert.rejects(service.handle(request, page), /network/);
  await service.handle(request, page); await service.handle(request, page);
  assert.equal(calls, 2);
  now += 11 * 60 * 1000;
  await service.handle(request, page); assert.equal(calls, 3);
});

test('downloads start after request but complete only after browser completion event', async () => {
  const { service, calls, change } = setup();
  const request = { type: 'downloadMedia', postId: '123', media: [{ type: 'video', id: '11', url: 'https://video.twimg.com/ext_tw_video/11/a.mp4' }] };
  await service.handle(request, page);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(calls.length, 1);
  assert.equal((await service.handle({ type: 'getJobs' }, popup))[0].status, 'downloading');
  await service.handle(request, page);
  assert.equal(calls.length, 1);
  await change({ id: 1, state: { current: 'complete' } });
  assert.equal((await service.handle({ type: 'getJobs' }, popup))[0].status, 'complete');
});

test('interrupted download reports failure and cancellation is terminal', async () => {
  const { service, change } = setup();
  await service.handle({ type: 'downloadMedia', postId: '123', media: [{ type: 'video', url: 'https://video.twimg.com/ext_tw_video/11/a.mp4' }] }, page);
  await new Promise(resolve => setTimeout(resolve, 10));
  await change({ id: 1, state: { current: 'interrupted' }, error: { current: 'NETWORK_FAILED' } });
  const [job] = await service.handle({ type: 'getJobs' }, popup);
  assert.equal(job.status, 'failed');
  assert.match(job.error, /NETWORK_FAILED/);
  await service.handle({ type: 'cancelJob', jobId: job.id }, popup);
  assert.equal((await service.handle({ type: 'getJobs' }, popup))[0].status, 'cancelled');
});

test('failed GIF conversion never downloads a fake GIF; explicit fallback uses mp4', async () => {
  const { service, calls } = setup({ convert: async () => { throw new Error('转换超时'); } });
  await service.handle({ type: 'downloadMedia', postId: '123', media: [{ type: 'animated_gif', url: 'https://video.twimg.com/tweet_video/ABC.mp4' }] }, page);
  await new Promise(resolve => setTimeout(resolve, 10));
  const [job] = await service.handle({ type: 'getJobs' }, popup);
  assert.equal(job.status, 'failed');
  assert.equal(calls.length, 0);
  await service.handle({ type: 'retryMp4', jobId: job.id }, popup);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(calls[0].filename, /\.mp4$/);
});

test('late conversion result after cancel and retry cannot start the cancelled GIF download', async () => {
  let finish;
  const { service, calls } = setup({ convert: async message => message.type === 'convertGif' ? new Promise(resolve => { finish = resolve; }) : { ok: true } });
  await service.handle({ type: 'downloadMedia', postId: '123', media: [{ type: 'animated_gif', url: 'https://video.twimg.com/tweet_video/ABC.mp4' }] }, page);
  await new Promise(resolve => setTimeout(resolve, 10));
  const [job] = await service.handle({ type: 'getJobs' }, popup);
  await service.handle({ type: 'cancelJob', jobId: job.id }, popup);
  await service.handle({ type: 'retryMp4', jobId: job.id }, popup);
  finish({ ok: true, url: 'blob:chrome-extension://extension/late' });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(calls.length, 1);
  assert.match(calls[0].filename, /\.mp4$/);
});


const originalUrl = id => `https://pbs.twimg.com/media/${id}?format=png&name=orig`;
const imageResponse = (size = 10) => new Response(new Uint8Array(size), { headers: { 'content-type': 'image/png' } });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('original reads bypass disk cache and owner release forces a fresh read', async () => {
  const calls = [];
  const { service } = setup({ fetch: async (url, options) => { calls.push(options); return imageResponse(); } });
  const request = { type: 'prepareImages', owner: 'first', urls: [originalUrl('OWNER')] };
  await service.handle(request, page);
  assert.equal(calls[0].cache, 'no-store');
  await service.handle({ type: 'releaseImages', owner: 'first' }, page);
  await service.handle(request, page);
  assert.equal(calls.length, 2);
});

test('prefetch returns successful subset, skips oversized images, and clicks keep original bytes', async () => {
  const { service } = setup({ fetch: async url => {
    if (url.includes('/FAIL?')) throw new Error('network');
    return imageResponse(url.includes('/BIG?') ? 4 * 1024 ** 2 : 10);
  } });
  const urls = ['OK', 'FAIL', 'BIG'].map(originalUrl);
  const prefetched = await service.handle({ type: 'prefetchImages', owner: 'prefetch', urls }, page);
  assert.deepEqual(prefetched.map(image => image.url), [urls[0]]);
  const clicked = await service.handle({ type: 'prepareImages', owner: 'prefetch', urls: [urls[2]] }, page);
  assert.equal(clicked[0].size, 4 * 1024 ** 2);
});

test('releasing one of two tabs preserves shared fetch, releasing last aborts and prevents late cache insertion', async () => {
  let complete, signal, calls = 0;
  const { service } = setup({ fetch: async (url, options) => { calls++; signal = options.signal; return new Promise(resolve => { complete = resolve; }); } });
  const message = { type: 'prepareImages', owner: 'shared', urls: [originalUrl('SHARED')] };
  const other = { ...page, tab: { id: 8 } };
  const first = service.handle(message, page); first.catch(() => {});
  const second = service.handle(message, other); second.catch(() => {});
  await tick();
  await service.handle({ type: 'releaseImages', owner: 'shared' }, page);
  assert.equal(signal.aborted, false);
  await service.handle({ type: 'releaseImages', owner: 'shared' }, other);
  assert.equal(signal.aborted, true);
  complete(imageResponse());
  await assert.rejects(first); await assert.rejects(second);
  const fresh = service.handle(message, other);
  await tick();
  assert.equal(calls, 2);
  complete(imageResponse()); await fresh;
});

test('foreground work passes queued prefetch and speculative requests never overlap', async () => {
  const started = [], finishes = [];
  const { service } = setup({ fetch: async url => { started.push(url); return new Promise(resolve => finishes.push(() => resolve(imageResponse()))); } });
  const prefetched = service.handle({ type: 'prefetchImages', owner: 'auto', urls: ['S1','S2','S3'].map(originalUrl) }, page);
  await tick();
  assert.equal(started.length, 1);
  const clicked = service.handle({ type: 'prepareImages', owner: 'click', urls: ['C1','C2','C3'].map(originalUrl) }, page);
  await tick();
  assert.deepEqual(started.map(url => /media\/(.*?)\?/.exec(url)[1]), ['S1','C1','C2']);
  finishes.shift()(); await tick();
  assert.equal(started[3], originalUrl('C3'));
  while (finishes.length || started.length < 6) { finishes.shift()?.(); await tick(); }
  await Promise.all([prefetched, clicked]);
});

test('release cancels queued originals and document identity isolates stale cleanup', async () => {
  const started = [], finishes = [];
  const { service } = setup({ fetch: async url => { started.push(url); return new Promise(resolve => finishes.push(() => resolve(imageResponse()))); } });
  const oldPage = { ...page, documentId: 'old' }, newPage = { ...page, documentId: 'new' };
  const first = service.handle({ type: 'prepareImages', owner: 'owner', urls: ['Q1','Q2','Q3','Q4'].map(originalUrl) }, oldPage); first.catch(() => {});
  await tick();
  await service.handle({ type: 'releaseImages', owner: 'owner' }, oldPage);
  finishes.splice(0).forEach(finish => finish()); await assert.rejects(first); await tick();
  assert.equal(started.length, 3);
  const fresh = service.handle({ type: 'prepareImages', owner: 'owner', urls: [originalUrl('NEW')] }, newPage);
  await tick();
  await service.handle({ type: 'releaseImages', owner: 'owner' }, oldPage);
  finishes.shift()(); assert.equal((await fresh).length, 1);
});

test('a released prefetch operation returns no earlier partial images', async () => {
  let finish;
  const { service } = setup({ fetch: async url => url.includes('/FAST?') ? imageResponse() : new Promise(resolve => { finish = resolve; }) });
  const result = service.handle({ type: 'prefetchImages', owner: 'hidden', urls: ['FAST','SLOW'].map(originalUrl) }, page);
  await tick();
  await service.handle({ type: 'releaseImages', owner: 'hidden' }, page);
  finish(imageResponse());
  assert.deepEqual(await result, []);
});

test('owner ports and tab close release originals without removing another tab cache ownership', async () => {
  let count = 0, disconnect;
  const { service, connect, removeTab } = setup({ fetch: async () => { count++; return imageResponse(); } });
  const port = { name: 'xCopyImages:portOwner', sender: page, onDisconnect: { addListener(fn) { disconnect = fn; } }, disconnect() { throw new Error('unexpected disconnect'); } };
  connect(port);
  const message = { type: 'prepareImages', owner: 'portOwner', urls: [originalUrl('PORT')] };
  const other = { ...page, tab: { id: 8 } };
  await service.handle(message, page); await service.handle(message, other);
  disconnect(); await service.handle(message, other); assert.equal(count, 1);
  removeTab(8);
  await service.handle(message, page); assert.equal(count, 2);
});

test('keepUrls prunes only this owner and rejects invalid owner identities', async () => {
  let count = 0;
  const { service } = setup({ fetch: async () => { count++; return imageResponse(); } });
  const urls = ['KEEP','DROP'].map(originalUrl);
  await service.handle({ type: 'prepareImages', owner: 'owner', urls }, page);
  await service.handle({ type: 'releaseImages', owner: 'owner', keepUrls: [urls[0]] }, page);
  await service.handle({ type: 'prepareImages', owner: 'owner', urls }, page);
  assert.equal(count, 3);
  for (const owner of ['', '../bad', 'a'.repeat(101), {}]) await assert.rejects(service.handle({ type: 'prefetchImages', owner, urls }, page), /所有者/);
});

test('cache expires proactively by 120 seconds without another image request', async () => {
  let time = 1000, nextId = 0, count = 0;
  const timers = new Map();
  const { service } = setup({ now: () => time,
    setTimeout: (fn, delay) => { const id = ++nextId; timers.set(id, { fn, due: time + delay }); return id; },
    clearTimeout: id => timers.delete(id), fetch: async () => { count++; return imageResponse(); } });
  const message = { type: 'prepareImages', urls: [originalUrl('EXPIRY')] };
  await service.handle(message, page);
  assert.equal(timers.size, 1);
  const [[id, timer]] = timers; assert.ok(timer.due <= time + 120000);
  time += 120000; timers.delete(id); timer.fn();
  assert.equal(timers.size, 0);
  await service.handle(message, page); assert.equal(count, 2);
});

test('encoded cache stays below16MiB and prefetch response below8MiB', async () => {
  let count = 0;
  const { service } = setup({ fetch: async () => { count++; return imageResponse(2 * 1024 ** 2); } });
  const urls = ['CAP1','CAP2','CAP3','CAP4'].map(originalUrl);
  const result = await service.handle({ type: 'prefetchImages', owner: 'budget', urls }, page);
  assert.ok(result.reduce((sum, image) => sum + image.dataUrl.length * 2, 0) <= 8 * 1024 ** 2);
  assert.equal(result.length, 1);
  await service.handle({ type: 'prepareImages', owner: 'budget', urls: [urls[0]] }, page);
  assert.equal(count, 5, 'four encoded2MiB originals exceed16MiB and evict the oldest');
});

test('a click promotes an active prefetch to the full original size allowance', async () => {
  let deliver, count = 0;
  const { service } = setup({ fetch: async () => { count++; return new Response(new ReadableStream({ start(controller) { deliver = () => { controller.enqueue(new Uint8Array(4 * 1024 ** 2)); controller.close(); }; } }), { headers: { 'content-type': 'image/png' } }); } });
  const urls = [originalUrl('PROMOTE')];
  const auto = service.handle({ type: 'prefetchImages', owner: 'auto', urls }, page);
  await tick();
  const click = service.handle({ type: 'prepareImages', owner: 'click', urls }, page);
  await tick(); deliver();
  assert.equal((await click)[0].size, 4 * 1024 ** 2);
  assert.deepEqual(await auto, []);
  assert.equal(count, 1);
});

test('foreground cache eviction does not cancel an otherwise valid multi-image copy', async () => {
  const { service } = setup({ fetch: async () => imageResponse(4 * 1024 ** 2) });
  const result = await service.handle({ type: 'prepareImages', owner: 'batch', urls: ['FULL1','FULL2','FULL3'].map(originalUrl) }, page);
  assert.deepEqual(result.map(image => image.size), Array(3).fill(4 * 1024 ** 2));
  for (const image of result) assert.equal(Buffer.from(image.dataUrl.split(',')[1], 'base64').length, 4 * 1024 ** 2);
});

test('a just-failed speculative size read cannot poison a foreground retry', async () => {
  let count = 0, click;
  const urls = [originalUrl('RETRYBIG')];
  const { service } = setup({ fetch: async () => {
    count++;
    if (count === 1) return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(4 * 1024 ** 2)); }, cancel() {
      click = service.handle({ type: 'prepareImages', owner: 'click', urls }, page);
    } }), { headers: { 'content-type': 'image/png' } });
    return imageResponse(4 * 1024 ** 2);
  } });
  await service.handle({ type: 'prefetchImages', owner: 'auto', urls }, page);
  assert.equal((await click)[0].size, 4 * 1024 ** 2);
  assert.equal(count, 2);
});

test('speculative pending work is bounded and releases all queued requests promptly', async () => {
  let calls = 0, finished = 0;
  const { service } = setup({ fetch: async () => { calls++; return new Promise(() => {}); } });
  const operations = Array.from({ length: 40 }, (_, index) => service.handle({ type: 'prefetchImages', owner: 'bounded', urls: [originalUrl('BOUND' + index)] }, page).then(images => { finished++; return images; }));
  await tick();
  assert.equal(calls, 1);
  assert.equal(finished, 8, 'at most32 speculative requests are pending');
  await service.handle({ type: 'releaseImages', owner: 'bounded' }, page);
  assert.ok((await Promise.all(operations)).every(images => !images.length));
  assert.equal(calls, 1);
});

test('foreground pending work is bounded at64 including running requests', async () => {
  let calls = 0, rejected = 0;
  const { service } = setup({ fetch: async () => { calls++; return new Promise(() => {}); } });
  const operations = Array.from({ length: 65 }, (_, index) => service.handle({ type: 'prepareImages', owner: 'bounded', urls: [originalUrl('FRONT' + index)] }, page).catch(error => { rejected++; return error; }));
  await tick();
  assert.equal(calls, 3);
  assert.equal(rejected, 1);
  await service.handle({ type: 'releaseImages', owner: 'bounded' }, page);
  await Promise.all(operations);
  assert.equal(calls, 3);
});

test('invalid image responses stop their underlying network read', async () => {
  let aborted = false;
  const { service } = setup({ fetch: async (url, options) => {
    options.signal.addEventListener('abort', () => { aborted = true; });
    return new Response(new ReadableStream({ start() {} }), { headers: { 'content-type': 'text/html' } });
  } });
  await assert.rejects(service.handle({ type: 'prepareImages', urls: [originalUrl('INVALID')] }, page));
  assert.equal(aborted, true);
});

test('cache retains at most24 originals even when every encoded image is tiny', async () => {
  let calls = 0;
  const { service } = setup({ fetch: async () => { calls++; return imageResponse(); } });
  const urls = Array.from({ length: 25 }, (_, index) => originalUrl('SMALL' + index));
  await service.handle({ type: 'prepareImages', owner: 'many', urls: urls.slice(0, 16) }, page);
  await service.handle({ type: 'prepareImages', owner: 'many', urls: urls.slice(16) }, page);
  await service.handle({ type: 'prepareImages', owner: 'many', urls: [urls[0]] }, page);
  assert.equal(calls, 26);
});

test('30 second original timeout aborts the fetch and cannot insert a late result', async () => {
  let time = 0, nextId = 0, finish, calls = 0, signal;
  const timers = new Map();
  const { service } = setup({ now: () => time,
    setTimeout: (fn, delay) => { const id = ++nextId; timers.set(id, { fn, due: time + delay }); return id; },
    clearTimeout: id => timers.delete(id), fetch: async (url, options) => { calls++; signal = options.signal; return new Promise(resolve => { finish = resolve; }); } });
  const message = { type: 'prepareImages', owner: 'timeout', urls: [originalUrl('TIMEOUT')] };
  const result = service.handle(message, page); result.catch(() => {});
  await tick();
  const [[id, timer]] = timers; assert.equal(timer.due, 30000);
  time = timer.due; timers.delete(id); timer.fn();
  await assert.rejects(result, /超时/); assert.equal(signal.aborted, true);
  finish(imageResponse()); await tick();
  const fresh = service.handle(message, page); await tick();
  assert.equal(calls, 2); finish(imageResponse()); await fresh;
});

test('releasing a batch promptly rejects its consumer while another tab continues the shared fetch', async () => {
  let finishShared, signal, calls = 0;
  const { service } = setup({ fetch: async (url, options) => {
    calls++;
    if (url.includes('/EARLY?')) return imageResponse(1024);
    signal = options.signal;
    return new Promise(resolve => { finishShared = resolve; });
  } });
  const shared = originalUrl('WAITSHARED');
  let firstSettled = false, secondSettled = false;
  const first = service.handle({ type: 'prepareImages', owner: 'departing', urls: [originalUrl('EARLY'), shared] }, page);
  first.catch(() => { firstSettled = true; });
  const second = service.handle({ type: 'prepareImages', owner: 'remaining', urls: [shared] }, { ...page, tab: { id: 8 } });
  second.then(() => { secondSettled = true; });
  await tick();
  await service.handle({ type: 'releaseImages', owner: 'departing' }, page);
  await tick();
  assert.equal(firstSettled, true, 'the departing batch must release its completed image without waiting for the shared network read');
  assert.equal(secondSettled, false);
  assert.equal(signal.aborted, false);
  finishShared(imageResponse());
  await assert.rejects(first, /取消/);
  assert.equal((await second)[0].url, shared);
  assert.equal(calls, 2);
});

test('clearing keepUrls preserves the connected owner registration for later requests', async () => {
  let disconnect, calls = 0;
  const { service, connect } = setup({ fetch: async () => { calls++; return imageResponse(); } });
  connect({ name: 'xCopyImages:reusable', sender: page, onDisconnect: { addListener(fn) { disconnect = fn; } }, disconnect() {} });
  const message = { type: 'prepareImages', owner: 'reusable', urls: [originalUrl('REUSABLE')] };
  await service.handle(message, page);
  await service.handle({ type: 'releaseImages', owner: 'reusable', keepUrls: [] }, page);
  await service.handle(message, page);
  assert.equal(calls, 2);
  disconnect();
  await service.handle(message, page);
  assert.equal(calls, 3, 'the original port must still release the reused owner');
});
