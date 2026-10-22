// Real unpacked extension / CSP / WASM smoke check, isolated profile only.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const directoryArg = process.argv.indexOf('--extension-dir');
const root = directoryArg >= 0 ? path.resolve(process.argv[directoryArg + 1]) : path.resolve(__dirname, '..');
let browser; const sockets = [];
async function connect(url) {
  const socket = new WebSocket(url);
  sockets.push(socket);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let counter = 0; const pending = new Map();
  socket.addEventListener('message', event => { const msg = JSON.parse(event.data); if (!pending.has(msg.id)) return; const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id); msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result); });
  return { socket, call: (method, params = {}) => new Promise((resolve, reject) => { const id = ++counter; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); }) };
}
async function waitFor(fn, timeout = 20000) { const start = Date.now(); while (Date.now() - start < timeout) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 100)); } throw new Error('Browser verification timed out'); }
(async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'xcopy-extension-'));
  let stderr = '';
  browser = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--enable-unsafe-extension-debugging', '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--load-extension=${root}`, 'about:blank'], { windowsHide: true });
  browser.stderr.on('data', data => { stderr += data; });
  const wsUrl = await waitFor(() => stderr.match(/DevTools listening on (ws:\/\/\S+)/)?.[1]);
  const control = await connect(wsUrl);
  const loaded = await control.call('Extensions.loadUnpacked', { path: root, enableInIncognito: false });
  const extensionId = loaded.id;
  const { targetId } = await control.call('Target.createTarget', { url: `chrome-extension://${extensionId}/offscreen.html` });
  const debugOrigin = wsUrl.replace(/^ws:/, 'http:').replace(/\/devtools\/.*$/, '');
  const target = await waitFor(async () => (await (await fetch(`${debugOrigin}/json/list`)).json()).find(t => t.id === targetId));
  const page = await connect(target.webSocketDebuggerUrl);
  const evaluate = async expression => {
    const result = await page.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const status = await evaluate(`(async()=>{ const response=await chrome.runtime.sendMessage({type:'getJobs'}); return {id:chrome.runtime.id, background:response, version:chrome.runtime.getManifest().version}; })()`);
  console.log(JSON.stringify({ status, extensionId }));
  if (process.argv.includes('--convert') || process.argv.includes('--e2e')) {
    const result = await evaluate(`(async()=>{
      const {FFmpeg}=await import('./vendor/ffmpeg/index.js');
      const encoder=new FFmpeg();
      await encoder.load({classWorkerURL:chrome.runtime.getURL('vendor/ffmpeg/worker.js'),coreURL:chrome.runtime.getURL('vendor/core/ffmpeg-core.js'),wasmURL:chrome.runtime.getURL('vendor/core/ffmpeg-core.wasm')});
      const code=await encoder.exec(['-f','lavfi','-i','testsrc=size=96x64:rate=10:duration=0.6','-c:v','mpeg4','sample.mp4']);
      if(code)throw new Error('Fixture video encode failed');
      const bytes=await encoder.readFile('sample.mp4');encoder.terminate();
      const sourceBase64=btoa(String.fromCharCode(...bytes));
      const {convertGif}=await import('./offscreen.js');
      const converted=await convertGif({jobId:'qa-conversion',testBytes:bytes});
      const blob=await(await fetch(converted.url)).arrayBuffer();
      const canvas=document.createElement('canvas');canvas.width=2048;canvas.height=1024;canvas.getContext('2d').fillRect(0,0,2048,1024);
      return {...converted,header:String.fromCharCode(...new Uint8Array(blob).slice(0,6)),sourceBase64,photoBase64:canvas.toDataURL('image/png').split(',')[1]};
    })()`);
    const { sourceBase64, photoBase64, ...metadata } = result;
    console.log(JSON.stringify({ conversion: metadata }));
    if (result.frames < 2 || result.width !== 96 || result.height !== 64 || !result.header.startsWith('GIF8')) throw new Error('Invalid animated GIF output');
    if (process.argv.includes('--e2e')) {
      const directory = path.join(root, 'test-results', 'extension'); await fs.mkdir(directory, { recursive: true });
      await control.call('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: directory });
      // A real hidden offscreen document exercises actual service-worker messaging.
      const targets = (await control.call('Target.getTargets')).targetInfos;
      const sw = targets.find(t => t.type === 'service_worker' && t.url === `chrome-extension://${extensionId}/background.js`);
      if (!sw) throw new Error('Missing extension service worker');
      const swTab = await connect(`ws://${new URL(debugOrigin).host}/devtools/page/${sw.targetId}`);
      const evaluateOn = async (session, expression) => {
        const out = await session.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
        if (out.exceptionDetails) throw new Error(JSON.stringify(out.exceptionDetails));
        return out.result.value;
      };
      await evaluateOn(swTab, `chrome.offscreen.createDocument({url:'offscreen.html',reasons:['WORKERS','BLOBS'],justification:'Isolated extension conversion verification'})`);
      const offTarget = await waitFor(async () => (await control.call('Target.getTargets')).targetInfos.find(t => t.url === `chrome-extension://${extensionId}/offscreen.html` && t.targetId !== targetId));
      const off = await connect(`ws://${new URL(debugOrigin).host}/devtools/page/${offTarget.targetId}`);
      const seen = [];
      async function intercept(session, documentHtml) {
        session.socket.addEventListener('message', async event => {
          const msg = JSON.parse(event.data); if (msg.method !== 'Fetch.requestPaused') return;
          const { requestId, request: requestData } = msg.params, u = new URL(requestData.url);
          seen.push(requestData.url);
          try {
            let type, body;
            if (u.hostname === 'pbs.twimg.com') { type = 'image/png'; body = photoBase64; }
            else if (u.hostname === 'video.twimg.com') { type = 'video/mp4'; body = sourceBase64; }
            else if (u.pathname.includes('/graphql/')) {
              type = 'application/json'; body = Buffer.from(JSON.stringify({ data: { tweets: [{ rest_id: '101', legacy: { extended_entities: { media: ['QA','QB','QC'].map(key => ({ type: 'photo', media_url_https: `https://pbs.twimg.com/media/${key}.png` })) } } }, { rest_id: '202', legacy: { extended_entities: { media: [{ type: 'animated_gif', media_url_https: 'https://pbs.twimg.com/tweet_video_thumb/QA.jpg', video_info: { variants: [{ content_type: 'video/mp4', url: 'https://video.twimg.com/tweet_video/QA.mp4' }] } }] } } }] } })).toString('base64');
            } else if (u.hostname === 'x.com' && documentHtml) { type = 'text/html; charset=utf-8'; body = Buffer.from(documentHtml).toString('base64'); }
            else { await session.call('Fetch.continueRequest', { requestId }); return; }
            await session.call('Fetch.fulfillRequest', { requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: type }, { name: 'Access-Control-Allow-Origin', value: '*' }], body });
          } catch (error) { console.error('Intercept:', error.message); }
        });
        await session.call('Fetch.enable', { patterns: [{ urlPattern: 'https://x.com/*' }, { urlPattern: 'https://pbs.twimg.com/*' }, { urlPattern: 'https://video.twimg.com/*' }] });
      }
      await intercept(swTab); await intercept(off);
      const created = await control.call('Target.createTarget', { url: 'about:blank' });
      const fixture = await connect(`ws://${new URL(debugOrigin).host}/devtools/page/${created.targetId}`);
      const contexts = [];
      fixture.socket.addEventListener('message', event => { const message = JSON.parse(event.data); if (message.method === 'Runtime.executionContextCreated') contexts.push(message.params.context); });
      await fixture.call('Runtime.enable');
      const bar = '<div role="group"><button data-testid="reply">评论</button><button data-testid="like">喜欢</button><button data-testid="share">分享</button></div>';
      const html = `<!doctype html><meta charset="utf-8"><style>body{font:16px system-ui}article{width:500px;margin:20px;padding:16px;border:1px solid #aaa}img{width:150px}[role=group]{display:flex;gap:25px}</style><article id="photo"><div data-testid="tweetText">Original #foo-bar</div><div data-testid="tweetText">中文译文（#作品）</div>${['QA','QB','QC'].map(key=>`<img src="https://pbs.twimg.com/media/${key}?format=png&name=small">`).join('')}<a href="/qa/status/101"><time>now</time></a>${bar}</article><article id="animation"><div data-testid="tweetText">Animation</div><video poster="https://pbs.twimg.com/tweet_video_thumb/QA.jpg"></video><a href="/qa/status/202"><time>now</time></a>${bar}</article><script>for(const b of document.querySelectorAll('[data-testid=like]'))b.onclick=()=>{b.dataset.likeClicked='true';if(b.closest('article').id==='animation')setTimeout(()=>b.dataset.testid='unlike',700);else b.dataset.testid='unlike'};fetch('/i/api/graphql/QA/TweetDetail');</script>`;
      await intercept(fixture, html);
      await control.call('Browser.grantPermissions', { origin: 'https://x.com', permissions: ['clipboardSanitizedWrite', 'clipboardReadWrite'] });
      await fixture.call('Emulation.setFocusEmulationEnabled', { enabled: true });
      await fixture.call('Page.navigate', { url: 'https://x.com/xcopy-fixture' });
      await waitFor(() => evaluateOn(fixture, 'document.querySelectorAll(".x-copy-post-button").length===2'));
      const capturedIds = await waitFor(async () => {
        for (const context of contexts.filter(c => !c.auxData?.isDefault)) {
          try {
            const found = await fixture.call('Runtime.evaluate', { contextId: context.id, expression: 'typeof XCopyMediaIndex!=="undefined"?[...XCopyMediaIndex.keys()]:null', returnByValue: true });
            if (found.result.value?.includes('202')) return found.result.value;
          } catch { /* Context destroyed on navigation. */ }
        }
        return null;
      }, 5000).catch(async error => {
        const diagnostics = [];
        for (const context of contexts) {
          try { diagnostics.push({ context, result: await fixture.call('Runtime.evaluate', { contextId: context.id, expression: '({hook:window.__xCopyMediaHook,index:typeof XCopyMediaIndex!=="undefined"?[...XCopyMediaIndex.keys()]:null,media:typeof XCopyMedia,fetch:String(window.fetch).slice(0,100)})', returnByValue: true }) }); } catch {}
        }
        console.error(JSON.stringify({ diagnostics, seen })); throw error;
      });
      // Moving to another tab removes focus. A hidden page must stop through
      // lifecycle cleanup before attempting a clipboard write.
      await fixture.call('Emulation.setFocusEmulationEnabled', { enabled: false });
      await control.call('Target.activateTarget', { targetId });
      if (await evaluateOn(fixture, 'document.hasFocus()')) throw new Error('Focus failure test must use an unfocused X page');
      const hidden = await evaluateOn(fixture, 'document.hidden');
      await evaluateOn(fixture, 'document.querySelector("#photo .x-copy-post-button").click()');
      let focusFailure;
      if (hidden) {
        await waitFor(() => evaluateOn(fixture, '!document.querySelector("#photo .x-copy-post-button").disabled'));
        focusFailure = '页面隐藏时已安全中止复制';
      } else {
        focusFailure = await waitFor(() => evaluateOn(fixture, 'document.querySelector(".x-copy-toast-error")?.textContent'));
        if (!/回到 X.*空白处.*再点复制/.test(focusFailure)) throw new Error('Focus failure lacks retry instructions: ' + focusFailure);
      }
      if (await evaluateOn(fixture, '!!document.querySelector("#photo [data-testid=unlike]")')) throw new Error('Focus failure must not like the post');
      await control.call('Target.activateTarget', { targetId: created.targetId });
      await fixture.call('Emulation.setFocusEmulationEnabled', { enabled: true });
      await waitFor(() => evaluateOn(fixture, '!document.hidden'));
      await evaluateOn(fixture, 'document.querySelector("#photo .x-copy-post-button").click()');
      await waitFor(() => evaluateOn(fixture, 'document.querySelector("#photo [data-testid=unlike]")!==null'));
      const clipboard = await evaluateOn(fixture, `(async()=>{const items=await navigator.clipboard.read();const text=await(await items[0].getType('text/plain')).text(),html=await(await items[0].getType('text/html')).text();const doc=new DOMParser().parseFromString(html,'text/html');const images=[...doc.querySelectorAll('img')];const src=images[0]?.src;if(!src)throw new Error('No embedded original photo');const bmp=await createImageBitmap(await(await fetch(src)).blob());const last=images.at(-1),link=doc.querySelector('a');const compact=images[0].previousSibling?.nodeName==='BR'&&images[0].previousSibling.previousSibling?.nodeName!=='BR'&&images.every((image,index)=>!index||images[index-1].nextElementSibling===image)&&last.nextElementSibling?.tagName==='BR'&&last.nextElementSibling.nextElementSibling===link;return{text,types:items[0].types,width:bmp.width,height:bmp.height,images:images.length,compact,bytesUnchanged:images.every(image=>image.src.split(',')[1]===${JSON.stringify(photoBase64)})};})()`);
      if (clipboard.width !== 2048 || clipboard.height !== 1024 || clipboard.text.replace(/\r\n?/g,'\n') !== 'Original\n\n中文译文\nhttps://x.com/qa/status/101') throw new Error('Original photo or text layout verification failed: ' + JSON.stringify(clipboard));
      if (clipboard.images!==3 || !clipboard.compact || !clipboard.bytesUnchanged) throw new Error('Multi-photo spacing or original bytes changed: '+JSON.stringify(clipboard));
      await evaluateOn(fixture, 'document.querySelector("#photo .x-copy-post-button").dispatchEvent(new MouseEvent("click",{altKey:true,bubbles:true}))');
      await waitFor(() => evaluateOn(fixture, '!document.querySelector("#photo .x-copy-post-button").disabled'));
      const originalOnly = await evaluateOn(fixture, `(async()=>{const [item]=await navigator.clipboard.read();const text=await(await item.getType('text/plain')).text(),html=await(await item.getType('text/html')).text();const doc=new DOMParser().parseFromString(html,'text/html');return{text,images:doc.querySelectorAll('img').length,noDialog:!document.querySelector('[role=dialog]'),bytesUnchanged:[...doc.querySelectorAll('img')].every(image=>image.src.split(',')[1]===${JSON.stringify(photoBase64)})};})()`);
      if (originalOnly.text.replace(/\r\n?/g,'\n') !== 'Original\nhttps://x.com/qa/status/101' || originalOnly.images!==3 || !originalOnly.bytesUnchanged || !originalOnly.noDialog) throw new Error('Alt original-only copy failed: '+JSON.stringify(originalOnly));
      await evaluateOn(fixture, 'document.querySelector("#photo .x-copy-post-button").dispatchEvent(new MouseEvent("click",{shiftKey:true,bubbles:true}))');
      await waitFor(() => evaluateOn(fixture, '!document.querySelector("#photo .x-copy-post-button").disabled'));
      const mergedCopy = await evaluateOn(fixture, `(async()=>{const [item]=await navigator.clipboard.read();const text=await(await item.getType('text/plain')).text(),html=await(await item.getType('text/html')).text();const images=[...new DOMParser().parseFromString(html,'text/html').querySelectorAll('img')];const bmp=await createImageBitmap(await(await fetch(images[0].src)).blob());const result={text,images:images.length,width:bmp.width,height:bmp.height,png:images[0].src.startsWith('data:image/png;base64,'),noDialog:!document.querySelector('[role=dialog]')};bmp.close();return result;})()`);
      if (mergedCopy.text.replace(/\r\n?/g,'\n') !== 'Original\n\n中文译文\nhttps://x.com/qa/status/101' || mergedCopy.images !== 1 || mergedCopy.width * mergedCopy.height !== 3 * 2048 * 1024 || !mergedCopy.png || !mergedCopy.noDialog) throw new Error('Shift merged clipboard failed: ' + JSON.stringify(mergedCopy));
      await evaluateOn(fixture, 'document.querySelector("#photo .x-copy-post-button").dispatchEvent(new MouseEvent("click",{shiftKey:true,altKey:true,bubbles:true}))');
      await waitFor(() => evaluateOn(fixture, '!document.querySelector("#photo .x-copy-post-button").disabled'));
      const mergedOriginal = await evaluateOn(fixture, `(async()=>{const [item]=await navigator.clipboard.read();return{text:await(await item.getType('text/plain')).text(),images:new DOMParser().parseFromString(await(await item.getType('text/html')).text(),'text/html').querySelectorAll('img').length};})()`);
      if (mergedOriginal.text.replace(/\r\n?/g,'\n') !== 'Original\nhttps://x.com/qa/status/101' || mergedOriginal.images !== 1) throw new Error('Alt+Shift merged copy failed: ' + JSON.stringify(mergedOriginal));
      await evaluateOn(fixture, 'document.querySelector("#animation .x-copy-post-button").click()');
      await waitFor(() => evaluateOn(fixture, '!!document.querySelector("#animation [data-like-clicked=true]")'));
      // Once clipboard succeeds, switching to chat must not discard the user's
      // explicit media download while X is still confirming its liked state.
      await control.call('Target.activateTarget', { targetId });
      const jobs = await waitFor(async () => {
        const response = await evaluate('chrome.runtime.sendMessage({type:"getJobs"})');
        if (response.data?.some(job => job.status === 'failed')) throw new Error('E2E download failed: ' + JSON.stringify(response));
        return response.data?.some(job => job.status === 'complete') ? response.data : null;
      }, 30000);
      const downloaded = await evaluateOn(swTab, `chrome.downloads.search({id:${jobs[0].downloadId}})`);
      const saved = await fs.readFile(downloaded[0].filename);
      if (!saved.subarray(0,6).toString().startsWith('GIF8') || saved.at(-1)!==0x3b) throw new Error('Downloaded GIF invalid');
      const evidence = { capturedIds, focusFailure, clipboard, originalOnly, mergedCopy, mergedOriginal, jobs, download: { bytes: saved.length, filename: downloaded[0].filename }, originalRequests: seen.filter(url => url.includes('name=orig')) };
      console.log(JSON.stringify({ e2e: evidence })); await fs.writeFile(path.join(directory, 'evidence.json'), JSON.stringify(evidence,null,2));
      const screenshot = await fixture.call('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(path.join(directory, 'fixture.png'), Buffer.from(screenshot.data,'base64'));
    }
  }
  await control.call('Browser.close'); page.socket.close(); control.socket.close();
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { for(const socket of sockets)socket.close(); browser?.kill(); });
setTimeout(() => { browser?.kill(); console.error('Extension verification exceeded 60 seconds'); process.exit(1); }, 60000).unref();
