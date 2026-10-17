const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const core = require("../core.js");
const extractor = require("../extractor.js");
const bar = '<div role="group" class="actions"><button data-testid="reply">评论</button><button data-testid="retweet">转帖</button><button data-testid="like">喜欢</button><button data-testid="share">转发</button></div>';
const link = id => `<a href="https://x.com/a/status/${id}?s=20"><time>now</time></a>`;
function fixture(html, options = {}) {
  const dom = new JSDOM(html, { url: "https://x.com", runScripts: "outside-only" });
  const writes = [], likes = [], ports = [], observations = [];
  const timers = new Map(); let clock = 0, timerId = 0;
  if (options.clock) {
    dom.window.setTimeout = (callback, delay = 0) => { const id = ++timerId; timers.set(id, { callback, at: clock + delay }); return id; };
    dom.window.clearTimeout = id => timers.delete(id);
    dom.window.Date.now = () => clock;
  }
  let hidden = false;
  Object.defineProperty(dom.window.document, 'hidden', { get: () => hidden });
  Object.defineProperty(dom.window.document, 'visibilityState', { get: () => hidden ? 'hidden' : 'visible' });
  if (options.observer) dom.window.IntersectionObserver = class {
    constructor(callback) { this.callback = callback; this.targets = new Set(); observations.push(this); }
    observe(target) { this.targets.add(target); }
    unobserve(target) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
  };
  for (const button of dom.window.document.querySelectorAll('[data-testid="like"], [data-testid="unlike"]')) {
    button.addEventListener('click', () => {
      likes.push(button);
      if (options.likeHandler) options.likeHandler(button);
      else button.dataset.testid = button.dataset.testid === 'like' ? 'unlike' : 'like';
    });
  }
  Object.assign(dom.window, { XCopyCore: core, XCopyExtractor: extractor, XCopyMedia: options.media ? require('../media.js') : undefined,
    chrome: { runtime: { id: 'test-extension', getManifest: () => { if (options.invalidated?.()) throw new Error('Extension context invalidated.'); return {}; }, connect: ({ name }) => { const listeners = []; const port = { name, disconnected: false, onDisconnect: { addListener(fn) { listeners.push(fn); } }, disconnect() { port.disconnected = true; listeners.forEach(fn => fn()); } }; ports.push(port); return port; }, sendMessage: async request => ({ ok: true, data: await options.message?.(request) }), onMessage: { addListener() {}, removeListener() {} } } },
    XCopyClipboard: { inspectImages: options.inspectImages, writeText: async data => { await options.beforeWrite?.(data); writes.push(core.buildClipboardPayload(data)); }, writeImage: async data => { await options.beforeWrite?.(data); writes.push({ image: data }); } } });
  dom.window.eval(fs.readFileSync(path.join(__dirname, "../content.js"), "utf8"));
  return { dom, document: dom.window.document, writes, likes, ports,
    async advance(ms) { const target = clock + ms; let next; while ((next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0])) { timers.delete(next[0]); clock = next[1].at; next[1].callback(); await tick(0); } clock = target; },
    intersect(article, visible = true) { observations.at(-1)?.callback([{ target: article, isIntersecting: visible, intersectionRatio: visible ? 1 : 0 }]); },
    visibility(value) { hidden = value; dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange')); } };
}
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
const photoPost = (id, extra = '') => `<article><img src="https://pbs.twimg.com/media/P${id}.jpg">${extra}${link(id)}${bar}</article>`;
const imageResult = request => request.urls.map(url => ({ url, dataUrl: 'data:image/jpeg;base64,AAAA' }));

test('click promotes missing originals immediately while speculative reads remain pending', async () => {
  const calls = []; let finish;
  const setup = fixture(photoPost(1), { media: true, message: request => { calls.push(request); if (request.type === 'prefetchImages') return new Promise(resolve => { finish = () => resolve(imageResult(request)); }); return request.urls ? imageResult(request) : true; } });
  try {
    const button = setup.document.querySelector('.x-copy-post-button'); button.dispatchEvent(new setup.dom.window.Event('pointerenter')); await tick(20);
    button.click(); await tick(20);
    assert.equal(calls.filter(call => call.type === 'prepareImages').length, 1);
    assert.equal(setup.writes.length, 1); finish(); await tick(0);
  } finally { setup.dom.window.close(); }
});

test('scrolling away cancels speculation without releasing an explicit copy of the same originals', async () => {
  const calls = []; let finishAuto, finishCopy;
  const setup = fixture(photoPost(1), { media: true, observer: true, message: request => { calls.push(request); if (request.type === 'prefetchImages') return new Promise(resolve => { finishAuto = () => resolve(imageResult(request)); }); if (request.type === 'prepareImages') return new Promise(resolve => { finishCopy = () => resolve(imageResult(request)); }); return true; } });
  try {
    const article = setup.document.querySelector('article'); setup.intersect(article); await tick(550);
    article.querySelector('.x-copy-post-button').click(); await tick(0);
    setup.intersect(article, false); await tick(0);
    assert.ok(!calls.some(call => call.type === 'releaseImages' && call.keepUrls?.length === 0));
    finishCopy(); await tick(20); assert.equal(setup.writes.length, 1);
    finishAuto(); await tick(0);
  } finally { setup.dom.window.close(); }
});

test('oversized encoded originals keep only URL metadata and explicit copies preserve full bytes', async () => {
  const calls = []; const dataUrl = 'data:image/jpeg;base64,' + 'A'.repeat(4 * 1024 * 1024);
  const copied = [];
  const setup = fixture(photoPost(1), { media: true, beforeWrite: data => copied.push(data.images[0].dataUrl), message: request => { calls.push(request); return request.urls ? request.urls.map(url => ({ url, dataUrl })) : true; } });
  try {
    const button = setup.document.querySelector('.x-copy-post-button'); button.dispatchEvent(new setup.dom.window.Event('pointerenter')); await tick(20);
    assert.ok(calls.some(call => call.type === 'releaseImages' && call.keepUrls?.some(url => url.includes('/media/P1?'))));
    button.click(); await tick(20); button.click(); await tick(20);
    assert.equal(calls.filter(call => call.type === 'prepareImages').length, 2);
    assert.deepEqual(copied, [dataUrl, dataUrl]);
  } finally { setup.dom.window.close(); }
});

test('page byte eviction retains worker interest for two recent groups, and a third group releases the oldest', async () => {
  const calls = []; const dataUrl = 'data:image/jpeg;base64,' + 'A'.repeat(2200000);
  const setup = fixture(photoPost(1) + photoPost(2) + photoPost(3), { media: true, message: request => { calls.push(request); return request.urls ? request.urls.map(url => ({ url, dataUrl })) : true; } });
  try {
    const buttons = setup.document.querySelectorAll('.x-copy-post-button');
    buttons[0].dispatchEvent(new setup.dom.window.Event('pointerenter')); await tick(20);
    buttons[1].dispatchEvent(new setup.dom.window.Event('pointerenter')); await tick(20);
    let keep = calls.filter(call => call.type === 'releaseImages').at(-1).keepUrls;
    assert.equal(keep.length, 2); assert.ok(keep.some(url => url.includes('/media/P1?')));
    buttons[2].dispatchEvent(new setup.dom.window.Event('pointerenter')); await tick(20);
    keep = calls.filter(call => call.type === 'releaseImages').at(-1).keepUrls;
    assert.equal(keep.length, 2); assert.ok(!keep.some(url => url.includes('/media/P1?')));
  } finally { setup.dom.window.close(); }
});

test('foreground output keeps all original images when page byte eviction clears its cached subset', async () => {
  const dataUrl = 'data:image/jpeg;base64,' + 'A'.repeat(2200000); let copied;
  const setup = fixture(photoPost(1, '<img src="https://pbs.twimg.com/media/SECOND.jpg">'), { media: true, beforeWrite: data => { copied = data.images; }, message: request => request.urls ? request.urls.slice(0, request.type === 'prefetchImages' ? 1 : undefined).map(url => ({ url, dataUrl })) : true });
  try {
    const button = setup.document.querySelector('.x-copy-post-button'); button.dispatchEvent(new setup.dom.window.Event('pointerenter')); await tick(20);
    button.click(); await tick(20);
    assert.equal(copied.length, 2); assert.ok(copied.every(image => image?.dataUrl === dataUrl));
  } finally { setup.dom.window.close(); }
});

test('encoded original expiry proactively releases the worker and next copy fetches again', async () => {
  const calls = [];
  const setup = fixture(photoPost(1), { media: true, clock: true, message: request => { calls.push(request); return request.urls ? imageResult(request) : true; } });
  try {
    const button = setup.document.querySelector('.x-copy-post-button'); button.dispatchEvent(new setup.dom.window.Event('pointerenter')); await setup.advance(0);
    calls.length = 0;
    await setup.advance(120000);
    assert.ok(calls.some(call => call.type === 'releaseImages' && call.keepUrls?.length === 0));
    button.click(); await tick(20);
    assert.equal(calls.filter(call => call.type === 'prepareImages').length, 1);
    assert.equal(setup.writes.length, 1);
  } finally { setup.dom.window.close(); }
});

test('a worker port disconnect reconnects on the next image request without invalidating the page', async () => {
  const calls = [];
  const setup = fixture(photoPost(1) + photoPost(2), { media: true, message: request => { calls.push(request); return request.urls ? imageResult(request) : true; } });
  try {
    const buttons = setup.document.querySelectorAll('.x-copy-post-button'); buttons[0].dispatchEvent(new setup.dom.window.Event('pointerenter')); await tick(20);
    setup.ports[0].disconnect(); buttons[1].click(); await tick(20);
    assert.equal(setup.ports.length, 2); assert.equal(setup.ports[0].name, setup.ports[1].name);
    assert.equal(setup.writes.length, 1); assert.equal(setup.likes.length, 1);
    assert.equal(setup.document.querySelector('.x-copy-toast button'), null);
  } finally { setup.dom.window.close(); }
});

test('SPA navigation and visibility changes reject late reads and resume with a fresh owner', async () => {
  for (const event of ['navigation', 'visibility']) {
    const calls = []; let finish;
    const setup = fixture(photoPost(1), { media: true, observer: true, message: request => { calls.push(request); if (request.type === 'prefetchImages' && !finish) return new Promise(resolve => { finish = () => resolve(imageResult(request)); }); return request.urls ? imageResult(request) : true; } });
    try {
      const button = setup.document.querySelector('.x-copy-post-button'); button.dispatchEvent(new setup.dom.window.Event('pointerenter')); await tick(20);
      const owner = calls[0].owner;
      if (event === 'navigation') setup.dom.window.history.pushState({}, '', '/new');
      else { setup.visibility(true); setup.visibility(false); }
      finish(); await tick(10);
      button.click(); await tick(20);
      const foreground = calls.find(call => call.type === 'prepareImages');
      assert.ok(foreground, event); assert.notEqual(foreground.owner, owner, event);
      assert.equal(setup.writes.length, 1); assert.equal(setup.likes.length, 1);
    } finally { setup.dom.window.close(); }
  }
});

test('automatic reads cover only the first two visible posts and release when a new visible post replaces one', async () => {
  const calls = [];
  const setup = fixture(photoPost(1) + photoPost(2) + photoPost(3), { media: true, observer: true, message: request => { calls.push(request); return request.urls ? imageResult(request) : true; } });
  try {
    const articles = [...setup.document.querySelectorAll('article')];
    articles.forEach(article => setup.intersect(article)); await tick(580);
    assert.equal(calls.filter(call => call.type === 'prefetchImages').length, 2);
    setup.intersect(articles[0], false); await tick(30);
    assert.equal(calls.filter(call => call.type === 'prefetchImages').length, 3);
    assert.ok(calls.some(call => call.type === 'releaseImages' && call.keepUrls && !call.keepUrls.some(url => url.includes('/media/P1?'))));
  } finally { setup.dom.window.close(); }
});

test('offscreen cancellation releases an in-flight automatic read and a late result is not reused', async () => {
  const calls = []; let finish;
  const setup = fixture(photoPost(1), { media: true, observer: true, message: request => {
    calls.push(request);
    if (request.type === 'prefetchImages') return new Promise(resolve => { finish = () => resolve(imageResult(request)); });
    return request.urls ? imageResult(request) : true;
  } });
  try {
    const article = setup.document.querySelector('article'); setup.intersect(article); await tick(550);
    setup.intersect(article, false); await tick(0);
    assert.ok(calls.some(call => call.type === 'releaseImages' && call.keepUrls?.length === 0));
    finish(); await tick(10);
    article.querySelector('.x-copy-post-button').click(); await tick(20);
    assert.equal(calls.filter(call => call.type === 'prepareImages').length, 1);
    assert.equal(setup.writes.length, 1);
  } finally { setup.dom.window.close(); }
});

test('partial speculative originals combine with missing foreground originals in source order', async () => {
  const calls = []; let inspected;
  const setup = fixture(photoPost(1, '<img src="https://pbs.twimg.com/media/SECOND.jpg">'), { media: true, inspectImages: async images => { inspected = images; return images; }, message: request => {
    calls.push(request);
    if (request.type === 'prefetchImages') return imageResult(request).slice(0, 1);
    return request.urls ? imageResult(request) : true;
  } });
  try {
    const button = setup.document.querySelector('.x-copy-post-button'); button.dispatchEvent(new setup.dom.window.Event('pointerenter')); await tick(20);
    button.click(); await tick(20);
    const foreground = calls.find(call => call.type === 'prepareImages');
    assert.equal(foreground.urls.length, 1); assert.match(foreground.urls[0], /SECOND/);
    assert.equal(inspected.length, 2); assert.match(inspected[0].url, /P1/); assert.match(inspected[1].url, /SECOND/);
  } finally { setup.dom.window.close(); }
});

test('visible photos dwell before sequential prefetch and decode only on explicit copy', async () => {
  const calls = []; let decoded = 0;
  const setup = fixture(photoPost(1), { media: true, observer: true, inspectImages: async images => { decoded++; return images; }, message: request => { calls.push(request); return request.urls ? imageResult(request) : true; } });
  try {
    setup.intersect(setup.document.querySelector('article'));
    await tick(250); assert.equal(calls.length, 0);
    await tick(320);
    assert.equal(calls[0]?.type, 'prefetchImages');
    assert.match(calls[0].owner, /^[a-zA-Z0-9_-]{1,100}$/);
    assert.equal(decoded, 0); assert.equal(setup.writes.length, 0); assert.equal(setup.likes.length, 0);
    setup.document.querySelector('.x-copy-post-button').click(); await tick(20);
    assert.equal(calls.filter(call => call.type === 'prepareImages').length, 0);
    assert.equal(decoded, 1); assert.equal(setup.writes.length, 1);
  } finally { setup.dom.window.close(); }
});

test('offscreen or hidden dwell and videos never initiate automatic image reads', async () => {
  const calls = [];
  const setup = fixture(photoPost(1) + `<article><video></video>${link(2)}${bar}</article>`, { media: true, observer: true, message: request => { calls.push(request); return []; } });
  try {
    const [photo, video] = setup.document.querySelectorAll('article');
    setup.intersect(photo); await tick(80); setup.intersect(photo, false);
    setup.intersect(video); await tick(550);
    assert.equal(calls.length, 0);
    setup.intersect(photo); setup.visibility(true); await tick(550);
    assert.equal(calls.filter(call => call.type === 'prefetchImages').length, 0);
  } finally { setup.dom.window.close(); }
});

test('pagehide drops ownership and pending image results cannot copy or like after pageshow', async () => {
  const calls = []; let finish;
  const setup = fixture(photoPost(1), { media: true, observer: true, message: request => { calls.push(request); return request.type === 'prepareImages' ? new Promise(resolve => { finish = () => resolve(imageResult(request)); }) : request.urls ? imageResult(request) : true; } });
  try {
    setup.document.querySelector('.x-copy-post-button').click(); await tick(0);
    const owner = calls[0].owner;
    setup.dom.window.dispatchEvent(new setup.dom.window.Event('pagehide'));
    setup.dom.window.dispatchEvent(new setup.dom.window.Event('pageshow'));
    finish(); await tick(20);
    assert.equal(setup.writes.length, 0); assert.equal(setup.likes.length, 0);
    assert.ok(calls.some(call => call.type === 'releaseImages' && call.owner === owner));
    assert.equal(setup.ports[0].disconnected, true);
    setup.intersect(setup.document.querySelector('article')); await tick(550);
    assert.notEqual(calls.find(call => call.type === 'prefetchImages')?.owner, owner);
  } finally { setup.dom.window.close(); }
});

test("all media types and text-only posts receive a compact button at the action bar end", async () => {
  const attachments = ['<img src="https://pbs.twimg.com/media/A">', '<video></video>', '<div data-testid="videoPlayer">GIF</div>', ''];
  const { dom, document, writes } = fixture(attachments.map((media, index) => `<article><div data-testid="tweetText">Post ${index} #art</div>${media}${link(index + 1)}${bar}</article>`).join(''));
  try {
    const articles = [...document.querySelectorAll('article')];
    assert.equal(document.querySelectorAll('.x-copy-post-button').length, 4);
    for (const [index, article] of articles.entries()) {
      const button = article.querySelector('.x-copy-post-button');
      assert.equal(button.parentElement, article.querySelector('.actions'));
      assert.equal(button.parentElement.lastElementChild, button);
      assert.ok(button.querySelector('svg'));
      assert.equal(button.textContent, '');
      button.click();
      await tick(0);
      assert.equal(writes[index].plain, `Post ${index}\nhttps://x.com/a/status/${index + 1}`);
      assert.equal(document.querySelector('.x-copy-preview'), null);
    }
  } finally { dom.window.close(); }
});

test("attachment-only posts copy the source link without demanding text or translation", async () => {
  const { dom, document, writes } = fixture(`<article><video></video>${link(9)}${bar}</article>`);
  try {
    document.querySelector('.x-copy-post-button').click();
    await tick(0);
    assert.equal(writes[0].plain, 'https://x.com/a/status/9');
  } finally { dom.window.close(); }
});

test("handles delayed action bars, ignores quote actions and maintains one final button", async () => {
  const { dom, document } = fixture(`<article><div data-testid="tweetText">Main</div><div data-testid="quoteTweet">${link(2)}${bar}</div>${link(1)}</article>`);
  try {
    assert.equal(document.querySelector('.x-copy-post-button'), null);
    const article = document.querySelector('article');
    article.insertAdjacentHTML('beforeend', bar);
    await tick(360);
    const mainBar = article.lastElementChild;
    const copy = mainBar.lastElementChild;
    assert.ok(copy.matches('.x-copy-post-button'));
    assert.equal(article.querySelector('[data-testid="quoteTweet"] .x-copy-post-button'), null);
    mainBar.insertAdjacentHTML('beforeend', '<button data-testid="bookmark">收藏</button>');
    await tick(700);
    assert.equal(mainBar.lastElementChild, copy);
    assert.equal(article.querySelectorAll('.x-copy-post-button').length, 1);
  } finally { dom.window.close(); }
});

test("expanded translations also have hashtags filtered and keep the requested separators", async () => {
  const { dom, document, writes } = fixture(`<article><div data-testid="tweetText">Original #art</div><div data-testid="tweetText">译文 #艺术</div>${link(1)}${bar}</article>`);
  try {
    document.querySelector('.x-copy-post-button').click();
    await tick(0);
    assert.equal(writes[0].plain, 'Original\n\n译文\nhttps://x.com/a/status/1');
  } finally { dom.window.close(); }
});


test("likes only after clipboard success and does not undo a like on repeated copy", async () => {
  let copied = false;
  const { dom, document, likes, writes } = fixture(`<article><div data-testid="tweetText">Main</div>${link(1)}${bar}</article>`, {
    beforeWrite: async () => { copied = true; },
    likeHandler: button => { assert.equal(copied, true); button.dataset.testid = 'unlike'; }
  });
  try {
    assert.equal(likes.length, 0);
    const copy = document.querySelector('.x-copy-post-button');
    copy.click(); await tick(0);
    assert.equal(likes.length, 1);
    assert.ok(document.querySelector('[data-testid="unlike"]'));
    assert.match(document.querySelector('.x-copy-toast').textContent, /并已点赞/);
    copy.click(); await tick(0);
    assert.equal(writes.length, 2);
    assert.equal(likes.length, 1);
    assert.ok(document.querySelector('[data-testid="unlike"]'));
  } finally { dom.window.close(); }
});

test("does not click an already liked post or its quoted post", async () => {
  const likedBar = bar.replace('data-testid="like"', 'data-testid="unlike"');
  const { dom, document, likes } = fixture(`<article><div data-testid="tweetText">Main</div><div data-testid="quoteTweet">${link(2)}${bar}</div>${link(1)}${likedBar}</article>`);
  try {
    document.querySelector('.x-copy-post-button').click(); await tick(0);
    assert.equal(likes.length, 0);
    assert.match(document.querySelector('.x-copy-toast').textContent, /该帖已点赞/);
  } finally { dom.window.close(); }
});

test("likes the copied parent post rather than a quoted or adjacent post", async () => {
  const { dom, document, likes } = fixture(`<article id="main"><div data-testid="tweetText">Main</div><div data-testid="quoteTweet">${link(2)}${bar}</div>${link(1)}${bar}</article><article id="other">${link(3)}${bar}</article>`);
  try {
    const main = document.getElementById('main');
    main.querySelector('.x-copy-post-button').click(); await tick(0);
    assert.equal(likes.length, 1);
    assert.equal(likes[0].closest('article'), main);
    assert.equal(likes[0].closest('[data-testid="quoteTweet"]'), null);
    assert.ok(document.querySelector('#other [data-testid="like"]'));
    assert.ok(main.querySelector('[data-testid="quoteTweet"] [data-testid="like"]'));
  } finally { dom.window.close(); }
});

test("clipboard failure does not trigger a like", async () => {
  const { dom, document, likes, writes } = fixture(`<article>${link(1)}${bar}</article>`, { beforeWrite: async () => { throw new Error('Clipboard denied'); } });
  try {
    document.querySelector('.x-copy-post-button').click(); await tick(0);
    assert.equal(likes.length, 0);
    assert.equal(writes.length, 0);
    assert.match(document.querySelector('.x-copy-toast-error').textContent, /Clipboard denied/);
  } finally { dom.window.close(); }
});

test('clipboard focus failure explains how to retry and does not like or download', async () => {
  let downloads = 0;
  const { dom, document, likes, writes } = fixture(`<article><video poster="https://pbs.twimg.com/tweet_video_thumb/ABC.jpg"></video>${link(1)}${bar}</article>`, {
    media: true, beforeWrite: async () => { throw new Error("Failed to execute 'write' on 'Clipboard': Document is not focused."); },
    message: () => { downloads++; return []; }
  });
  try {
    document.querySelector('.x-copy-post-button').click(); await tick(10);
    assert.equal(writes.length, 0); assert.equal(likes.length, 0); assert.equal(downloads, 0);
    assert.match(document.querySelector('.x-copy-toast-error').textContent, /回到 X.*空白处.*再点复制/);
    assert.doesNotMatch(document.querySelector('.x-copy-toast-error').textContent, /Document is not focused/);
  } finally { dom.window.close(); }
});

test("Shift click behaves like normal copy without an editing dialog", async () => {
  const { dom, document, likes, writes } = fixture(`<article id="main">${link(1)}${bar}</article><article id="other">${link(2)}${bar}</article>`);
  try {
    const copy = document.querySelector('#main .x-copy-post-button');
    copy.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, shiftKey: true })); await tick(0);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(writes.length, 1);
    assert.equal(likes.length, 1);
    assert.equal(likes[0].closest('article').id, 'main');
    assert.ok(document.querySelector('#other [data-testid="like"]'));
  } finally { dom.window.close(); }
});

