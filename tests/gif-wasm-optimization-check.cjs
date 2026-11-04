// HISTORICAL (v1.1.6): reproduces the old 10 fps / 800 px / 256-color output.
// The current single slim preset no longer accepts gifFps; do not use this
// harness to validate 1.2.0+ builds. Kept only for the earlier report.
// Reproduce a reported local video with the exact bundled browser encoder.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os');
const root = path.resolve(__dirname, '..');
const directory = path.join(root, 'test-results', 'gif-optimize-2114222672704147600');
let browser;
const sockets = [];
async function connect(url) {
  const socket = new WebSocket(url); sockets.push(socket);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let id = 0; const pending = new Map();
  socket.addEventListener('message', event => { const value = JSON.parse(event.data), call = pending.get(value.id); if (!call) return; pending.delete(value.id); value.error ? call.reject(new Error(JSON.stringify(value.error))) : call.resolve(value.result); });
  return { call: (method, params = {}) => new Promise((resolve, reject) => { const next = ++id; pending.set(next, { resolve, reject }); socket.send(JSON.stringify({ id: next, method, params })); }) };
}
async function waitFor(fn) { const start = Date.now(); while (Date.now() - start < 20000) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('Isolated encoder startup timed out'); }
(async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'xcopy-gif-research-')); let stderr = '';
  browser = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', ['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--enable-unsafe-extension-debugging','--remote-debugging-port=0',`--user-data-dir=${profile}`,`--load-extension=${root}`,'about:blank'], { windowsHide: true });
  browser.stderr.on('data', data => stderr += data);
  const ws = await waitFor(() => stderr.match(/DevTools listening on (ws:\/\/\S+)/)?.[1]);
  const control = await connect(ws);
  const { id } = await control.call('Extensions.loadUnpacked', { path: root });
  const { targetId } = await control.call('Target.createTarget', { url: `chrome-extension://${id}/offscreen.html` });
  const origin = ws.replace('ws:', 'http:').replace(/\/devtools\/.*$/, '');
  const target = await waitFor(async () => (await (await fetch(origin + '/json/list')).json()).find(item => item.id === targetId));
  const page = await connect(target.webSocketDebuggerUrl);
  const evaluate = async expression => { const result = await page.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
  await waitFor(() => evaluate('!!globalThis.chrome?.runtime?.id && !!globalThis.XCopyGif'));
  const input = await fs.readFile(path.join(directory, 'input.mp4'));
  if (process.argv.includes('--production')) {
    const result = await evaluate(`(async()=>{
      const {convertGif}=await import('./offscreen.js');
      const result=await convertGif({jobId:'qa-reported-production',gifFps:10,testBytes:Uint8Array.from(atob(${JSON.stringify(input.toString('base64'))}),value=>value.charCodeAt(0))});
      const bytes=new Uint8Array(await(await fetch(result.url)).arrayBuffer());let binary='';for(let offset=0;offset<bytes.length;offset+=16384)binary+=String.fromCharCode(...bytes.subarray(offset,offset+16384));
      return {...result,base64:btoa(binary)};
    })()`);
    const { base64, ...metadata } = result;
    const bytes = Buffer.from(base64, 'base64');
    const candidate = await fs.readFile(path.join(directory, 'wasm-bayer5.gif'));
    if (!bytes.equals(candidate) || metadata.frames !== 155 || metadata.duration !== 15.5 || metadata.width !== 608 || metadata.height !== 640) throw new Error('Production output differs from selected candidate: ' + JSON.stringify(metadata));
    await fs.writeFile(path.join(directory, 'optimized.gif'), bytes);
    await fs.writeFile(path.join(directory, 'production-result.json'), JSON.stringify({ ...metadata, mib: bytes.length / 1024 ** 2, baselineBytes: 31862906, savedPercent: (1 - bytes.length / 31862906) * 100 }, null, 2));
    console.log(JSON.stringify({ ...metadata, mib: bytes.length / 1024 ** 2, byteIdenticalToSelectedCandidate: true }));
    await control.call('Browser.close'); return;
  }
  await evaluate(`(async()=>{const {FFmpeg}=await import('./vendor/ffmpeg/index.js');globalThis.qaEncoder=new FFmpeg();await qaEncoder.load({classWorkerURL:chrome.runtime.getURL('vendor/ffmpeg/worker.js'),coreURL:chrome.runtime.getURL('vendor/core/ffmpeg-core.js'),wasmURL:chrome.runtime.getURL('vendor/core/ffmpeg-core.wasm')});await qaEncoder.writeFile('input.mp4',Uint8Array.from(atob(${JSON.stringify(input.toString('base64'))}),value=>value.charCodeAt(0)));return true;})()`);
  const cases = [
    { name: 'baseline', use: 'dither=sierra2_4a' },
    { name: 'bayer4', use: 'dither=bayer:bayer_scale=4:diff_mode=rectangle' },
    { name: 'bayer5', use: 'dither=bayer:bayer_scale=5:diff_mode=rectangle' },
    { name: 'none', use: 'dither=none:diff_mode=rectangle' },
    { name: '128-bayer4', use: 'dither=bayer:bayer_scale=4:diff_mode=rectangle', colors: 128 }
  ];
  const results = [];
  for (const item of cases) {
    const result = await evaluate(`(async()=>{
      const options=${JSON.stringify(item)},started=performance.now(),gif=globalThis.XCopyGif;
      const palette=gif.paletteArguments('input.mp4',10);if(options.colors)palette[palette.indexOf('-vf')+1]+=':max_colors='+options.colors;
      if(await qaEncoder.exec(['-y',...palette],120000))throw new Error('Palette pass failed');
      const args=gif.argumentsFor('input.mp4','output.gif',10);args[args.indexOf('-lavfi')+1]=args[args.indexOf('-lavfi')+1].replace(/paletteuse=.*/, 'paletteuse='+options.use);
      if(await qaEncoder.exec(['-y',...args],120000))throw new Error('GIF pass failed');
      await qaEncoder.ffprobe(['-v','error','-min_delay','0','-show_entries','stream=width,height,duration,nb_frames','-of','json','-o','probe.json','output.gif']);
      const stream=JSON.parse(await qaEncoder.readFile('probe.json','utf8')).streams[0],bytes=await qaEncoder.readFile('output.gif');
      let binary='';for(let offset=0;offset<bytes.length;offset+=16384)binary+=String.fromCharCode(...bytes.subarray(offset,offset+16384));
      return {name:options.name,use:options.use,colors:options.colors||256,bytes:bytes.length,mib:bytes.length/1024**2,seconds:(performance.now()-started)/1000,...stream,base64:btoa(binary)};
    })()`);
    const { base64, ...metadata } = result;
    await fs.writeFile(path.join(directory, 'wasm-' + item.name + '.gif'), Buffer.from(base64, 'base64'));
    results.push(metadata); console.log(JSON.stringify(metadata));
    await fs.writeFile(path.join(directory, 'wasm-results.json'), JSON.stringify(results, null, 2));
  }
  await evaluate('qaEncoder.terminate();true');
  await control.call('Browser.close');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { for (const socket of sockets) socket.close(); browser?.kill(); });
setTimeout(() => { browser?.kill(); process.exit(1); }, 300000).unref();
