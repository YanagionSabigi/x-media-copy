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
  if (process.argv.includes('--convert') || process.argv.includes('--e2e') || process.argv.includes('--stress') || process.argv.includes('--volume')) {
    const result = await evaluate(`(async()=>{
      const {FFmpeg}=await import('./vendor/ffmpeg/index.js');
      const encoder=new FFmpeg();
      await encoder.load({classWorkerURL:chrome.runtime.getURL('vendor/ffmpeg/worker.js'),coreURL:chrome.runtime.getURL('vendor/core/ffmpeg-core.js'),wasmURL:chrome.runtime.getURL('vendor/core/ffmpeg-core.wasm')});
      const code=await encoder.exec(['-f','lavfi','-i','testsrc=size=96x64:rate=30:duration=0.6','-c:v','mpeg4','sample.mp4']);
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
    const cadence = await evaluate(`(async()=>{
      const {FFmpeg}=await import('./vendor/ffmpeg/index.js');
      const {convertGif}=await import('./offscreen.js');
      const results=[];
      for(const rate of ['24','30000/1001','30','60']) {
        const encoder=new FFmpeg();
        try {
          await encoder.load({classWorkerURL:chrome.runtime.getURL('vendor/ffmpeg/worker.js'),coreURL:chrome.runtime.getURL('vendor/core/ffmpeg-core.js'),wasmURL:chrome.runtime.getURL('vendor/core/ffmpeg-core.wasm')});
          const code=await encoder.exec(['-f','lavfi','-i','testsrc=size=96x64:rate='+rate+':duration=1','-f','lavfi','-i','sine=frequency=440:duration=1','-c:v','mpeg4','-c:a','aac','sample.mp4']);
          if(code)throw new Error('Audible fixture encode failed');
          await encoder.ffprobe(['-v','error','-show_streams','-of','json','-o','source.json','sample.mp4']);
          const source=JSON.parse(await encoder.readFile('source.json','utf8'));
          if(!source.streams.some(stream=>stream.codec_type==='audio'))throw new Error('Fixture missing audio');
          const input=source.streams.find(stream=>stream.codec_type==='video');
          const converted=await convertGif({jobId:'qa-rate-'+rate,testBytes:await encoder.readFile('sample.mp4')}).catch(error=>{throw new Error('Conversion at '+rate+' fps: '+error.message+'; completed '+JSON.stringify(results));});
          await encoder.writeFile('result.gif',new Uint8Array(await(await fetch(converted.url)).arrayBuffer()));
          await encoder.ffprobe(['-v','error','-min_delay','0','-show_streams','-of','json','-o','result.json','result.gif']);
          const output=JSON.parse(await encoder.readFile('result.json','utf8'));
          if(output.streams.length!==1||output.streams[0].codec_type!=='video')throw new Error('GIF contains unexpected stream');
          if(converted.frames!==10)throw new Error('Slim preset did not sample to 10 frames at '+rate+': '+converted.frames);
          if(Math.abs(converted.duration-Number(input.duration))>0.08)throw new Error('Slim preset changed playback speed at '+rate);
          if(converted.width!==96||converted.height!==64)throw new Error('Small source was resized');
          const original=await convertGif({jobId:'qa-source-rate-'+rate,gifMode:'source',testBytes:await encoder.readFile('sample.mp4')});
          if(original.frames!==Number(input.nb_frames)||original.width!==96||original.height!==64||Math.abs(original.duration-Number(input.duration))>0.08)throw new Error('Source mode changed frames, duration or dimensions: '+JSON.stringify(original));
          results.push({rate,sourceFrames:Number(input.nb_frames),frames:converted.frames,sourceModeFrames:original.frames,sourceModeDuration:original.duration,sourceDuration:Number(input.duration),duration:converted.duration,bytes:converted.size,audio:false});
        } finally {encoder.terminate();}
      }
      return results;
    })()`);
    console.log(JSON.stringify({ cadence }));
    const sizes = await evaluate(`(async()=>{
      const {FFmpeg}=await import('./vendor/ffmpeg/index.js');
      const {convertGif}=await import('./offscreen.js');
      const results=[];
      for(const [width,height,expectedWidth,expectedHeight] of [[1280,720,480,270],[960,1280,480,640],[640,360,480,270],[320,200,320,200]]) {
        const encoder=new FFmpeg();
        try {
          await encoder.load({classWorkerURL:chrome.runtime.getURL('vendor/ffmpeg/worker.js'),coreURL:chrome.runtime.getURL('vendor/core/ffmpeg-core.js'),wasmURL:chrome.runtime.getURL('vendor/core/ffmpeg-core.wasm')});
          const code=await encoder.exec(['-f','lavfi','-i','testsrc2=size='+width+'x'+height+':rate=30:duration=1','-c:v','mpeg4','sample.mp4']);
          if(code)throw new Error('Size fixture encode failed');
          const slim=await convertGif({jobId:'qa-size-'+width,testBytes:await encoder.readFile('sample.mp4')});
          await encoder.writeFile('resized.gif',new Uint8Array(await(await fetch(slim.url)).arrayBuffer()));
          await encoder.ffprobe(['-v','error','-min_delay','0','-show_streams','-of','json','-o','resized.json','resized.gif']);
          const actual=JSON.parse(await encoder.readFile('resized.json','utf8')).streams[0];
          if(actual.width!==expectedWidth||actual.height!==expectedHeight||slim.width!==actual.width||slim.height!==actual.height)throw new Error('Slim size/report mismatch: '+JSON.stringify({width,height,slim,actual}));
          if(slim.frames!==10||Math.abs(slim.duration-1)>0.08)throw new Error('Sampling changed frame count or duration');
          if(width===640){
            const original=await convertGif({jobId:'qa-source-size',gifMode:'source',testBytes:await encoder.readFile('sample.mp4')});
            if(original.width!==640||original.height!==360||original.frames!==30||Math.abs(original.duration-1)>0.08)throw new Error('Source mode resized or resampled a larger input: '+JSON.stringify(original));
          }
          results.push({input:[width,height],slim:[slim.width,slim.height],frames:slim.frames,bytes:slim.size});
        } finally {encoder.terminate();}
      }
      return results;
    })()`);
    console.log(JSON.stringify({ sizes }));
    if (process.argv.includes('--volume')) {
      console.log('Measuring 10-second 1080p60 input with the single slim preset');
      const volume = await evaluate(`(async()=>{
        const {FFmpeg}=await import('./vendor/ffmpeg/index.js');
        const {convertGif}=await import('./offscreen.js');
        const encoder=new FFmpeg();let bytes;
        try {
          await encoder.load({classWorkerURL:chrome.runtime.getURL('vendor/ffmpeg/worker.js'),coreURL:chrome.runtime.getURL('vendor/core/ffmpeg-core.js'),wasmURL:chrome.runtime.getURL('vendor/core/ffmpeg-core.wasm')});
          if(await encoder.exec(['-f','lavfi','-i','testsrc2=size=1920x1080:rate=60:duration=10','-c:v','mpeg4','-q:v','8','-an','sample.mp4'],60000))throw new Error('Volume fixture encode failed');
          bytes=await encoder.readFile('sample.mp4');
        } finally {encoder.terminate();}
        const started=performance.now();
        const result=await convertGif({jobId:'qa-volume-slim',testBytes:bytes.slice()});
        if(result.frames!==100||Math.abs(result.duration-10)>0.03||result.width!==480||result.height!==270)throw new Error('Slim conversion changed frames, duration or dimensions: '+JSON.stringify(result));
        const slim={width:result.width,height:result.height,frames:result.frames,duration:result.duration,bytes:result.size,seconds:(performance.now()-started)/1000};
        URL.revokeObjectURL(result.url);
        return {fixture:'10 second 1920x1080 60 fps testsrc2',inputBytes:bytes.length,slim};
      })()`);
      console.log(JSON.stringify({ volume }));
      const volumeDir = path.join(root, 'test-results', 'gif-sampling'); await fs.mkdir(volumeDir, { recursive: true });
      await fs.writeFile(path.join(volumeDir, 'volume-10fps.json'), JSON.stringify(volume, null, 2));
    }
    if (process.argv.includes('--stress')) {
      await page.call('Runtime.addBinding', { name: 'stressProgress' });
      page.socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.method === 'Runtime.bindingCalled' && message.params.name === 'stressProgress') console.log(message.params.payload);
      });
      const stress = await evaluate(`(async()=>{
        const {FFmpeg}=await import('./vendor/ffmpeg/index.js');
        const {convertGif}=await import('./offscreen.js');
        const encoder=new FFmpeg();
        let bytes;
        const started=performance.now();
        stressProgress('Encoding 20 second 1920x1080 60 fps fixture');
        try {
          await encoder.load({classWorkerURL:chrome.runtime.getURL('vendor/ffmpeg/worker.js'),coreURL:chrome.runtime.getURL('vendor/core/ffmpeg-core.js'),wasmURL:chrome.runtime.getURL('vendor/core/ffmpeg-core.wasm')});
          const code=await encoder.exec(['-f','lavfi','-i','testsrc2=size=1920x1080:rate=60:duration=20','-c:v','mpeg4','-q:v','8','-an','sample.mp4'],180000);
          if(code)throw new Error('Stress fixture encoding failed');
          bytes=await encoder.readFile('sample.mp4');
        } finally {encoder.terminate();}
        stressProgress('Converting 20 s to the 10 fps / 480 px / 128 color preset; input bytes '+bytes.length);
        const conversionStarted=performance.now();
        const slim=await convertGif({jobId:'qa-stress-slim',testBytes:bytes.slice()});
        if(slim.frames!==200||Math.abs(slim.duration-20)>0.08||slim.width!==480||slim.height!==270)throw new Error('Stress slim output changed duration or dimensions: '+JSON.stringify(slim));
        stressProgress('Slim conversion complete; output bytes '+slim.size);
        URL.revokeObjectURL(slim.url);
        return {inputBytes:bytes.length,slim:{frames:slim.frames,duration:slim.duration,bytes:slim.size,seconds:(performance.now()-conversionStarted)/1000},totalSeconds:(performance.now()-started)/1000};
      })()`);
      console.log(JSON.stringify({ stress }));
      const evidenceDir = path.join(root, 'test-results', 'gif-sampling'); await fs.mkdir(evidenceDir, { recursive: true });
      await fs.writeFile(path.join(evidenceDir, 'stress.json'), JSON.stringify(stress, null, 2));
    }
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
      // The visible converter QA tab must stop listening before the real
      // offscreen document receives runtime conversion messages.
      await page.call('Page.navigate', { url: `chrome-extension://${extensionId}/popup.html` });
      await waitFor(() => evaluate('location.pathname === "/popup.html" && !!document.getElementById("jobs")'));
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
      const mergedCopy = await evaluateOn(fixture, `(async()=>{const [item]=await navigator.clipboard.read();const text=await(await item.getType('text/plain')).text(),html=await(await item.getType('text/html')).text();const images=[...new DOMParser().parseFromString(html,'text/html').querySelectorAll('img')];const bmp=await createImageBitmap(await(await fetch(images[0].src)).blob());const result={text,types:item.types,images:images.length,width:bmp.width,height:bmp.height,png:images[0].src.startsWith('data:image/png;base64,'),noDialog:!document.querySelector('[role=dialog]')};bmp.close();return result;})()`);
      if (mergedCopy.text.replace(/\r\n?/g,'\n') !== 'Original\n\n中文译文\nhttps://x.com/qa/status/101' || mergedCopy.images !== 1 || mergedCopy.width * mergedCopy.height !== 3 * 2048 * 1024 || mergedCopy.types.includes('image/png') || !mergedCopy.png || !mergedCopy.noDialog) throw new Error('Shift merged clipboard failed: ' + JSON.stringify(mergedCopy));
      await evaluateOn(fixture, 'document.querySelector("#photo .x-copy-post-button").dispatchEvent(new MouseEvent("click",{shiftKey:true,altKey:true,bubbles:true}))');
      await waitFor(() => evaluateOn(fixture, '!document.querySelector("#photo .x-copy-post-button").disabled'));
      const mergedOriginal = await evaluateOn(fixture, `(async()=>{const [item]=await navigator.clipboard.read();return{text:await(await item.getType('text/plain')).text(),nativePng:item.types.includes('image/png'),images:new DOMParser().parseFromString(await(await item.getType('text/html')).text(),'text/html').querySelectorAll('img').length};})()`);
      if (mergedOriginal.text.replace(/\r\n?/g,'\n') !== 'Original\nhttps://x.com/qa/status/101' || mergedOriginal.images !== 1 || mergedOriginal.nativePng) throw new Error('Alt+Shift merged copy failed: ' + JSON.stringify(mergedOriginal));
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
      await control.call('Target.activateTarget', { targetId: created.targetId });
      await waitFor(() => evaluateOn(fixture, '!document.hidden'));
      await evaluateOn(fixture, `(()=>{const article=document.createElement('article');article.id='video';article.innerHTML='<div data-testid="tweetText">Ordinary video #clip</div><div data-testid="tweetText">视频译文 #视频</div><video src="https://video.twimg.com/ext_tw_video/303/a.mp4"></video><a href="/qa/status/303"><time>now</time></a>'+${JSON.stringify(bar)};article.querySelector('[data-testid=like]').onclick=event=>{event.currentTarget.dataset.testid='unlike'};document.body.append(article);})()`);
      await waitFor(() => evaluateOn(fixture, '!!document.querySelector("#video .x-copy-gif-button")'));
      await evaluateOn(fixture, 'document.querySelector("#video .x-copy-gif-button").click()');
      const videoGif = await waitFor(async () => {
        const response = await evaluate('chrome.runtime.sendMessage({type:"getJobs"})');
        const selected = response.data.filter(job => job.postId === '303');
        if (selected.some(job => job.status === 'failed')) throw new Error('Video GIF download failed: '+JSON.stringify(selected));
        if (selected.length > 1 || selected.some(job => job.format !== 'gif' || job.gifMode !== 'slim')) throw new Error('GIF action started extra downloads or used the wrong mode');
        return selected[0]?.status === 'complete' ? selected[0] : null;
      }, 30000);
      if (!(await evaluateOn(fixture, '!!document.querySelector("#video [data-testid=unlike]")'))) throw new Error('GIF action did not like the post');
      const readGifClipboard = `(async()=>{const [item]=await navigator.clipboard.read();const text=await(await item.getType('text/plain')).text(),html=await(await item.getType('text/html')).text();const doc=new DOMParser().parseFromString(html,'text/html'),link=doc.querySelector('a');return {text,images:doc.querySelectorAll('img').length,insertionLine:link?.previousSibling?.nodeName==='BR'&&link.previousSibling.previousSibling?.nodeName==='BR',url:link?.href};})()`;
      const gifClipboard = await evaluateOn(fixture, readGifClipboard);
      if (gifClipboard.text.replace(/\r\n?/g,'\n') !== 'Ordinary video\n\n视频译文\n\nhttps://x.com/qa/status/303' || gifClipboard.images || !gifClipboard.insertionLine) throw new Error('GIF clipboard layout failed: '+JSON.stringify(gifClipboard));
      const [gifDownload] = await evaluateOn(swTab, `chrome.downloads.search({id:${videoGif.downloadId}})`);
      const gifBytes = await fs.readFile(gifDownload.filename);
      if (!gifBytes.subarray(0,6).toString().startsWith('GIF8') || gifBytes.at(-1)!==0x3b) throw new Error('Ordinary video GIF invalid');
      const buttonLayout = await evaluateOn(fixture, `(()=>{const gif=document.querySelector('#video .x-copy-gif-button'),copy=document.querySelector('#video .x-copy-post-button');gif.scrollIntoView({block:'center'});const a=gif.getBoundingClientRect(),b=copy.getBoundingClientRect();return {width:a.width,height:a.height,ordered:a.right<=b.left,rightmost:copy.parentElement.lastElementChild===copy};})()`);
      if (buttonLayout.width < 44 || buttonLayout.width > 90 || buttonLayout.height !== 26 || !buttonLayout.ordered || !buttonLayout.rightmost) throw new Error('GIF pill layout invalid: '+JSON.stringify(buttonLayout));
      const gifShot = await fixture.call('Page.captureScreenshot', { format: 'png' });
      await fs.writeFile(path.join(directory, 'video-gif.png'), Buffer.from(gifShot.data,'base64'));
      // Alt creates an independent source-mode job while retaining the same text.
      await evaluateOn(fixture, 'document.querySelector("#video .x-copy-gif-button").dispatchEvent(new MouseEvent("click",{altKey:true,bubbles:true}))');
      const sourceGif = await waitFor(async () => {
        const allJobs = (await evaluate('chrome.runtime.sendMessage({type:"getJobs"})')).data;
        const job = allJobs.find(job => job.postId === '303' && job.format === 'gif' && job.gifMode === 'source');
        if(job?.status === 'failed')throw new Error('Source GIF failed: '+JSON.stringify(job));
        return job?.status === 'complete' ? job : null;
      }, 30000);
      if(sourceGif.id===videoGif.id)throw new Error('Source mode reused the slim task');
      const [sourceDownload] = await evaluateOn(swTab, `chrome.downloads.search({id:${sourceGif.downloadId}})`);
      const sourceBytes = await fs.readFile(sourceDownload.filename);
      const sourceMetadata = await evaluateOn(off, `(async()=>{
        const {FFmpeg}=await import('./vendor/ffmpeg/index.js');const encoder=new FFmpeg();
        try{
          await encoder.load({classWorkerURL:chrome.runtime.getURL('vendor/ffmpeg/worker.js'),coreURL:chrome.runtime.getURL('vendor/core/ffmpeg-core.js'),wasmURL:chrome.runtime.getURL('vendor/core/ffmpeg-core.wasm')});
          await encoder.writeFile('download.gif',Uint8Array.from(atob(${JSON.stringify(sourceBytes.toString('base64'))}),c=>c.charCodeAt(0)));
          await encoder.ffprobe(['-v','error','-min_delay','0','-show_streams','-of','json','-o','probe.json','download.gif']);
          return JSON.parse(await encoder.readFile('probe.json','utf8')).streams[0];
        }finally{encoder.terminate();}
      })()`);
      if(Number(sourceMetadata.nb_frames)!==18||sourceMetadata.width!==96||sourceMetadata.height!==64||Math.abs(Number(sourceMetadata.duration)-0.6)>0.08)throw new Error('Alt source mode changed the downloaded video cadence: '+JSON.stringify(sourceMetadata));
      const altGifClipboard = await evaluateOn(fixture, readGifClipboard);
      if (JSON.stringify(altGifClipboard) !== JSON.stringify(gifClipboard)) throw new Error('Alt GIF changed the clipboard layout');
      await evaluateOn(fixture, 'document.querySelector("#video .x-copy-post-button").click()');
      const videoMp4 = await waitFor(async () => {
        const response = await evaluate('chrome.runtime.sendMessage({type:"getJobs"})');
        const selected = response.data.find(job => job.postId === '303' && job.format === 'mp4');
        return selected?.downloadId ? selected : null;
      }, 30000);
      const [mp4Download] = await evaluateOn(swTab, `chrome.downloads.search({id:${videoMp4.downloadId}})`);
      const ordinaryVideoCopy = await evaluateOn(fixture, 'navigator.clipboard.readText()');
      if (ordinaryVideoCopy.replace(/\r\n?/g,'\n') !== 'Ordinary video\n\n视频译文\nhttps://x.com/qa/status/303') throw new Error('GIF spacing leaked into ordinary copy');
      // Native browser downloads are outside the page/worker Fetch fixtures.
      // Assert the original URL reaches Chrome, rather than requiring the
      // synthetic X URL to exist on the public server.
      if (mp4Download.url !== 'https://video.twimg.com/ext_tw_video/303/a.mp4' || !mp4Download.filename.endsWith('.mp4')) throw new Error('Original MP4 download routing changed');
      const evidence = { capturedIds, focusFailure, clipboard, originalOnly, mergedCopy, mergedOriginal, jobs, videoGif, sourceGif, gifClipboard, altGifClipboard, videoMp4, ordinaryVideoCopy, download: { bytes: saved.length, filename: downloaded[0].filename }, originalRequests: seen.filter(url => url.includes('name=orig')) };
      console.log(JSON.stringify({ e2e: evidence })); await fs.writeFile(path.join(directory, 'evidence.json'), JSON.stringify(evidence,null,2));
      const screenshot = await fixture.call('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(path.join(directory, 'fixture.png'), Buffer.from(screenshot.data,'base64'));
      const popupTarget = await control.call('Target.createTarget', { url: `chrome-extension://${extensionId}/popup.html` });
      const popup = await connect(`ws://${new URL(debugOrigin).host}/devtools/page/${popupTarget.targetId}`);
      await waitFor(() => evaluateOn(popup, 'document.getElementById("jobs")?.textContent.includes("GIF")'));
      const popupShot = await popup.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      await fs.writeFile(path.join(directory, 'popup.png'), Buffer.from(popupShot.data,'base64'));
    }
  }
  await control.call('Browser.close'); page.socket.close(); control.socket.close();
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { for(const socket of sockets)socket.close(); browser?.kill(); });
const verificationTimeout = process.argv.includes('--stress') ? 900000 : process.argv.includes('--volume') ? 180000 : process.argv.includes('--e2e') ? 300000 : 60000;
setTimeout(() => { browser?.kill(); console.error('Extension verification exceeded '+verificationTimeout+' ms'); process.exit(1); }, verificationTimeout).unref();