test("does not like a different post when X reuses the article during clipboard writing", async () => {
  let document;
  const setup = fixture(`<article>${link(1)}${bar}</article>`, {
    beforeWrite: async () => { document.querySelector('a').href = 'https://x.com/a/status/2'; }
  });
  document = setup.document;
  try {
    document.querySelector('.x-copy-post-button').click(); await tick(0);
    assert.equal(setup.likes.length, 0);
    assert.equal(setup.writes.length, 1);
    assert.match(document.querySelector('.x-copy-toast').textContent, /未找到可用的点赞按钮/);
  } finally { setup.dom.window.close(); }
});

test("disabled like controls do not prevent text copying", async () => {
  const { dom, document, likes, writes } = fixture(`<article>${link(1)}${bar.replace('data-testid="like"', 'data-testid="like" aria-disabled="true"')}</article>`);
  try {
    document.querySelector('.x-copy-post-button').click(); await tick(0);
    assert.equal(writes.length, 1);
    assert.equal(likes.length, 0);
    assert.match(document.querySelector('.x-copy-toast').textContent, /已复制.*未找到/);
  } finally { dom.window.close(); }
});

test("waits for delayed liked state without sending duplicate likes", async () => {
  const { dom, document, likes } = fixture(`<article>${link(1)}${bar}</article>`, {
    likeHandler: button => { setTimeout(() => { button.dataset.testid = 'unlike'; }, 60); }
  });
  try {
    const copy = document.querySelector('.x-copy-post-button');
    copy.click(); await tick(0);
    assert.equal(copy.disabled, true);
    copy.click();
    await tick(140);
    assert.equal(likes.length, 1);
    assert.equal(copy.disabled, false);
    assert.match(document.querySelector('.x-copy-toast').textContent, /并已点赞/);
  } finally { dom.window.close(); }
});

