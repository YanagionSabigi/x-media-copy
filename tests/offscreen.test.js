const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('offscreen conversion acknowledges immediately and isolates terminal results by generation', async () => {
  let listener;
  const context = vm.createContext({
    XCopyMedia: require('../media.js'), XCopyGif: require('../gif.js'),
    FFmpeg: class { on() {} terminate() {} },
    AbortController, URL, Blob, setTimeout, clearTimeout, setInterval, clearInterval,
    chrome: { runtime: {
      id: 'extension', getURL: file => 'chrome-extension://extension/' + file,
      sendMessage: async () => ({ ok: true }),
      onMessage: { addListener(callback) { listener = callback; } }
    } }
  });
  const source = fs.readFileSync(path.join(__dirname, '../offscreen.js'), 'utf8')
    .replace(/^import .+;\r?\n/m, '').replace('export async function convertGif', 'async function convertGif');
  vm.runInContext(source, context);
  const sender = { id: 'extension', url: 'chrome-extension://extension/background.js' };
  const send = message => {
    let response;
    const pending = listener({ target: 'offscreen', ...message }, sender, value => { response = JSON.parse(JSON.stringify(value)); });
    return { response, pending };
  };
  const started = send({ type: 'convertGif', conversionId: 'job:0', jobId: 'job', url: 'https://invalid.test/a.mp4' });
  assert.equal(started.pending, false);
  assert.deepEqual(started.response, { ok: true, pending: true });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(send({ type: 'getConversionResult', conversionId: 'job:1' }).response.ok, false);
  const result = send({ type: 'getConversionResult', conversionId: 'job:0' }).response;
  assert.equal(result.ok, false);
  assert.match(result.error, /地址无效/);
  assert.equal(send({ type: 'getConversionResult', conversionId: 'job:0' }).response.ok, false);
});
