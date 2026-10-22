// Pixel-level merge QA in an isolated browser. Does not read the user's clipboard.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises'), http = require('node:http'), path = require('node:path'), os = require('node:os');
const root = path.resolve(__dirname, '..');
const server = http.createServer(async (req, res) => {
  if (req.url === '/image-merge.js') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(await fs.readFile(path.join(root, 'image-merge.js')).catch(() => ''));
  } else res.end('<!doctype html><script src="/image-merge.js"></script>');
});
let browser, socket;
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'xcopy-merge-'));
  let stderr = '';
  browser = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true });
  browser.stderr.on('data', data => { stderr += data; });
  async function waitFor(fn) { const start = Date.now(); while (Date.now() - start < 15000) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 100)); } throw new Error('Merge check timeout: ' + stderr.slice(-200)); }
  const wsUrl = await waitFor(() => stderr.match(/DevTools listening on (ws:\/\/\S+)/)?.[1]);
  const debugOrigin = wsUrl.replace(/^ws:/, 'http:').replace(/\/devtools\/.*$/, '');
  const target = (await (await fetch(debugOrigin + '/json/list')).json()).find(item => item.type === 'page');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  let id = 0; const pending = new Map();
  socket.addEventListener('message', event => { const message = JSON.parse(event.data), job = pending.get(message.id); if (job) { pending.delete(message.id); message.error ? job.reject(new Error(JSON.stringify(message.error))) : job.resolve(message.result); } });
  const call = (method, params = {}) => new Promise((resolve, reject) => { const next = ++id; pending.set(next, { resolve, reject }); socket.send(JSON.stringify({ id: next, method, params })); });
  const evaluate = async expression => { const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value; };
  await call('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
  await waitFor(() => evaluate('document.readyState === "complete"'));
  const result = await evaluate(`(async () => {
    if (!globalThis.XCopyImageMerge) throw new Error('Image merge feature is missing');
    const source = new OffscreenCanvas(300, 180), ctx = source.getContext('2d');
    const pixels = ctx.createImageData(300, 180);
    for (let y = 0; y < 180; y++) for (let x = 0; x < 300; x++) {
      const i = (y * 300 + x) * 4;
      pixels.data.set([Math.round(x / 300 * 240), Math.round(y / 180 * 240), 100, 255], i);
    }
    ctx.putImageData(pixels, 0, 0);
    const dataUrl = blob => new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob); });
    const reports = [];
    for (const [name, boxes] of [
      ['horizontal', [[0,0,75,180],[75,0,75,180],[150,0,75,180],[225,0,75,180]]],
      ['vertical', [[0,0,300,60],[0,60,300,60],[0,120,300,60]]],
      ['grid', [[0,0,150,90],[150,0,150,90],[0,90,150,90],[150,90,150,90]]],
      ['unequal-widths', [[0,0,149,180],[149,0,151,180]]],
      ['unequal-grid', [[0,0,149,89],[149,0,151,89],[0,89,149,91],[149,89,151,91]]]
    ]) {
      const images = [];
      for (const [x,y,w,h] of boxes) {
        const canvas = new OffscreenCanvas(w,h);
        canvas.getContext('2d').drawImage(source,x,y,w,h,0,0,w,h);
        images.push({ dataUrl: await dataUrl(await canvas.convertToBlob({type:'image/png'})) });
      }
      const merged = await XCopyImageMerge.mergeImages(images);
      if (merged.length !== 1) throw new Error(name + ': expected one image');
      const bitmap = await createImageBitmap(await (await fetch(merged[0].dataUrl)).blob());
      const output = new OffscreenCanvas(bitmap.width,bitmap.height);
      output.getContext('2d').drawImage(bitmap,0,0);
      const actual = output.getContext('2d').getImageData(0,0,bitmap.width,bitmap.height).data;
      const width = bitmap.width, height = bitmap.height; bitmap.close();
      if (width !== 300 || height !== 180 || actual.length !== pixels.data.length || !actual.every((value,index) => value === pixels.data[index])) throw new Error(name + ': pixels or dimensions changed');
      reports.push({name,width,height,exactPixels:true});
    }
    const one = [{dataUrl:'data:image/png;base64,unchanged'}];
    if ((await XCopyImageMerge.mergeImages(one))[0].dataUrl !== one[0].dataUrl || (await XCopyImageMerge.mergeImages([])).length) throw new Error('Single/no image handling changed');
    let rejected = false;
    try { await XCopyImageMerge.mergeImages([{dataUrl:'data:image/png;base64,broken'},one[0]]); } catch { rejected = true; }
    if (!rejected) throw new Error('Corrupted input must fail');
    return {cases:reports,corruptInputRejected:rejected};
  })()`);
  console.log(JSON.stringify(result, null, 2));
  const sampleArg = process.argv.indexOf('--sample-dir');
  if (sampleArg >= 0) {
    const directory = path.resolve(process.argv[sampleArg + 1]);
    const inputs = await Promise.all([1,2,3,4].map(async n => ({ dataUrl: 'data:image/jpeg;base64,' + (await fs.readFile(path.join(directory, n + '.jpg'))).toString('base64') })));
    const sample = await evaluate(`(async () => {
      const inputs = ${JSON.stringify(inputs)}, [merged] = await XCopyImageMerge.mergeImages(inputs);
      const output = await createImageBitmap(await (await fetch(merged.dataUrl)).blob());
      const canvas = new OffscreenCanvas(output.width,output.height), ctx = canvas.getContext('2d', {willReadFrequently:true});
      ctx.drawImage(output,0,0); output.close();
      let x = 0; const dimensions = [];
      for (const input of inputs) {
        const bitmap = await createImageBitmap(await (await fetch(input.dataUrl)).blob());
        dimensions.push([bitmap.width,bitmap.height]);
        const tile = new OffscreenCanvas(bitmap.width,bitmap.height), tileCtx = tile.getContext('2d', {willReadFrequently:true});
        tileCtx.drawImage(bitmap,0,0); bitmap.close();
        const expected = tileCtx.getImageData(0,0,tile.width,tile.height).data;
        if (canvas.height !== tile.height || x + tile.width > canvas.width) throw new Error('Example must restore a horizontal panorama');
        const actual = ctx.getImageData(x,0,tile.width,tile.height).data;
        if (!actual.every((value,index)=>value===expected[index])) throw new Error('Example pixels changed');
        x += tile.width;
      }
      if (x !== canvas.width) throw new Error('Example width mismatch');
      return {width:merged.width,height:merged.height,dimensions,exactPixels:true,dataUrl:merged.dataUrl};
    })()`);
    const { dataUrl, ...evidence } = sample;
    await fs.writeFile(path.join(directory, 'merged.png'), Buffer.from(dataUrl.split(',')[1], 'base64'));
    await fs.writeFile(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ example: evidence }, null, 2));
  }
  await call('Browser.close');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { socket?.close(); browser?.kill(); server.close(); });
setTimeout(() => { browser?.kill(); console.error('Merge check exceeded 30 seconds'); process.exit(1); }, 30000).unref();