test("unconfirmed like reports the copied text accurately and makes no automatic retry", async () => {
  const { dom, document, likes, writes } = fixture(`<article>${link(1)}${bar}</article>`, { likeHandler: () => {} });
  try {
    document.querySelector('.x-copy-post-button').click();
    await tick(2150);
    assert.equal(writes.length, 1);
    assert.equal(likes.length, 1);
    assert.match(document.querySelector('.x-copy-toast').textContent, /已复制.*未能确认点赞/);
  } finally { dom.window.close(); }
});

test('Alt copies original with images and clean source without translation or preview', async () => {
  const calls = [];
  const { dom, document, likes, writes } = fixture(`<article><div data-testid="tweetText">Source</div><div data-testid="tweetText">中文译文</div><img src="https://pbs.twimg.com/media/PHOTO?format=png&name=small">${link(1)}${bar}</article>`, {
    media: true, message: request => { calls.push(request); return request.type === 'prepareImages' ? [{ dataUrl: 'data:image/png;base64,AAAA', width: 2000, height: 1000 }] : []; }
  });
  try {
    document.querySelector('.x-copy-post-button').dispatchEvent(new dom.window.MouseEvent('click', { altKey: true }));
    await tick(20);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(calls[0].type, 'prepareImages');
    assert.match(calls[0].urls[0], /name=orig/);
    assert.match(writes[0].html, /<img/);
    assert.equal(writes[0].plain, 'Source\nhttps://x.com/a/status/1');
    assert.doesNotMatch(writes[0].html, /中文译文/);
    assert.equal(likes.length, 1);
  } finally { dom.window.close(); }
});

