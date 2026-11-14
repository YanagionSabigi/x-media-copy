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

test('oversized inline HTML stages originals and writes local file references instead of Base64', async () => {
  let written, stagedCalls = 0;
  class ClipboardItem { constructor(formats) { this.formats = formats; } }
  const sent = [];
  const chrome = { runtime: { sendMessage: async message => {
    sent.push(message);
    if (message.type === 'stageClipboardImages') {
      return { ok: true, data: { batchId: 'batch-20', fileUrls: message.urls.map((unused, index) => `file:///C:/Downloads/X/clipboard/batch-20_${index + 1}.jpg`) } };
    }
    return { ok: true, data: true };
  } } };
  const dataUrl = 'data:image/jpeg;base64,' + 'A'.repeat(900 * 1024);
  const images = Array.from({ length: 20 }, (unused, index) => ({ url: `https://pbs.twimg.com/media/BIG${index}?format=jpg&name=orig`, dataUrl }));
  const sandbox = vm.createContext({ Blob, ClipboardItem, chrome, XCopyCore: require('../core.js'), navigator: { clipboard: { write: async items => { written = items; } } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../clipboard.js'), 'utf8'), sandbox);
  await sandbox.XCopyClipboard.writeText({ original: 'Text', postUrl: 'https://x.com/a/status/1', images, onStage: () => stagedCalls++ });
  assert.equal(stagedCalls, 1);
  assert.equal(sent[0].type, 'stageClipboardImages');
  assert.equal(sent[0].urls.length, 20);
  const html = await written[0].formats['text/html'].text();
  assert.equal((html.match(/<img/g) || []).length, 20);
  assert.match(html, /src="file:\/\/\/C:\/Downloads\/X\/clipboard\/batch-20_20.jpg"/);
  assert.doesNotMatch(html, /base64/);
  assert.ok(html.length < 4000);
  assert.ok(sent.some(message => message.type === 'confirmClipboardImages' && message.batchId === 'batch-20'));
});

test('clipboard failure releases staged originals so they are not left behind', async () => {
  class ClipboardItem { constructor(formats) { this.formats = formats; } }
  const sent = [];
  const chrome = { runtime: { sendMessage: async message => {
    sent.push(message);
    if (message.type === 'stageClipboardImages') {
      return { ok: true, data: { batchId: 'batch-fail', fileUrls: message.urls.map((unused, index) => `file:///C:/Downloads/X/clipboard/batch-fail_${index + 1}.jpg`) } };
    }
    return { ok: true, data: true };
  } } };
  const dataUrl = 'data:image/jpeg;base64,' + 'B'.repeat(900 * 1024);
  const images = Array.from({ length: 20 }, (unused, index) => ({ url: `https://pbs.twimg.com/media/FAIL${index}?format=jpg&name=orig`, dataUrl }));
  const sandbox = vm.createContext({ Blob, ClipboardItem, chrome, XCopyCore: require('../core.js'), navigator: { clipboard: { write: async () => { throw new Error('Document is not focused'); } } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../clipboard.js'), 'utf8'), sandbox);
  await assert.rejects(() => sandbox.XCopyClipboard.writeText({ original: 'Text', postUrl: 'https://x.com/a/status/1', images }), /focused/);
  assert.ok(sent.some(message => message.type === 'releaseClipboardImages' && message.batchId === 'batch-fail'));
  assert.equal(sent.some(message => message.type === 'confirmClipboardImages'), false);
});

test('staging failure aborts before any clipboard write', async () => {
  let writes = 0;
  class ClipboardItem { constructor(formats) { this.formats = formats; } }
  const chrome = { runtime: { sendMessage: async () => ({ ok: false, error: '下载目录不可写' }) } };
  const dataUrl = 'data:image/jpeg;base64,' + 'C'.repeat(900 * 1024);
  const images = Array.from({ length: 20 }, (unused, index) => ({ url: `https://pbs.twimg.com/media/DISK${index}?format=jpg&name=orig`, dataUrl }));
  const sandbox = vm.createContext({ Blob, ClipboardItem, chrome, XCopyCore: require('../core.js'), navigator: { clipboard: { write: async () => writes++ } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../clipboard.js'), 'utf8'), sandbox);
  await assert.rejects(() => sandbox.XCopyClipboard.writeText({ original: 'Text', postUrl: 'https://x.com/a/status/1', images }), /下载目录不可写/);
  assert.equal(writes, 0);
});

test('small inline HTML never contacts the staging worker', async () => {
  let written, calls = 0;
  class ClipboardItem { constructor(formats) { this.formats = formats; } }
  const chrome = { runtime: { sendMessage: async () => { calls++; return { ok: true, data: true }; } } };
  const sandbox = vm.createContext({ Blob, ClipboardItem, chrome, XCopyCore: require('../core.js'), navigator: { clipboard: { write: async items => { written = items; } } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../clipboard.js'), 'utf8'), sandbox);
  await sandbox.XCopyClipboard.writeText({ original: 'Text', postUrl: 'https://x.com/a/status/1', images: [{ url: 'https://pbs.twimg.com/media/SMALL?format=jpg&name=orig', dataUrl: 'data:image/jpeg;base64,AAAA' }] });
  assert.equal(calls, 0);
  assert.match(await written[0].formats['text/html'].text(), /data:image\/jpeg;base64,AAAA/);
});

test('oversized profile batches also use local files and confirm the staged batch', async () => {
  let written;
  class ClipboardItem { constructor(formats) { this.formats = formats; } }
  const sent = [];
  const chrome = { runtime: { sendMessage: async message => {
    sent.push(message);
    if (message.type === 'stageClipboardImages') {
      return { ok: true, data: { batchId: 'profile-batch', fileUrls: message.urls.map((unused, index) => `file:///C:/Downloads/X/clipboard/profile_${index + 1}.jpg`) } };
    }
    return { ok: true, data: true };
  } } };
  const dataUrl = 'data:image/jpeg;base64,' + 'D'.repeat(900 * 1024);
  const images = Array.from({ length: 20 }, (unused, index) => ({ url: `https://pbs.twimg.com/media/PROFILE${index}?format=jpg&name=orig`, dataUrl }));
  const sandbox = vm.createContext({ Blob, ClipboardItem, chrome, XCopyCore: require('../core.js'), navigator: { clipboard: { write: async items => { written = items; } } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../clipboard.js'), 'utf8'), sandbox);
  await sandbox.XCopyClipboard.writeProfile({ name: 'rabi', handle: '@rabiadraw', bio: 'Bio', profileUrl: 'https://x.com/rabiadraw', images });
  const html = await written[0].formats['text/html'].text();
  assert.equal((html.match(/<img/g) || []).length, 20);
  assert.match(html, /src="file:\/\/\/C:\/Downloads\/X\/clipboard\/profile_20.jpg"/);
  assert.doesNotMatch(html, /base64/);
  assert.ok(sent.some(message => message.type === 'confirmClipboardImages' && message.batchId === 'profile-batch'));
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
