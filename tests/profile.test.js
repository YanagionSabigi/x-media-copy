const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const core = require("../core.js");
const extractor = require("../extractor.js");
const mediaApi = require("../media.js");

const PHOTO = (key, size = "small") => `https://pbs.twimg.com/media/${key}?format=jpg&name=${size}`;
const ORIG = key => `https://pbs.twimg.com/media/${key}?format=jpg&name=orig`;

// A profile media grid cell links to one photo of one post.
const tile = (id, key, index = 1, user = "rabiadraw") =>
  `<a href="https://x.com/${user}/status/${id}/photo/${index}"><img src="${PHOTO(key)}"></a>`;
const header = (bio = "我画当下喜欢的任何东西。不用AI。", marker = true) => `
  <div data-testid="UserName"><span><span>rabi 🌸</span></span><span>@rabiadraw</span></div>
  ${marker ? `<div data-testid="UserDescription" dir="auto">${bio}</div><div class="translate"><span>翻译自 英语</span><button id="show-original">显示原文</button></div>`
    : `<div data-testid="UserDescription" dir="auto">${bio}</div>`}`;

function profileFixture(options = {}) {
  const dom = new JSDOM(options.html, { url: options.url || "https://x.com/rabiadraw/media", runScripts: "outside-only" });
  const writes = [], calls = [];
  const index = new Map();
  for (const record of options.records || []) index.set(String(record.postId), record.media);
  const showOriginal = dom.window.document.querySelector("#show-original");
  if (showOriginal) showOriginal.addEventListener("click", () => {
    const bio = dom.window.document.querySelector('[data-testid="UserDescription"]');
    const translated = showOriginal.textContent === "显示原文";
    bio.textContent = translated ? "I draw whatever I like at the moment. NO A*I." : "我画当下喜欢的任何东西。不用AI。";
    showOriginal.textContent = translated ? "显示翻译" : "显示原文";
  });
  Object.assign(dom.window, {
    XCopyCore: core,
    XCopyExtractor: extractor,
    XCopyMedia: mediaApi,
    XCopyMediaIndex: index,
    XCopyClipboard: {
      writeProfile: async data => { await options.beforeWrite?.(data); writes.push(core.buildProfilePayload(data)); },
      writeText: async data => { writes.push(core.buildClipboardPayload(data)); }
    },
    chrome: {
      runtime: {
        id: "test-extension",
        getManifest: () => ({}),
        sendMessage: async request => {
          calls.push(request);
          const data = await options.message?.(request);
          return { ok: true, data: data === undefined ? [] : data };
        }
      }
    }
  });
  dom.window.eval(fs.readFileSync(path.join(__dirname, "../profile.js"), "utf8"));
  const document = dom.window.document;
  return {
    dom, document, writes, index,
    calls,
    toolbar: () => document.querySelector(".x-copy-toolbar"),
    toggle: () => document.querySelector(".x-copy-select-toggle"),
    copyButton: () => document.querySelector(".x-copy-copy-selected"),
    count: () => document.querySelector(".x-copy-toolbar-count")?.textContent || "",
    tiles: () => [...document.querySelectorAll('a[href*="/status/"]')],
    imageCalls: () => calls.filter(call => call.type === "prepareImages")
  };
}
const tick = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (condition, timeout = 8000) => {
  const start = Date.now();
  while (Date.now() - start < timeout) { if (condition()) return true; await tick(50); }
  return false;
};

test("toolbar appears only on the media tab and toggles selection mode", async () => {
  const setup = profileFixture({ html: header() + tile(101, "A") });
  try {
    assert.ok(setup.toolbar(), "toolbar should render on /<user>/media");
    assert.equal(setup.toggle().textContent, "多选");
    assert.equal(setup.copyButton().hidden, true);
    setup.toggle().click(); await tick(0);
    assert.equal(setup.toggle().textContent, "退出多选");
    assert.equal(setup.copyButton().hidden, false);
    assert.equal(setup.copyButton().disabled, true);
    assert.match(setup.count(), /已选 0 张图 \/ 0 帖/);
  } finally { setup.dom.window.close(); }

  const profile = profileFixture({ html: header() + tile(101, "A"), url: "https://x.com/rabiadraw" });
  try { assert.equal(profile.toolbar(), null, "no toolbar outside the media tab"); } finally { profile.dom.window.close(); }
});