test('video download starts only after clipboard success and uses source post id', async () => {
  let copied = false;
  const calls = [];
  const { dom, document, likes } = fixture(`<article><video poster="https://pbs.twimg.com/tweet_video_thumb/ABC.jpg"></video>${link(1)}${bar}</article>`, {
    media: true, beforeWrite: async () => { copied = true; }, message: request => { assert.equal(copied, true); calls.push(request); return []; }
  });
  try {
    document.querySelector('.x-copy-post-button').click(); await tick(20);
    assert.equal(calls[0].type, 'downloadMedia');
    assert.equal(calls[0].postId, '1');
    assert.equal(calls[0].media[0].type, 'animated_gif');
    assert.equal(likes.length, 1);
  } finally { dom.window.close(); }
});

test('hiding after clipboard success preserves explicit GIF downloads while like confirmation is pending', async () => {
  const calls = [];
  const setup = fixture(`<article><img src="https://pbs.twimg.com/media/STILL.jpg"><video poster="https://pbs.twimg.com/tweet_video_thumb/ABC.jpg"></video>${link(1)}${bar}</article>`, {
    media: true, likeHandler: () => {}, message: request => { calls.push(request); return request.urls ? imageResult(request) : request.type === 'releaseImages' ? true : []; }
  });
  try {
    setup.document.querySelector('.x-copy-post-button').click(); await tick(20);
    assert.equal(setup.writes.length, 1); assert.equal(setup.likes.length, 1);
    assert.match(setup.document.querySelector('.x-copy-toast').textContent, /已复制.*可粘贴/);
    setup.visibility(true); await tick(130);
    const downloads = calls.filter(call => call.type === 'downloadMedia');
    assert.equal(downloads.length, 1); assert.equal(downloads[0].postId, '1');
    assert.equal(downloads[0].media[0].type, 'animated_gif');
    assert.equal(setup.likes.length, 1);
    assert.ok(calls.some(call => call.type === 'releaseImages' && !('keepUrls' in call)));
    assert.equal(setup.ports[0].disconnected, true);
  } finally { setup.dom.window.close(); }
});

