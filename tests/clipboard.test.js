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

test('merged PNG stays byte-identical in mixed HTML without a competing native image format', async () => {
  const writes = [];
  class ClipboardItem { constructor(formats) { this.formats = formats; } }
  const image = { dataUrl: 'data:image/png;base64,iVBORw0KGgo=', width: 4050, height: 1800 };
  const sandbox = vm.createContext({ Blob, ClipboardItem, fetch, createImageBitmap: async () => { throw new Error('Image decode failed'); }, XCopyCore: require('../core.js'), navigator: { clipboard: { write: async items => writes.push(items) } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../clipboard.js'), 'utf8'), sandbox);
  await sandbox.XCopyClipboard.writeText({ original: '🐺', translation: '测试译文', postUrl: 'https://x.com/LitFor20_/status/2113041098461339954', images: [image], mergedImage: image });
  const formats=writes[0][0].formats;
  assert.deepEqual(Object.keys(formats), ['text/plain','text/html']);
  assert.equal(await formats['text/plain'].text(),'🐺\n\n测试译文\nhttps://x.com/LitFor20_/status/2113041098461339954');
  assert.match(await formats['text/html'].text(),/data:image\/png;base64,iVBORw0KGgo=/);
  assert.equal((await formats['text/html'].text()).match(/<img /g).length,1);
});

test('invalid merged PNG aborts the entire clipboard write', async () => {
  const writes = [];
  class ClipboardItem { constructor(formats) { this.formats = formats; } }
  const image = { dataUrl: 'data:image/jpeg;base64,AAAA' };
  const sandbox = vm.createContext({ Blob, ClipboardItem, fetch, XCopyCore: require('../core.js'), navigator: { clipboard: { write: async items => writes.push(items) } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../clipboard.js'), 'utf8'), sandbox);
  await assert.rejects(() => sandbox.XCopyClipboard.writeText({ images: [image], mergedImage: image }), /PNG/);
  assert.equal(writes.length, 0);
});

test('oversized lossless mixed HTML fails explicitly instead of dropping text or image in desktop chats', async () => {
  const writes = [];
  class ClipboardItem { constructor(formats) { this.formats = formats; } }
  const image = {dataUrl:'data:image/png;base64,'+'A'.repeat(16*1024*1024)};
  const sandbox=vm.createContext({Blob,ClipboardItem,XCopyCore:require('../core.js'),navigator:{clipboard:{write:async items=>writes.push(items)}}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../clipboard.js'),'utf8'),sandbox);
  await assert.rejects(()=>sandbox.XCopyClipboard.writeText({original:'Text',postUrl:'https://x.com/a/status/1',images:[image],mergedImage:image}),/16 MiB/);
  assert.equal(writes.length,0);
});
