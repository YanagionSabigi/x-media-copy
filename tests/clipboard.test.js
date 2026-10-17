const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("writes just one text record with filtered source, translation and clean link", async () => {
  const writes = [];
  class ClipboardItem { constructor(formats) { this.formats = formats; } }
  const sandbox = vm.createContext({ Blob, ClipboardItem, XCopyCore: require("../core.js"), navigator: { clipboard: { write: async items => writes.push(items) } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../clipboard.js"), "utf8"), sandbox);
  await sandbox.XCopyClipboard.writeText({ original: "Original #art", translation: "译文 #艺术", postUrl: "https://x.com/a/status/123?s=20" });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].length, 1);
  const formats = writes[0][0].formats;
  assert.deepEqual(Object.keys(formats), ["text/plain", "text/html"]);
  assert.equal(await formats["text/plain"].text(), "Original\n\n译文\nhttps://x.com/a/status/123");
  assert.doesNotMatch(await formats["text/html"].text(), /<img|<strong>|#art|#艺术/);
});

test('original photo PNG copying keeps native dimensions without creating a merged bitmap', async () => {
  const writes = [];
  class ClipboardItem { constructor(formats) { this.formats = formats; } }
  const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
  const sandbox = vm.createContext({ Blob, ClipboardItem, fetch, XCopyCore: require('../core.js'), navigator: { clipboard: { write: async items => writes.push(items) } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../clipboard.js'), 'utf8'), sandbox);
  await sandbox.XCopyClipboard.writeImage({ dataUrl, width: 2048, height: 1024 });
  assert.deepEqual(Object.keys(writes[0][0].formats), ['image/png']);
});