test('original image failure reports an error without a dialog, partial copy or like', async () => {
  const { dom, document, likes, writes } = fixture(`<article><img src="https://pbs.twimg.com/media/PHOTO.jpg">${link(1)}${bar}</article>`, {
    media: true, message: async () => { throw new Error('原图请求失败'); }
  });
  try {
    document.querySelector('.x-copy-post-button').click(); await tick(20);
    assert.equal(writes.length, 0); assert.equal(likes.length, 0);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.match(document.querySelector('.x-copy-toast-error').textContent, /原图请求失败/);
  } finally { dom.window.close(); }
});

test('hover preloads original photos once without copying or liking and click reuses them', async () => {
  const calls = [];
  const { dom, document, writes, likes } = fixture(`<article><img src="https://pbs.twimg.com/media/WARM?format=png&name=small">${link(1)}${bar}</article>`, {
    media: true, message: request => { if (request.type !== 'releaseImages') calls.push(request); return [{ dataUrl:'data:image/png;base64,AAAA', width:2048, height:1024 }]; }
  });
  try {
    const button = document.querySelector('.x-copy-post-button');
    button.dispatchEvent(new dom.window.Event('pointerenter')); await tick(20);
    assert.equal(calls.length, 1); assert.equal(writes.length, 0); assert.equal(likes.length, 0);
    button.click(); await tick(20);
    assert.equal(calls.length, 1); assert.equal(writes.length, 1); assert.equal(likes.length, 1);
  } finally { dom.window.close(); }
});

