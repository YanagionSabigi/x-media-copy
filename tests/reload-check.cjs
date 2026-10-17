// Reload the actual extension while its X tab stays open, then recover in-place.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const arg = process.argv.indexOf('--extension-dir');
const root = arg < 0 ? path.resolve(__dirname, '..') : path.resolve(process.argv[arg + 1]);
const sockets = []; let browser, stage = 'starting';
async function waitFor(fn, ms = 15000) {
  const start = Date.now();
  while (Date.now() - start < ms) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 100)); }
  throw new Error('Reload verification timed out: ' + stage);
}
async function connect(url) {
  const socket = new WebSocket(url); sockets.push(socket);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let next = 0; const pending = new Map();
  socket.addEventListener('message', event => { const data = JSON.parse(event.data), item = pending.get(data.id); if (!item) return; pending.delete(data.id); data.error ? item.reject(new Error(JSON.stringify(data.error))) : item.resolve(data.result); });
  return { socket, call: (method, params = {}) => new Promise((resolve, reject) => { const id = ++next; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); }) };
}
async function evaluate(session, expression) {
  const result = await session.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
(async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'xcopy-reload-'));
  let stderr = '';
  browser = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--enable-unsafe-extension-debugging','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'], { windowsHide: true });
  browser.stderr.on('data', data => { stderr += data; });
  const ws = await waitFor(() => stderr.match(/DevTools listening on (ws:\/\/\S+)/)?.[1]);
  const control = await connect(ws), { id } = await control.call('Extensions.loadUnpacked', { path: root });
  stage = 'opening popup';
  const host = new URL(ws).host;
  const openPopup = async () => {
    const target = await control.call('Target.createTarget', { url: `chrome-extension://${id}/popup.html` });
    const session = await connect(`ws://${host}/devtools/page/${target.targetId}`);
    await waitFor(() => evaluate(session, '!!chrome.runtime?.id')).catch(async error => {
      console.error('Popup diagnostics:', await evaluate(session, '({href:location.href,body:document.body?.textContent.slice(0,500)})'));
      throw error;
    });
    return { session, targetId: target.targetId };
  };
  let popup = await openPopup();
  const created = await control.call('Target.createTarget', { url: 'about:blank' });
  const page = await connect(`ws://${host}/devtools/page/${created.targetId}`);
  const html = `<!doctype html><meta charset="utf-8"><article><div data-testid="tweetText">Original #art</div><div data-testid="tweetText">中文译文</div><img src="https://pbs.twimg.com/media/RELOAD?format=png&name=small"><a href="/qa/status/1?s=20"><time>now</time></a><div role="group"><button data-testid="like" onclick="this.dataset.testid='unlike'">Like</button></div></article>`;
  page.socket.addEventListener('message', event => {
    const message = JSON.parse(event.data); if (message.method !== 'Fetch.requestPaused') return;
    const image = message.params.request.url.startsWith('https://pbs.twimg.com/');
    void page.call('Fetch.fulfillRequest', { requestId: message.params.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: image ? 'image/png' : 'text/html; charset=utf-8' }], body: image ? 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' : Buffer.from(html).toString('base64') });
  });
  await page.call('Fetch.enable', { patterns: [{ urlPattern: 'https://x.com/*' }, { urlPattern: 'https://pbs.twimg.com/*' }] });
  await control.call('Browser.grantPermissions', { origin: 'https://x.com', permissions: ['clipboardSanitizedWrite','clipboardReadWrite'] });
  await page.call('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.call('Page.navigate', { url: 'https://x.com/qa/status/1' });
  stage = 'waiting for first button';
  await waitFor(() => evaluate(page, '!!document.querySelector(".x-copy-post-button")'));
  // Loading an already registered unpacked directory performs an actual reload.
  const reloaded = await control.call('Extensions.loadUnpacked', { path: root });
  if (reloaded.id !== id) throw new Error('Reload changed extension identity');
  stage = 'opening fresh popup';
  popup = await openPopup();
  await evaluate(page, 'document.querySelector(".x-copy-post-button").click()');
  stage = 'waiting for stale page message';
  const stale = await waitFor(() => evaluate(page, 'document.querySelector(".x-copy-toast")?.textContent'));
  if (process.argv.includes('--baseline')) {
    if (!/Extension context invalidated/i.test(stale)) throw new Error('Expected old failure, got: ' + stale);
    console.log(JSON.stringify({ reproduced: true, stale }));
  } else {
    if (/Extension context invalidated/i.test(stale) || !/刷新/.test(stale)) throw new Error('Missing recovery: ' + stale);
    if (await evaluate(page, '!!document.querySelector("[data-testid=unlike]")')) throw new Error('Stale operation liked the post');
    await evaluate(page, 'document.querySelector(".x-copy-toast button").click()');
    await waitFor(() => evaluate(page, '!!document.querySelector(".x-copy-post-button")&&!document.querySelector(".x-copy-toast")'));
    // No image request here: exercise native clipboard + fresh context after reload.
    await evaluate(page, 'document.querySelector("article img").remove();document.querySelector(".x-copy-post-button").click()');
    await waitFor(() => evaluate(page, '!!document.querySelector("[data-testid=unlike]")'));
    const text = await evaluate(page, 'navigator.clipboard.readText()');
    if (text.replace(/\r\n?/g, '\n') !== 'Original\n\n中文译文\nhttps://x.com/qa/status/1') throw new Error('Fresh copy failed: ' + text);
    console.log(JSON.stringify({ reloadRecovered: true, stale, text, buttons: await evaluate(page, 'document.querySelectorAll(".x-copy-post-button").length') }));
  }
  await control.call('Browser.close');
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => { for (const socket of sockets) socket.close(); browser?.kill(); });
setTimeout(() => { browser?.kill(); console.error('Reload check overall timeout'); process.exit(1); }, 60000).unref();