test("selecting a tile selects every photo of its post", async () => {
  const setup = profileFixture({
    html: header() + tile(101, "A") + tile(102, "B"),
    records: [
      { postId: 101, media: ["A", "A2", "A3", "A4"].map(key => ({ type: "photo", url: ORIG(key) })) },
      { postId: 102, media: [{ type: "photo", url: ORIG("B") }] }
    ]
  });
  try {
    setup.toggle().click(); await tick(0);
    setup.tiles()[0].dispatchEvent(new setup.dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await tick(0);
    assert.match(setup.count(), /已选 4 张图 \/ 1 帖/, "a four-photo post contributes four images");
    assert.ok(setup.tiles()[0].classList.contains("x-copy-tile-selected"));
    assert.ok(setup.tiles()[0].querySelector(".x-copy-tile-check"));
    setup.tiles()[0].dispatchEvent(new setup.dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await tick(0);
    assert.match(setup.count(), /已选 0 张图 \/ 0 帖/);
    assert.equal(setup.tiles()[0].classList.contains("x-copy-tile-selected"), false);
  } finally { setup.dom.window.close(); }
});

test("rejects a post that would exceed the 20-image limit", async () => {
  const records = [];
  for (let id = 100; id < 106; id++) records.push({ postId: id, media: ["A", "B", "C"].map(key => ({ type: "photo", url: ORIG(`${id}${key}`) })) });
  records.push({ postId: 200, media: ["X", "Y", "Z", "W", "V"].map(key => ({ type: "photo", url: ORIG(`200${key}`) })) });
  const setup = profileFixture({
    html: header() + records.slice(0, 6).map((record, index) => tile(record.postId, `${record.postId}A`, index + 1)).join("") + tile(200, "200X"),
    records
  });
  try {
    setup.toggle().click(); await tick(0);
    const click = node => node.dispatchEvent(new setup.dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    for (const node of setup.tiles().slice(0, 6)) { click(node); await tick(0); }
    assert.match(setup.count(), /已选 18 张图 \/ 6 帖/);
    click(setup.tiles()[6]); await tick(0);
    assert.match(setup.count(), /已选 18 张图 \/ 6 帖/, "the post that would exceed 20 images is not added");
    assert.equal(setup.tiles()[6].classList.contains("x-copy-tile-selected"), false);
    assert.match(setup.document.querySelector(".x-copy-toast-error").textContent, /20 张/);
  } finally { setup.dom.window.close(); }
});

test("copy writes the author block and the selected originals in order", async () => {
  const setup = profileFixture({
    html: header() + tile(101, "A") + tile(102, "B") + tile(102, "C", 2) + tile(102, "D", 3),
    records: [
      { postId: 101, media: [{ type: "photo", url: ORIG("A") }, { type: "photo", url: ORIG("A2") }] },
      { postId: 102, media: ["B", "C", "D"].map(key => ({ type: "photo", url: ORIG(key) })) }
    ],
    message: request => request.urls.map(url => ({ url, dataUrl: `data:image/jpeg;base64,${url.match(/media\/(\w+)/)[1]}`, size: 10 }))
  });
  try {
    setup.toggle().click(); await tick(0);
    const click = node => node.dispatchEvent(new setup.dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    click(setup.tiles()[0]); await tick(0);
    click(setup.tiles()[1]); await tick(0);
    assert.match(setup.count(), /已选 5 张图 \/ 2 帖/);
    setup.copyButton().click();
    await until(() => setup.writes.length || setup.document.querySelector(".x-copy-toast-error"));
    assert.equal(setup.writes.length, 1);
    assert.equal(setup.writes[0].plain, "rabi 🌸\n@rabiadraw\n\nI draw whatever I like at the moment. NO A*I.\n\n我画当下喜欢的任何东西。不用AI。\n\nhttps://x.com/rabiadraw");
    assert.equal((setup.writes[0].html.match(/<img/g) || []).length, 5);
    assert.ok(setup.writes[0].html.indexOf("A2") < setup.writes[0].html.indexOf("B"), "images keep selection order");
    assert.match(setup.writes[0].html, /https:\/\/x\.com\/rabiadraw/);
    assert.equal(setup.document.querySelector('[data-testid="UserDescription"]').textContent, "我画当下喜欢的任何东西。不用AI。", "translation is restored after reading");
    assert.match(setup.document.querySelector(".x-copy-toast").textContent, /已复制/);
  } finally { setup.dom.window.close(); }
});

test("a four-photo post split into four grid cells is selected as one post with four images", async () => {
  const setup = profileFixture({
    html: header() + ["A", "B", "C", "D"].map((key, index) => tile(701, key, index + 1)).join(""),
    message: request => request.urls.map(url => ({ url, dataUrl: "data:image/jpeg;base64,AAAA", size: 10 }))
  });
  try {
    setup.toggle().click(); await tick(0);
    setup.tiles()[0].dispatchEvent(new setup.dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await tick(0);
    assert.match(setup.count(), /已选 4 张图 \/ 1 帖/, "the grid fallback finds every photo of the post");
    for (const node of setup.tiles()) assert.ok(node.classList.contains("x-copy-tile-selected"), "every cell of the post is marked");
    setup.copyButton().click();
    await until(() => setup.writes.length || setup.document.querySelector(".x-copy-toast-error"));
    assert.equal(setup.writes.length, 1);
    assert.equal((setup.writes[0].html.match(/<img/g) || []).length, 4);
  } finally { setup.dom.window.close(); }
});

test("copy reads images in batches of at most sixteen urls", async () => {
  const records = [];
  for (let id = 0; id < 20; id++) records.push({ postId: 300 + id, media: [{ type: "photo", url: ORIG(`K${id}`) }] });
  const setup = profileFixture({
    html: header() + records.map((record, index) => tile(record.postId, `K${index}`, 1)).join(""),
    records,
    message: request => request.urls.map(url => ({ url, dataUrl: "data:image/jpeg;base64,AAAA", size: 10 }))
  });
  try {
    setup.toggle().click(); await tick(0);
    const click = node => node.dispatchEvent(new setup.dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    for (const node of setup.tiles().slice(0, 18)) { click(node); await tick(0); }
    assert.match(setup.count(), /已选 18 张图 \/ 18 帖/);
    setup.copyButton().click();
    await until(() => setup.writes.length || setup.document.querySelector(".x-copy-toast-error"));
    const batches = setup.imageCalls();
    assert.ok(batches.length >= 2, `expected more than one batch, saw ${batches.length}`);
    assert.ok(batches.every(call => call.urls.length <= 16));
    assert.equal(batches.flatMap(call => call.urls).length, 18);
    assert.equal(setup.writes.length, 1);
    assert.equal((setup.writes[0].html.match(/<img/g) || []).length, 18);
  } finally { setup.dom.window.close(); }
});

test("splits a batch that exceeds the per-batch byte limit", async () => {
  const keys = Array.from({ length: 16 }, (unused, index) => `S${index}`);
  const setup = profileFixture({
    html: header() + tile(401, "S0"),
    records: [{ postId: 401, media: keys.map(key => ({ type: "photo", url: ORIG(key) })) }],
    message: request => {
      if (request.urls.length > 4) throw new Error("原图合计超过 24 MiB，无法安全写入剪贴板");
      return request.urls.map(url => ({ url, dataUrl: "data:image/jpeg;base64,AAAA", size: 10 }));
    }
  });
  try {
    setup.toggle().click(); await tick(0);
    setup.tiles()[0].dispatchEvent(new setup.dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await tick(0);
    assert.match(setup.count(), /已选 16 张图 \/ 1 帖/);
    setup.copyButton().click();
    await until(() => setup.writes.length || setup.document.querySelector(".x-copy-toast-error"));
    assert.equal(setup.writes.length, 1, "a split batch still copies");
    assert.equal((setup.writes[0].html.match(/<img/g) || []).length, 16);
    assert.ok(setup.imageCalls().every(call => call.urls.length <= 16));
  } finally { setup.dom.window.close(); }
});

test("selection mode intercepts tile clicks instead of opening the photo", async () => {
  const setup = profileFixture({ html: header() + tile(101, "A") });
  try {
    let navigations = 0;
    setup.tiles()[0].addEventListener("click", () => navigations++);
    setup.toggle().click(); await tick(0);
    setup.tiles()[0].dispatchEvent(new setup.dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await tick(0);
    assert.equal(navigations, 0, "the tile link must not run while selecting");
    assert.match(setup.count(), /已选 1 张图/);
  } finally { setup.dom.window.close(); }
});

test("stops before writing when the selected originals exceed the total budget", async () => {
  const setup = profileFixture({
    html: header() + tile(501, "T1") + tile(502, "T2"),
    records: [501, 502].map(id => ({ postId: id, media: [{ type: "photo", url: ORIG(`T${id}`) }] })),
    message: request => request.urls.map(url => ({ url, dataUrl: "data:image/jpeg;base64,AAAA", size: 50 * 1024 * 1024 }))
  });
  try {
    setup.toggle().click(); await tick(0);
    const click = node => node.dispatchEvent(new setup.dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    click(setup.tiles()[0]); await tick(0);
    click(setup.tiles()[1]); await tick(0);
    setup.copyButton().click();
    await until(() => setup.document.querySelector(".x-copy-toast-error"));
    assert.equal(setup.writes.length, 0, "a batch over the budget must not be written");
    assert.match(setup.document.querySelector(".x-copy-toast-error").textContent, /80 MiB/);
    assert.equal(setup.copyButton().disabled, false, "the copy button recovers");
  } finally { setup.dom.window.close(); }
});

test("leaving the media tab removes the toolbar and clears the selection", async () => {
  const setup = profileFixture({ html: header() + tile(101, "A") });
  try {
    setup.toggle().click(); await tick(0);
    setup.tiles()[0].dispatchEvent(new setup.dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    await tick(0);
    assert.match(setup.count(), /已选 1 张图/);
    setup.dom.window.history.pushState({}, "", "/rabiadraw");
    setup.dom.window.dispatchEvent(new setup.dom.window.Event("popstate"));
    await tick(0);
    assert.equal(setup.toolbar(), null);
    setup.dom.window.history.pushState({}, "", "/rabiadraw/media");
    setup.dom.window.dispatchEvent(new setup.dom.window.Event("popstate"));
    await tick(0);
    assert.ok(setup.toolbar());
    assert.match(setup.count(), /已选 0 张图/);
  } finally { setup.dom.window.close(); }
});
