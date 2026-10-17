(function () {
  "use strict";
  const extractor = globalThis.XCopyExtractor;
  const clipboard = globalThis.XCopyClipboard;
  const mediaTools = globalThis.XCopyMedia;
  const originals = new Map();
  const preparedImages = new Map();
  const pendingCopies = new Set();
  const candidates = new Map();
  const CACHE_BYTES = 8 * 1024 * 1024;
  const CACHE_TTL = 120000;
  const newOwner = () => globalThis.crypto?.randomUUID?.() || `page_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  let imageOwner = newOwner(), imageEpoch = 0, imagePort = null;
  let pageActive = !document.hidden, pagePath = location.pathname + location.search;
  let visibilityObserver, idleTask, activeAuto;
  let copying = false;
  let invalidated = false;
  const contextError = error => invalidated || /extension context (?:was )?invalidated/i.test(error?.message || '');
  function assertContext() {
    try {
      if (invalidated || !globalThis.chrome?.runtime?.id) throw new Error();
      // This also fails synchronously in an orphaned content script, even if
      // cached images mean the operation would otherwise send no messages.
      chrome.runtime.getManifest();
    } catch {
      invalidated = true;
      throw new Error('Extension context invalidated.');
    }
  }
  function showError(error) {
    if (error.stalePage) return;
    if (!contextError(error) && /document is not focused/i.test(error?.message || '')) {
      toast('复制未完成：请回到 X，点击页面空白处后再点复制；看到“已复制，可粘贴”后再切换窗口。', true);
      return;
    }
    if (!contextError(error)) { toast(error.message || '复制失败', true); return; }
    invalidated = true;
    observer.disconnect();
    clearTimeout(scanTimer);
    resetImageState(false);
    const node = toast('扩展已重载或停用，此页的旧连接已失效。请确认扩展已启用，然后刷新 X 页面继续。', true, true);
    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.textContent = '刷新此页';
    refresh.addEventListener('click', () => location.reload());
    node.append(refresh);
  }
  async function send(message) {
    assertContext();
    try {
      const response = await chrome.runtime.sendMessage(message);
      if (!response?.ok) throw new Error(response?.error || '扩展后台没有响应，请重新加载扩展和 X 页面');
      return response.data;
    } catch (error) {
      if (contextError(error)) invalidated = true;
      throw error;
    }
  }
  function getMedia(article, postUrl) {
    if (!mediaTools) return [];
    const id = postUrl.match(/\/status\/(\d+)/)?.[1];
    return mediaTools.selectMedia(globalThis.XCopyMediaIndex?.get(id), mediaTools.collectDom(article, extractor.owns));
  }
  function assertPage(epoch) {
    checkNavigation();
    if (epoch !== imageEpoch || !pageActive) {
      const error = new Error('帖子页面已改变，请重新复制'); error.stalePage = true; throw error;
    }
    assertContext();
  }
  function connectImages() {
    if (imagePort || !chrome.runtime.connect) return;
    const port = chrome.runtime.connect({ name: 'xCopyImages:' + imageOwner });
    imagePort = port;
    port.onDisconnect.addListener(() => { if (imagePort === port) imagePort = null; });
  }
  function releaseInterest(owner = imageOwner, keepUrls) {
    // Cleanup is best effort, including when an extension has just reloaded.
    try { Promise.resolve(chrome.runtime.sendMessage({ type: 'releaseImages', owner, ...(keepUrls ? { keepUrls } : {}) })).catch(() => {}); } catch {}
  }
  function syncInterest() {
    releaseInterest(imageOwner, [...new Set([...preparedImages.values()].flatMap(entry => entry.urls))]);
  }
  function dropEntry(key) {
    const entry = preparedImages.get(key);
    if (!entry) return;
    clearTimeout(entry.timer); preparedImages.delete(key);
  }
  function cacheEntry(key, urls) {
    let entry = preparedImages.get(key);
    if (entry && entry.urls.join('\n') !== urls.join('\n')) { dropEntry(key); entry = null; }
    if (!entry) {
      entry = { urls, images: new Map(), created: Date.now() };
      const epoch = imageEpoch;
      entry.timer = setTimeout(() => {
        if (epoch !== imageEpoch || preparedImages.get(key) !== entry) return;
        dropEntry(key); syncInterest();
      }, CACHE_TTL);
    }
    preparedImages.delete(key); preparedImages.set(key, entry);
    let changed = false;
    while (preparedImages.size > 2) { dropEntry(preparedImages.keys().next().value); changed = true; }
    if (changed) syncInterest();
    return entry;
  }
  function retainImages(key, entry, images, urls) {
    if (preparedImages.get(key) !== entry) return;
    for (const [index, image] of images.entries()) {
      const url = image.url || (images.length === urls.length ? urls[index] : null);
      if (url && urls.includes(url) && typeof image.dataUrl === 'string') entry.images.set(url, image);
    }
    const cost = () => [...preparedImages.values()].reduce((total, value) => total + [...value.images.values()].reduce((sum, image) => sum + image.dataUrl.length * 2, 0), 0);
    for (const value of preparedImages.values()) {
      if (cost() <= CACHE_BYTES) break;
      // Retain only recent URL metadata here. The worker has its own byte bound
      // and can still serve originals without another network request.
      value.images.clear();
    }
    syncInterest();
  }
  async function prepareImages(items, key, epoch = imageEpoch) {
    if (!items.length) return [];
    assertPage(epoch);
    const urls = items.map(item => item.url);
    const entry = cacheEntry(key || urls.join('\n'), urls);
    assertPage(epoch);
    const cachedImages = new Map(entry.images);
    const missing = urls.filter(url => !cachedImages.has(url));
    let fetched = [];
    if (missing.length) {
      entry.foreground = (entry.foreground || 0) + 1;
      try {
        connectImages();
        fetched = await send({ type: 'prepareImages', urls: missing, owner: imageOwner });
        assertPage(epoch);
        if (!Array.isArray(fetched) || fetched.length !== missing.length) throw new Error('原图没有全部读取成功');
        retainImages(key || urls.join('\n'), entry, fetched, missing);
      } catch (error) { error.imageFailure = true; throw error; }
      finally { entry.foreground--; }
    }
    const fetchedByUrl = new Map(fetched.map((image, index) => [missing[index], image]));
    return urls.map(url => fetchedByUrl.get(url) || cachedImages.get(url));
  }
  function startImageRead(items, postUrl, epoch) {
    const slot = { images: null, closed: false };
    pendingCopies.add(slot);
    // The promise carries no encoded result: lifecycle cleanup can clear its
    // slot even while translation text is still loading.
    slot.promise = prepareImages(items, postUrl, epoch).then(images => {
      assertPage(epoch);
      if (!slot.closed) slot.images = images;
    });
    slot.promise.catch(() => {});
    return slot;
  }
  function discardImageRead(slot) {
    if (!slot) return;
    slot.closed = true; slot.images = null; pendingCopies.delete(slot);
  }
  function cancelIdle() {
    if (!idleTask) return;
    if (idleTask.idle) globalThis.cancelIdleCallback?.(idleTask.id);
    else clearTimeout(idleTask.id);
    idleTask = null;
  }
  function schedulePrefetch() {
    if (idleTask || activeAuto || !pageActive || invalidated) return;
    const run = () => { idleTask = null; void runPrefetch(); };
    idleTask = globalThis.requestIdleCallback ? { idle: true, id: requestIdleCallback(run, { timeout: 1000 }) } : { id: setTimeout(run, 0) };
  }
  async function runPrefetch() {
    if (activeAuto || !pageActive || copying || invalidated) return;
    const visible = [...candidates.values()].filter(value => value.visible).slice(0, 2);
    const candidate = [...candidates.values()].find(value => value.ready && !value.attempted && (value.interested || visible.includes(value)));
    if (!candidate) return;
    candidate.ready = false; candidate.attempted = true;
    const { article, postUrl, urls } = candidate;
    if (!article.isConnected || extractor.postUrl(article) !== postUrl) return;
    const epoch = imageEpoch, owner = imageOwner, token = { candidate };
    activeAuto = token;
    const entry = cacheEntry(postUrl, urls);
    const promise = (async () => {
      try {
        connectImages();
        const images = await send({ type: 'prefetchImages', urls, owner });
        assertPage(epoch);
        if (extractor.postUrl(article) !== postUrl || !article.isConnected) { dropEntry(postUrl); syncInterest(); return; }
        if (Array.isArray(images)) retainImages(postUrl, entry, images, urls);
      } catch (error) {
        if (epoch === imageEpoch && !entry.foreground) { dropEntry(postUrl); syncInterest(); }
        if (contextError(error)) showError(error);
      }
    })();
    entry.promise = promise;
    await promise;
    entry.promise = null;
    if (epoch === imageEpoch) syncInterest();
    if (activeAuto === token) { activeAuto = null; schedulePrefetch(); }
  }
  function warmImages(article) {
    if (!pageActive || invalidated || copying) return;
    const candidate = candidates.get(article);
    if (!candidate || candidate.attempted) return;
    candidate.interested = true; candidate.ready = true; schedulePrefetch();
  }
  function observeArticles() {
    if (!pageActive || invalidated) return;
    if (!visibilityObserver && globalThis.IntersectionObserver) visibilityObserver = new IntersectionObserver(entries => {
      for (const item of entries) {
        const candidate = candidates.get(item.target);
        if (!candidate) continue;
        clearTimeout(candidate.dwell);
        candidate.visible = item.isIntersecting;
        candidate.ready = false;
        if (!candidate.visible && activeAuto?.candidate === candidate && !candidate.interested && !preparedImages.get(candidate.postUrl)?.foreground) {
          dropEntry(candidate.postUrl); syncInterest();
        }
        if (candidate.visible && !candidate.attempted) candidate.dwell = setTimeout(() => {
          candidate.ready = candidate.visible && candidate.article.isConnected;
          schedulePrefetch();
        }, 500);
      }
      schedulePrefetch();
    });
    for (const [article, candidate] of candidates) {
      if (!article.isConnected || extractor.postUrl(article) !== candidate.postUrl) {
        clearTimeout(candidate.dwell); visibilityObserver?.unobserve(article); candidates.delete(article);
        if (preparedImages.has(candidate.postUrl)) { dropEntry(candidate.postUrl); syncInterest(); }
      }
    }
    for (const article of document.querySelectorAll('article')) {
      const postUrl = extractor.postUrl(article);
      if (!postUrl || candidates.has(article)) continue;
      const urls = getMedia(article, postUrl).filter(item => item.type === 'photo').map(item => item.url);
      if (!urls.length) continue;
      candidates.set(article, { article, postUrl, urls, visible: false, ready: false, attempted: false });
      visibilityObserver?.observe(article);
    }
  }
  function resetImageState(resume) {
    imageEpoch++;
    for (const slot of pendingCopies) discardImageRead(slot);
    for (const key of preparedImages.keys()) dropEntry(key);
    for (const value of candidates.values()) clearTimeout(value.dwell);
    candidates.clear(); visibilityObserver?.disconnect(); visibilityObserver = null;
    cancelIdle(); activeAuto = null;
    const owner = imageOwner, port = imagePort;
    imagePort = null; imageOwner = newOwner();
    if (port) { releaseInterest(owner); try { port.disconnect(); } catch {} }
    pageActive = resume && !document.hidden && !invalidated;
    if (pageActive) observeArticles();
  }
  function checkNavigation() {
    const path = location.pathname + location.search;
    if (path !== pagePath) { pagePath = path; resetImageState(true); }
  }
  chrome?.runtime?.onMessage?.addListener(message => {
    if (invalidated || message.type !== 'xCopyJobUpdate') return;
    const job = message.job;
    if (job.status === 'complete') toast(`${job.extension === 'gif' ? 'GIF' : '视频'}已下载，可拖入聊天窗口`);
    else if (job.status === 'failed') toast(`${job.error}；点击扩展图标可查看任务或下载 MP4 备用文件`, true);
  });

  function toast(message, isError = false, persistent = false) {
    document.querySelector(".x-copy-toast")?.remove();
    const node = document.createElement("div");
    node.dataset.xCopyUi = "true";
    node.className = `x-copy-toast${isError ? " x-copy-toast-error" : ""}`;
    node.setAttribute("role", "status");
    node.textContent = message;
    document.documentElement.append(node);
    if (!persistent) setTimeout(() => node.remove(), 6000);
    return node;
  }
  async function runCopy(operation) {
    if (copying) throw new Error("正在复制另一条帖子，请稍候");
    copying = true;
    try { return await operation(); }
    finally { copying = false; schedulePrefetch(); }
  }
  function findPost(postUrl) {
    if (!postUrl) return null;
    return [...document.querySelectorAll("article")].find(article => extractor.postUrl(article) === postUrl) || null;
  }
  function likeControl(article, state) {
    if (!article) return null;
    return [...article.querySelectorAll(`button[data-testid="${state}"], [role="button"][data-testid="${state}"]`)]
      .find(node => extractor.owns(article, node) && !node.hidden && node.getAttribute("aria-hidden") !== "true") || null;
  }
  function isLiked(article) {
    return Boolean(likeControl(article, "unlike") || likeControl(article, "like")?.getAttribute("aria-pressed") === "true");
  }
  async function autoLike(postUrl, epoch) {
    assertPage(epoch);
    // Resolve the source again after copying: X can replace or reuse articles.
    const article = findPost(postUrl);
    if (isLiked(article)) return "already-liked";
    const like = likeControl(article, "like");
    if (!like || like.disabled || like.getAttribute("aria-disabled") === "true") return "unavailable";
    like.click();
    // Confirm X's liked state, without retries that could toggle the action.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      assertPage(epoch);
      if (isLiked(findPost(postUrl))) return "liked";
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return "unconfirmed";
  }
  async function copyAndLike(data, sourcePostUrl = data.postUrl, epoch = imageEpoch) {
    let images;
    if (data.imageRead) { await data.imageRead.promise; images = data.imageRead.images; discardImageRead(data.imageRead); }
    else images = await prepareImages((data.media || []).filter(item => item.type === 'photo'), sourcePostUrl, epoch);
    assertPage(epoch);
    if (!findPost(sourcePostUrl)) { const error = new Error('帖子已离开页面，请在原帖上重试'); error.stalePage = true; throw error; }
    if (clipboard.inspectImages) images = await clipboard.inspectImages(images);
    assertPage(epoch);
    const imageCount = images.length;
    await clipboard.writeText({ ...data, images });
    // The system clipboard owns its data now; do not pin a large temporary
    // copy while waiting for like confirmation or optional media resolution.
    images = null;
    assertPage(epoch);
    toast('已复制，可粘贴；正在确认点赞状态');
    const videos = (data.media || []).filter(item => item.type !== 'photo');
    // Once copying succeeds, hand explicit media intent to the worker now.
    // Hiding the page may end like confirmation and clear photo caches later.
    const downloadPromise = videos.length ? (async () => {
      const media = videos.some(item => !item.url) ? await send({ type: 'resolveMedia', media: videos }) : videos;
      return send({ type: 'downloadMedia', postId: sourcePostUrl.match(/\/status\/(\d+)/)?.[1], media });
    })() : null;
    downloadPromise?.catch(() => {});
    const reportDownloads = async message => {
      if (!downloadPromise) return;
      try {
        const jobs = await downloadPromise;
        const failed = jobs.filter(job => job.status === 'failed');
        toast(`${message}；${failed.length ? failed.map(job => job.error).join('；') : `已提交 ${jobs.length} 个媒体下载任务，可在扩展图标中查看或取消`}`, failed.length > 0);
      } catch (error) {
        if (contextError(error)) { showError(error); return; }
        toast(`${message}；媒体下载未启动：${error.message}`, true);
      }
    };
    let status;
    try { status = await autoLike(sourcePostUrl, epoch); }
    catch (error) {
      if (error.stalePage) { await reportDownloads('已复制，可粘贴'); throw error; }
      if (contextError(error)) throw error;
      status = "unconfirmed";
    }
    const message = {
      liked: "已复制贴文和出处链接，并已点赞",
      "already-liked": "已复制贴文和出处链接（该帖已点赞）",
      unavailable: "已复制贴文和出处链接；未找到可用的点赞按钮",
      unconfirmed: "已复制贴文和出处链接；未能确认点赞，请检查页面"
    }[status];
    toast(message + (imageCount ? `（含 ${imageCount} 张原图）` : ''), status === "unavailable" || status === "unconfirmed");
    await reportDownloads(message);
  }
  async function handleCopy(article, button, originalOnly = false) {
    if (copying || button.disabled) { toast("正在复制，请稍候"); return; }
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    button.setAttribute("aria-label", "正在读取并复制贴文");
    let imageRead;
    try {
      await runCopy(async () => {
        assertContext();
        checkNavigation();
        const epoch = imageEpoch;
        assertPage(epoch);
        const postUrl = extractor.postUrl(article);
        if (!postUrl) throw new Error('未读取到帖子链接，请在原帖上重试');
        const getArticle = () => findPost(postUrl) || article;
        const originalPhotos = getMedia(article, postUrl).filter(item => item.type === 'photo');
        imageRead = startImageRead(originalPhotos, postUrl, epoch);
        const texts = await extractor.captureTexts(article, { cachedOriginal: originals.get(postUrl), getArticle, includeTranslation: !originalOnly });
        assertPage(epoch);
        if (texts.original && postUrl) originals.set(postUrl, texts.original);
        // Never use a recycled article's media for the previous post.
        if (extractor.postUrl(getArticle()) !== postUrl) throw new Error('帖子已离开页面，请在原帖上重试');
        const currentMedia = getMedia(getArticle(), postUrl);
        const samePhotos = currentMedia.filter(item => item.type === 'photo').map(item => item.url).join('\n') === originalPhotos.map(item => item.url).join('\n');
        if (!samePhotos) discardImageRead(imageRead);
        const data = { ...texts, postUrl, media: currentMedia, imageRead: samePhotos ? imageRead : null };
        await copyAndLike(data, postUrl, epoch);
      });
    } catch (error) {
      showError(error);
    }
    finally { discardImageRead(imageRead); button.disabled = false; button.removeAttribute("aria-busy"); button.setAttribute("aria-label", "复制贴文和出处链接，并自动点赞"); }
  }
  function addButtons() {
    if (invalidated) return;
    checkNavigation();
    observeArticles();
    for (const article of document.querySelectorAll("article")) {
      const postUrl = extractor.postUrl(article);
      const state = extractor.readState(article);
      if (postUrl && state.primary[0] && !extractor.control(article, "original") && !originals.has(postUrl)) {
        originals.set(postUrl, state.primary[0]);
        if (originals.size > 150) originals.delete(originals.keys().next().value);
      }
      if (!postUrl) continue;
      const groups = [...article.querySelectorAll('[role="group"]')].filter(node => extractor.owns(article, node));
      const group = groups.find(node => [...node.querySelectorAll('[data-testid="reply"], [data-testid="retweet"], [data-testid="unretweet"], [data-testid="like"], [data-testid="unlike"]')]
        .some(action => extractor.owns(article, action)));
      if (!group) continue; // Wait for X to render its actual post action bar.
      const existing = [...article.querySelectorAll(".x-copy-post-button")].find(node => node.closest("article") === article);
      if (existing) {
        if (existing.parentElement !== group || group.lastElementChild !== existing) group.append(existing);
        continue;
      }
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.xCopyUi = "true";
      button.className = "x-copy-post-button";
      button.setAttribute("aria-label", "复制贴文和出处链接，并自动点赞");
      button.title = "复制图文并点赞，下载视频/GIF；Alt + 点击不复制译文";
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("aria-hidden", "true");
      const path = document.createElementNS(svg.namespaceURI, "path");
      path.setAttribute("d", "M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm4 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h12v14z");
      svg.append(path);
      button.append(svg);
      button.addEventListener('pointerenter', () => warmImages(article));
      button.addEventListener('focus', () => warmImages(article));
      button.addEventListener("click", event => {
        event.preventDefault(); event.stopPropagation(); handleCopy(article, button, event.altKey);
      });
      group.append(button);
    }
  }
  let scheduled = false;
  let scanTimer;
  const observer = new MutationObserver(mutations => {
    if (scheduled || mutations.every(change => (change.target.nodeType === 1 ? change.target : change.target.parentElement)?.closest('[data-x-copy-ui]'))) return;
    scheduled = true;
    scanTimer = setTimeout(() => { scheduled = false; addButtons(); }, 300);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  document.addEventListener('visibilitychange', () => resetImageState(!document.hidden));
  addEventListener('pagehide', () => resetImageState(false));
  addEventListener('pageshow', () => { if (!pageActive) resetImageState(true); });
  addEventListener('popstate', checkNavigation);
  // X changes routes without a reload; mutation scans also cover isolated-world
  // history calls that do not pass through these wrappers.
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    history[method] = function (...args) { const result = original.apply(this, args); checkNavigation(); return result; };
  }
  addButtons();
})();
