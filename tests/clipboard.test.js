const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test('local-file merged copy writes mixed HTML and text without a competing native image',async()=>{
  let written;class ClipboardItem {constructor(formats){this.formats=formats;}}
  const image={dataUrl:'data:image/png;base64,AAAA'};
  const sandbox=vm.createContext({Blob,ClipboardItem,XCopyCore:require('../core.js'),navigator:{clipboard:{write:async items=>written=items}}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../clipboard.js'),'utf8'),sandbox);
  await sandbox.XCopyClipboard.writeText({original:'Text',postUrl:'https://x.com/a/status/1',images:[image],mergedImage:image,mergedImageFileUrl:'file:///C:/Downloads/X/clipboard/1.png'});
  assert.deepEqual(Object.keys(written[0].formats),['text/plain','text/html']);
  const html=await written[0].formats['text/html'].text();
  assert.match(html,/file:\/\/\/C:\/Downloads\/X\/clipboard\/1.png/);assert.doesNotMatch(html,/base64/);
  assert.equal(await written[0].formats['text/plain'].text(),'Text\nhttps://x.com/a/status/1');
});

test('GIF text copy writes the insertion line in plain and HTML clipboard records', async () => {
  let written;
  class ClipboardItem { constructor(formats) { this.formats = formats; } }
  const sandbox = vm.createContext({ Blob, ClipboardItem, XCopyCore: require('../core.js'), navigator: { clipboard: { write: async items => { written = items; } } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../clipboard.js'), 'utf8'), sandbox);
  await sandbox.XCopyClipboard.writeText({ original: 'Original', translation: '译文', postUrl: 'https://x.com/a/status/1?s=20', reserveGifLine: true });
  assert.equal(written.length, 1);
  assert.deepEqual(Object.keys(written[0].formats), ['text/plain', 'text/html']);
  assert.equal(await written[0].formats['text/plain'].text(), 'Original\n\n译文\n\nhttps://x.com/a/status/1');
  assert.equal(await written[0].formats['text/html'].text(), '<div>Original<br><br>译文<br><br><a href="https://x.com/a/status/1">https://x.com/a/status/1</a></div>');
});

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

test('36 MiB merged PNG fits as Base64 HTML with text and source intact', async () => {
  const writes = [];
  class ClipboardItem { constructor(formats) { this.formats = formats; } }
  const image = {dataUrl:'data:image/png;base64,'+'A'.repeat(48*1024*1024)};
  const sandbox=vm.createContext({Blob,ClipboardItem,XCopyCore:require('../core.js'),navigator:{clipboard:{write:async items=>writes.push(items)}}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../clipboard.js'),'utf8'),sandbox);
  await sandbox.XCopyClipboard.writeText({original:'Text',postUrl:'https://x.com/a/status/1',images:[image],mergedImage:image});
  assert.equal(writes.length,1);
  assert.equal(await writes[0][0].formats['text/plain'].text(),'Text\nhttps://x.com/a/status/1');
  assert.ok((await writes[0][0].formats['text/html'].text()).includes(image.dataUrl));
});

test('oversized lossless mixed HTML fails explicitly instead of dropping text or image in desktop chats', async () => {
  const writes = [];
  class ClipboardItem { constructor(formats) { this.formats = formats; } }
  const image = {dataUrl:'data:image/png;base64,'+'A'.repeat(50*1024*1024)};
  const sandbox=vm.createContext({Blob,ClipboardItem,XCopyCore:require('../core.js'),navigator:{clipboard:{write:async items=>writes.push(items)}}});
  vm.runInContext(fs.readFileSync(path.join(__dirname,'../clipboard.js'),'utf8'),sandbox);
  await assert.rejects(()=>sandbox.XCopyClipboard.writeText({original:'Text',postUrl:'https://x.com/a/status/1',images:[image],mergedImage:image}),/50 MiB/);
  assert.equal(writes.length,0);
});

test('profile copy writes the author block and images as mixed HTML and text', async () => {
  const writes = [];
  class ClipboardItem { constructor(formats) { this.formats = formats; } }
  const sandbox = vm.createContext({ Blob, ClipboardItem, XCopyCore: require('../core.js'), navigator: { clipboard: { write: async items => writes.push(items) } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../clipboard.js'), 'utf8'), sandbox);
  await sandbox.XCopyClipboard.writeProfile({
    name: 'rabi', handle: '@rabiadraw', bio: 'Bio', bioTranslation: '介绍',
    profileUrl: 'https://x.com/rabiadraw', images: [{ dataUrl: 'data:image/png;base64,AAAA' }]
  });
  assert.equal(writes.length, 1);
  const formats = writes[0][0].formats;
  assert.deepEqual(Object.keys(formats), ['text/plain', 'text/html']);
  assert.equal(await formats['text/plain'].text(), 'rabi\n@rabiadraw\n\nBio\n\n介绍\n\nhttps://x.com/rabiadraw');
  assert.match(await formats['text/html'].text(), /<img[^>]+data:image\/png;base64,AAAA/);
});
