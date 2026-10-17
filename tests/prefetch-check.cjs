// Native Chrome: speculative reads, clipboard latency, retained heap and tab exit.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const arg = process.argv.indexOf('--extension-dir');
const root = arg < 0 ? path.resolve(__dirname, '..') : path.resolve(process.argv[arg + 1]);
const sockets = []; let browser;
async function waitFor(fn, ms = 20000) {
  const start = Date.now();
  while (Date.now() - start < ms) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 100)); }
  throw new Error('Prefetch verification timed out');
}
async function connect(url) {
  const socket = new WebSocket(url); sockets.push(socket);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let next = 0; const pending = new Map();
  socket.addEventListener('message', event => { const data = JSON.parse(event.data), item = pending.get(data.id); if (!item) return; pending.delete(data.id); data.error ? item.reject(new Error(JSON.stringify(data.error))) : item.resolve(data.result); });
  return { socket, call: (method, params = {}) => new Promise((resolve, reject) => { const id = ++next; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); }) };
}
async function evaluate(session, expression, contextId) {
  const result = await session.call('Runtime.evaluate', { expression, contextId, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function heap(session) {
  await session.call('HeapProfiler.collectGarbage');
  return session.call('Runtime.getHeapUsage');
}
(async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'xcopy-prefetch-'));
  let stderr = '';
  browser = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--enable-unsafe-extension-debugging','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'], { windowsHide: true });
  browser.stderr.on('data', data => { stderr += data; });
  const ws = await waitFor(() => stderr.match(/DevTools listening on (ws:\/\/\S+)/)?.[1]);
  const control = await connect(ws), { id } = await control.call('Extensions.loadUnpacked', { path: root });
  const host = new URL(ws).host;
  const qaTarget = await control.call('Target.createTarget', { url: `chrome-extension://${id}/popup.html` });
  const qa = await connect(`ws://${host}/devtools/page/${qaTarget.targetId}`);
  await waitFor(() => evaluate(qa, '!!chrome.runtime?.id'));
  const png = await evaluate(qa, `(async()=>{const c=document.createElement('canvas');c.width=768;c.height=512;const ctx=c.getContext('2d'),image=ctx.createImageData(c.width,c.height);for(let i=0;i<image.data.length;i+=65536)crypto.getRandomValues(image.data.subarray(i,Math.min(i+65536,image.data.length)));for(let i=3;i<image.data.length;i+=4)image.data[i]=255;ctx.putImageData(image,0,0);return c.toDataURL('image/png').split(',')[1]})()`);
  const swTarget = await waitFor(async () => (await control.call('Target.getTargets')).targetInfos.find(t=>t.type==='service_worker'&&t.url===`chrome-extension://${id}/background.js`));
  const sw = await connect(`ws://${host}/devtools/page/${swTarget.targetId}`);
  const before = await heap(sw);
  const originalRequests = [], cancellations = []; let active=0, peak=0, pausedSlow, slowNetworkId;
  sw.socket.addEventListener('message', event => {
    const data = JSON.parse(event.data);
    if (data.method==='Network.loadingFailed') { cancellations.push(data.params); if(data.params.requestId===slowNetworkId)active--; }
    if (data.method!=='Fetch.requestPaused') return;
    const {requestId,request}=data.params;
    if (!request.url.startsWith('https://pbs.twimg.com/')) { void sw.call('Fetch.continueRequest',{requestId});return; }
    originalRequests.push(request.url); active++;peak=Math.max(peak,active);
    if(request.url.includes('/SLOW?')) { pausedSlow=requestId;slowNetworkId=data.params.networkId; return; }
    setTimeout(()=>{active--;void sw.call('Fetch.fulfillRequest',{requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:'image/png'},{name:'Cache-Control',value:'public,max-age=31536000'}],body:png}).catch(()=>{});},180);
  });
  await sw.call('Network.enable');
  await sw.call('Fetch.enable',{patterns:[{urlPattern:'https://pbs.twimg.com/*'}]});
  const contexts=[];
  const created=await control.call('Target.createTarget',{url:'about:blank'});
  const page=await connect(`ws://${host}/devtools/page/${created.targetId}`);
  page.socket.addEventListener('message',event=>{const data=JSON.parse(event.data);if(data.method==='Runtime.executionContextCreated')contexts.push(data.params.context);});
  await page.call('Runtime.enable');
  await page.call('Page.enable');
  await page.call('Page.addScriptToEvaluateOnNewDocument',{source:'globalThis.__prefetchLongTasks=[];new PerformanceObserver(list=>__prefetchLongTasks.push(...list.getEntries().map(item=>item.duration))).observe({entryTypes:["longtask"]})'});
  const post=(n,keys)=>`<article id="p${n}"><div data-testid="tweetText">Original ${n}</div><div data-testid="tweetText">中文译文 ${n}</div>${keys.map(key=>`<img src="https://pbs.twimg.com/media/${key}?format=png&name=small">`).join('')}<a href="/qa/status/${n}?s=20"><time>now</time></a><div role="group"><button data-testid="like" onclick="this.dataset.testid='unlike'">Like</button></div></article>`;
  const html=`<!doctype html><meta charset="utf-8"><style>body{margin:0}article{height:300px;padding:10px;margin:10px;border:1px solid}img{width:50px;height:50px}</style>${post(1,['PA','PB'])}${post(2,['PC'])}<div style="height:1400px"></div>${post(3,['SLOW'])}${post(4,['OFFSCREEN'])}`;
  async function interceptPage(session) {
    session.socket.addEventListener('message',event=>{const data=JSON.parse(event.data);if(data.method!=='Fetch.requestPaused')return;const image=data.params.request.url.startsWith('https://pbs.twimg.com/');void session.call('Fetch.fulfillRequest',{requestId:data.params.requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:image?'image/png':'text/html;charset=utf-8'}],body:image?'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=':Buffer.from(html).toString('base64')});});
    await session.call('Fetch.enable',{patterns:[{urlPattern:'https://x.com/*'},{urlPattern:'https://pbs.twimg.com/*'}]});
  }
  await interceptPage(page);
  await control.call('Browser.grantPermissions',{origin:'https://x.com',permissions:['clipboardSanitizedWrite','clipboardReadWrite']});
  await page.call('Emulation.setDeviceMetricsOverride',{width:900,height:760,deviceScaleFactor:1,mobile:false});
  await page.call('Emulation.setFocusEmulationEnabled',{enabled:true});
  await page.call('Page.navigate',{url:'https://x.com/qa/prefetch'});
  await waitFor(()=>evaluate(page,'document.querySelectorAll(".x-copy-post-button").length===4'));
  const isolated=await waitFor(async()=>{for(const c of contexts.filter(c=>!c.auxData?.isDefault)){try{if(await evaluate(page,'typeof XCopyClipboard!=="undefined"',c.id))return c.id}catch{}}});
  await evaluate(page,'globalThis.__decodeCalls=0;globalThis.__originalInspect=XCopyClipboard.inspectImages;XCopyClipboard.inspectImages=async(...args)=>{__decodeCalls++;return __originalInspect(...args)}',isolated);
  await waitFor(()=>originalRequests.length===3&&active===0);
  await new Promise(r=>setTimeout(r,200));
  if(peak!==1||originalRequests.some(url=>/SLOW|OFFSCREEN/.test(url)))throw new Error('Prefetch must be serial and visible-only: '+JSON.stringify(originalRequests));
  const peakSpeculativeRequests=peak;
  if(await evaluate(page,'__decodeCalls',isolated)!==0)throw new Error('Speculation decoded a bitmap');
  const prefetchLongTasks=await evaluate(page,'__prefetchLongTasks');
  const warmed={background:await heap(sw),page:await heap(page)};
  await evaluate(page,'globalThis.__clickStart=performance.now();globalThis.__writeDelay=null;globalThis.__originalWrite=XCopyClipboard.writeText;XCopyClipboard.writeText=async data=>{__writeDelay=performance.now()-__clickStart;return __originalWrite(data)}',isolated);
  const readsBeforeClick=originalRequests.length;
  await evaluate(page,'document.querySelector("#p1 .x-copy-post-button").click()');
  await waitFor(()=>evaluate(page,'!!document.querySelector("#p1 [data-testid=unlike]")'));
  const warmPreparationMs=await evaluate(page,'__writeDelay',isolated);
  const copied=await evaluate(page,`(async()=>{const [item]=await navigator.clipboard.read();const doc=new DOMParser().parseFromString(await(await item.getType('text/html')).text(),'text/html');return{images:doc.querySelectorAll('img').length,bytesUnchanged:[...doc.querySelectorAll('img')].every(image=>image.src.split(',')[1]===${JSON.stringify(png)})}})()`);
  if(originalRequests.length!==readsBeforeClick||copied.images!==2||!copied.bytesUnchanged)throw new Error('Warm click must reuse original bytes');
  await evaluate(page,'document.querySelector("#p3").scrollIntoView()');
  await waitFor(()=>pausedSlow);
  await control.call('Target.closeTarget',{targetId:created.targetId});
  await waitFor(()=>cancellations.some(item=>item.canceled));
  const afterClose=await heap(sw);
  // Ask a fresh page-owned image request for the original URL. A new network read
  // proves that closing the former tab dropped its private background cache.
  const next=await control.call('Target.createTarget',{url:'about:blank'});
  const probe=await connect(`ws://${host}/devtools/page/${next.targetId}`);
  const nextContexts=[];
  probe.socket.addEventListener('message',event=>{const data=JSON.parse(event.data);if(data.method==='Runtime.executionContextCreated')nextContexts.push(data.params.context);});
  await probe.call('Runtime.enable');
  const beforeReopen = originalRequests.length;
  await interceptPage(probe);
  await probe.call('Emulation.setDeviceMetricsOverride',{width:900,height:760,deviceScaleFactor:1,mobile:false});
  await probe.call('Page.navigate',{url:'https://x.com/qa/probe'});
  await waitFor(()=>originalRequests.length>=beforeReopen+3&&active===0);
  const refetchedAfterReopen=originalRequests.slice(beforeReopen);
  if(!['PA','PB','PC'].every(key=>refetchedAfterReopen.some(url=>url.includes('/'+key+'?'))))throw new Error('Closing tab retained old owner cache');
  const nextIsolated=await waitFor(async()=>{for(const c of nextContexts.filter(c=>!c.auxData?.isDefault)){try{if(await evaluate(probe,'typeof XCopyClipboard!=="undefined"',c.id))return c.id}catch{}}});
  await probe.call('Emulation.setFocusEmulationEnabled',{enabled:true});
  // Real MAIN-world SPA navigation must be noticed by isolated content scripts.
  await evaluate(probe,'history.pushState({},"","/qa/spa-next");document.body.appendChild(document.createElement("aside"))');
  await new Promise(r=>setTimeout(r,350));
  const backgroundHeapAfterSpa=await heap(sw);
  await evaluate(probe,'globalThis.__clickStart=performance.now();globalThis.__writeDelay=null;globalThis.__originalWrite=XCopyClipboard.writeText;XCopyClipboard.writeText=async data=>{__writeDelay=performance.now()-__clickStart;return __originalWrite(data)}',nextIsolated);
  await evaluate(probe,'document.querySelector("#p1 .x-copy-post-button").click()');
  await waitFor(()=>evaluate(probe,'!!document.querySelector("#p1 [data-testid=unlike]")'));
  const coldPreparationMs=await evaluate(probe,'__writeDelay',nextIsolated);
  if(coldPreparationMs<180)throw new Error('Cold comparison unexpectedly reused old cache');
  await control.call('Target.closeTarget',{targetId:next.targetId});
  const evidence={version:await evaluate(qa,'chrome.runtime.getManifest().version'),syntheticPngBytes:Buffer.from(png,'base64').length,networkDelayMs:180,peakSpeculativeRequests,warmPreparationMs,coldPreparationMs,prefetchLongTasks,copied,originalRequests,refetchedAfterReopen,decodeCallsBeforeClick:0,backgroundHeapBefore:before,heapWithPrefetch:warmed,backgroundHeapAfterClose:afterClose,backgroundHeapAfterSpa,cancelledOnClose:cancellations.filter(item=>item.canceled).length,note:'Post-GC retained JS heap/backing storage, not process RSS. No real accounts or user profile used. Cache no-store is checked at the request boundary by unit tests.'};
  console.log(JSON.stringify(evidence));
  const output=path.join(path.resolve(__dirname,'..'),'test-results','prefetch');await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'evidence.json'),JSON.stringify(evidence,null,2));
  await control.call('Browser.close');
})().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>{for(const socket of sockets)socket.close();browser?.kill()});
setTimeout(()=>{browser?.kill();console.error('Prefetch check overall timeout');process.exit(1)},60000).unref();
