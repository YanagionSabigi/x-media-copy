/* Profile media tab: select posts in the grid and copy the author block plus
   the selected originals in one clipboard record for QQ pastes. */
(function () {
  "use strict";
  const core = globalThis.XCopyCore;
  const extractor = globalThis.XCopyExtractor;
  const clipboard = globalThis.XCopyClipboard;
  const mediaTools = globalThis.XCopyMedia;
  const MEDIA_TAB = /^\/([a-zA-Z0-9_]{1,15})\/media\/?$/i;
  const TILE_HREF = /\/status\/\d+(?:\/(?:photo|video)\/\d+)?/;
  const LIMIT = 20, MAX_BATCH = 16, TOTAL_BYTES = 80 * 1024 ** 2;
  const selected = new Map();
  const contextError = error => invalidated || /extension context (?:was )?invalidated/i.test(error?.message || "");
  let invalidated = false, mode = false, busy = false, toolbar, countNode, copyNode, toggleNode;
  let scanScheduled = false, scanTimer;

  function assertContext() {
    try {
      if (invalidated || !globalThis.chrome?.runtime?.id) throw new Error();
      chrome.runtime.getManifest();
    } catch {
      invalidated = true;
      throw new Error("Extension context invalidated.");
    }
  }

  async function send(message) {
    assertContext();
    const response = await chrome.runtime.sendMessage(message);
    if (!response?.ok) throw new Error(response?.error || "扩展后台没有响应，请重新加载扩展和 X 页面");
    return response.data;
  }

  function toast(message, isError = false) {
    document.querySelector(".x-copy-toast")?.remove();
    const node = document.createElement("div");
    node.dataset.xCopyUi = "true";
    node.className = `x-copy-toast${isError ? " x-copy-toast-error" : ""}`;
    node.setAttribute("role", "status");
    node.textContent = message;
    document.documentElement.append(node);
    setTimeout(() => node.remove(), 6000);
    return node;
  }

  function showError(error) {
    if (contextError(error)) {
      invalidated = true;
      teardown();
    }
    toast(error?.message || "复制失败", true);
  }

  function mediaHandle() {
    return location.pathname.match(MEDIA_TAB)?.[1] || "";
  }

  function isTile(link) {
    if (!TILE_HREF.test(link.getAttribute("href") || "")) return false;
    return Boolean(link.querySelector('img[src*="pbs.twimg.com/media/"]'));
  }

  function mediaTiles() {
    return [...document.querySelectorAll('a[href*="/status/"]')].filter(isTile);
  }

  function postIdOf(link) {
    return (link.getAttribute("href") || "").match(/\/status\/(\d+)/)?.[1] || "";
  }

  function originalImageUrl(raw) {
    const value = String(raw || "");
    if (!value) return "";
    return mediaTools?.originalImageUrl?.(value) || value;
  }

  // One post owns all of its photos: prefer the captured GraphQL record, then
  // the other grid cells that link to the same post, then the clicked cell.
  function photosFor(postId, link) {
    const urls = [];
    const push = raw => { const url = originalImageUrl(raw); if (url && !urls.includes(url)) urls.push(url); };
    const record = globalThis.XCopyMediaIndex?.get(postId);
    if (Array.isArray(record)) for (const item of record) if (item?.type === "photo" && item.url) push(item.url);
    if (!urls.length) for (const tile of mediaTiles()) if (postIdOf(tile) === postId) push(tile.querySelector("img")?.getAttribute("src"));
    if (!urls.length && link) push(link.querySelector("img")?.getAttribute("src"));
    return urls;
  }

  function totalImages() {
    let total = 0;
    for (const entry of selected.values()) total += entry.urls.length;
    return total;
  }

  function toggleTile(link) {
    const postId = postIdOf(link);
    if (!postId) return;
    if (busy) { toast("正在复制，请稍候", true); return; }
    if (selected.has(postId)) {
      selected.delete(postId);
      paint();
      return;
    }
    const urls = photosFor(postId, link);
    if (!urls.length) {
      toast("这个帖子没有可复制的静态图片", true);
      return;
    }
    const total = totalImages();
    if (total + urls.length > LIMIT) {
      toast(`该帖有 ${urls.length} 张图，当前已选 ${total}/${LIMIT}，加入后会超过 20 张上限；请先取消一些帖子`, true);
      return;
    }
    selected.set(postId, { postId, urls });
    paint();
  }

  function ensureToolbar() {
    if (toolbar?.isConnected) return;
    toolbar = document.createElement("div");
    toolbar.dataset.xCopyUi = "true";
    toolbar.className = "x-copy-toolbar";
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", "主页媒体多选复制");
    countNode = document.createElement("span");
    countNode.className = "x-copy-toolbar-count";
    copyNode = document.createElement("button");
    copyNode.type = "button";
    copyNode.className = "x-copy-copy-selected";
    copyNode.textContent = "复制";
    copyNode.addEventListener("click", () => void copySelected());
    toggleNode = document.createElement("button");
    toggleNode.type = "button";
    toggleNode.className = "x-copy-select-toggle";
    toggleNode.textContent = "多选";
    toggleNode.addEventListener("click", () => {
      mode = !mode;
      if (!mode) selected.clear();
      paint();
    });
    toolbar.append(countNode, copyNode, toggleNode);
    document.documentElement.append(toolbar);
  }

  function overlayOf(tile) {
    return [...tile.children].find(node => node.classList?.contains("x-copy-tile-check")) || null;
  }

  function paint() {
    if (!mediaHandle() || invalidated) return;
    document.documentElement.classList.toggle("x-copy-selecting", mode);
    if (toggleNode) toggleNode.textContent = mode ? "退出多选" : "多选";
    if (countNode) {
      countNode.hidden = !mode;
      countNode.textContent = `已选 ${totalImages()} 张图 / ${selected.size} 帖（上限 ${LIMIT}）`;
    }
    if (copyNode) {
      copyNode.hidden = !mode;
      copyNode.disabled = !selected.size || busy;
      copyNode.textContent = busy ? "正在复制…" : "复制";
    }
    for (const tile of mediaTiles()) {
      const active = mode && selected.has(postIdOf(tile));
      tile.classList.toggle("x-copy-tile-selected", active);
      const overlay = overlayOf(tile);
      if (mode && !overlay) {
        const check = document.createElement("span");
        check.className = "x-copy-tile-check";
        check.dataset.xCopyUi = "true";
        check.setAttribute("aria-hidden", "true");
        tile.append(check);
      } else if (!mode && overlay) overlay.remove();
    }
  }

  function teardown() {
    mode = false;
    busy = false;
    selected.clear();
    document.documentElement.classList.remove("x-copy-selecting");
    toolbar?.remove();
    toolbar = countNode = copyNode = toggleNode = null;
  }

  function refresh() {
    if (invalidated) return;
    if (!mediaHandle() || !document.documentElement) {
      if (toolbar) teardown();
      return;
    }
    ensureToolbar();
    paint();
  }

  function profileScope() {
    const name = document.querySelector('[data-testid="UserName"]');
    const bio = document.querySelector('[data-testid="UserDescription"]');
    if (!name) return document.body;
    let candidate = name;
    for (let depth = 0; depth < 4 && candidate.parentElement; depth++) {
      candidate = candidate.parentElement;
      if (bio && candidate.contains(bio)) return candidate;
    }
    return bio?.parentElement || name.parentElement || document.body;
  }

  async function readGroup(urls, owner) {
    try {
      return await send({ type: "prepareImages", urls, owner });
    } catch (error) {
      // The worker caps a batch at 16 URLs and 24 MiB; halve it until it fits.
      if (urls.length === 1 || !/24 MiB|过大|图片列表无效/.test(error?.message || "")) throw error;
      const middle = Math.ceil(urls.length / 2);
      return [...await readGroup(urls.slice(0, middle), owner), ...await readGroup(urls.slice(middle), owner)];
    }
  }

  async function readImages(urls, owner) {
    const images = [];
    let bytes = 0, done = 0;
    for (let index = 0; index < urls.length; index += MAX_BATCH) {
      const group = urls.slice(index, index + MAX_BATCH);
      for (const image of await readGroup(group, owner)) {
        images.push(image);
        bytes += Number(image?.size) || 0;
      }
      done += group.length;
      if (bytes > TOTAL_BYTES) throw new Error(`所选原图合计超过 ${Math.round(TOTAL_BYTES / 1024 ** 2)} MiB 处理上限，请少选几张再复制`);
      if (done < urls.length) toast(`正在读取原图 ${done}/${urls.length}`);
    }
    if (images.length !== urls.length || images.some(image => !image)) throw new Error("原图没有全部读取成功，请重试");
    return images;
  }

  function releaseOwner(owner) {
    try { Promise.resolve(chrome.runtime.sendMessage({ type: "releaseImages", owner })).catch(() => {}); } catch { /* Extension may be gone. */ }
  }

  async function copySelected() {
    if (busy || !selected.size) return;
    const handle = mediaHandle();
    if (!handle) return;
    const owner = `profile_${globalThis.crypto?.randomUUID?.() || Date.now()}`;
    busy = true;
    paint();
    try {
      toast("正在读取作者介绍，请保持此页激活");
      const author = await extractor.captureProfile(profileScope(), {});
      const entries = [...selected.values()];
      const urls = entries.flatMap(entry => entry.urls);
      const images = await readImages(urls, owner);
      assertContext();
      await clipboard.writeProfile({
        name: author.name,
        handle: author.handle || `@${handle}`,
        bio: author.bio,
        bioTranslation: author.bioTranslation,
        profileUrl: `https://x.com/${handle}`,
        images
      });
      toast(`已复制作者信息与 ${images.length} 张原图（${entries.length} 帖），可粘贴`);
    } catch (error) {
      showError(error);
    } finally {
      releaseOwner(owner);
      busy = false;
      paint();
    }
  }

  document.addEventListener("click", event => {
    if (!mode) return;
    const tile = event.target?.closest?.('a[href*="/status/"]');
    if (!tile || !isTile(tile)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    toggleTile(tile);
  }, true);

  const observer = new MutationObserver(mutations => {
    if (invalidated || scanScheduled) return;
    if (mutations.every(change => (change.target.nodeType === 1 ? change.target : change.target.parentElement)?.closest?.("[data-x-copy-ui]"))) return;
    scanScheduled = true;
    scanTimer = setTimeout(() => { scanScheduled = false; refresh(); }, 300);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  addEventListener("popstate", refresh);
  for (const method of ["pushState", "replaceState"]) {
    const original = history[method];
    history[method] = function (...args) {
      const result = original.apply(this, args);
      refresh();
      return result;
    };
  }
  refresh();
})();