test('clipboard success is reported immediately while liked-state confirmation is pending', async () => {
  const { dom, document, writes } = fixture(`<article>${link(1)}${bar}</article>`, { likeHandler: () => {} });
  try {
    document.querySelector('.x-copy-post-button').click(); await tick(10);
    assert.equal(writes.length, 1);
    assert.match(document.querySelector('.x-copy-toast')?.textContent || '', /已复制.*可粘贴/);
  } finally { dom.window.close(); }
});

test('invalidated context offers refresh even for text-only posts without background requests', async () => {
  let invalidated = false;
  const { dom, document, writes, likes } = fixture(`<article>${link(1)}${bar}</article>`, { invalidated: () => invalidated });
  try {
    invalidated = true;
    document.querySelector('.x-copy-post-button').click(); await tick(10);
    assert.equal(writes.length, 0); assert.equal(likes.length, 0);
    assert.match(document.querySelector('.x-copy-toast').textContent, /刷新/);
    assert.equal(document.querySelector('.x-copy-toast button')?.textContent, '刷新此页');
    assert.doesNotMatch(document.querySelector('.x-copy-toast').textContent, /Extension context invalidated/);
    document.querySelector('article').insertAdjacentHTML('beforeend', '<div>new content</div>');
    await tick(350);
    assert.equal(document.querySelectorAll('.x-copy-post-button').length, 1);
  } finally { dom.window.close(); }
});

test('cached original images cannot bypass the context check after extension reload', async () => {
  let invalidated = false, requests = 0;
  const { dom, document, writes, likes } = fixture(`<article><img src="https://pbs.twimg.com/media/CACHE.jpg">${link(1)}${bar}</article>`, {
    media: true, invalidated: () => invalidated, message: request => { if (request.type !== 'releaseImages') requests++; return [{ dataUrl: 'data:image/png;base64,AAAA' }]; }
  });
  try {
    const button = document.querySelector('.x-copy-post-button');
    button.dispatchEvent(new dom.window.Event('pointerenter')); await tick(10);
    invalidated = true;
    button.click(); await tick(10);
    assert.equal(requests, 1); assert.equal(writes.length, 0); assert.equal(likes.length, 0);
    assert.equal(document.querySelector('.x-copy-toast button')?.textContent, '刷新此页');
  } finally { dom.window.close(); }
});

test('invalidation during clipboard writing prevents a subsequent like or download', async () => {
  let invalidated = false, downloads = 0;
  const { dom, document, writes, likes } = fixture(`<article><video poster="https://pbs.twimg.com/tweet_video_thumb/ABC.jpg"></video>${link(1)}${bar}</article>`, {
    media: true, invalidated: () => invalidated, beforeWrite: async () => { invalidated = true; }, message: () => { downloads++; return []; }
  });
  try {
    document.querySelector('.x-copy-post-button').click(); await tick(10);
    assert.equal(writes.length, 1); assert.equal(likes.length, 0); assert.equal(downloads, 0);
    assert.equal(document.querySelector('.x-copy-toast button')?.textContent, '刷新此页');
  } finally { dom.window.close(); }
});

test('invalidation during original fetch does not open a dialog or trigger like', async () => {
  const { dom, document, writes, likes } = fixture(`<article><img src="https://pbs.twimg.com/media/PHOTO.jpg">${link(1)}${bar}</article>`, {
    media: true, message: async () => { throw new Error('Extension context invalidated.'); }
  });
  try {
    document.querySelector('.x-copy-post-button').click(); await tick(20);
    assert.equal(writes.length, 0); assert.equal(likes.length, 0);
    assert.equal(document.querySelector('[role="dialog"]'), null);
    assert.equal(document.querySelector('.x-copy-toast button')?.textContent, '刷新此页');
  } finally { dom.window.close(); }
});

test('Alt bypasses translation generation including when Shift is held', async () => {
  const { dom, document, writes } = fixture(`<article><div data-testid="tweetText">Original</div><button id="translate">显示翻译</button>${link(1)}${bar}</article>`);
  let translations = 0;
  document.querySelector('#translate').onclick = () => translations++;
  try {
    document.querySelector('.x-copy-post-button').dispatchEvent(new dom.window.MouseEvent('click', { altKey: true, shiftKey: true })); await tick(10);
    assert.equal(translations, 0);
    assert.equal(writes[0].plain, 'Original\nhttps://x.com/a/status/1');
    assert.equal(document.querySelector('[role="dialog"]'), null);
  } finally { dom.window.close(); }
});



