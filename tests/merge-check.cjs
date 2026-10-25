// Pixel-level merge QA in an isolated browser. Does not read the user's clipboard.
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises'), http = require('node:http'), path = require('node:path'), os = require('node:os');
const root = path.resolve(__dirname, '..');
const server = http.createServer(async (req, res) => {
  if (['/image-merge.js', '/core.js', '/clipboard.js'].includes(req.url)) {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(await fs.readFile(path.join(root, req.url)).catch(() => ''));
  } else res.end('<!doctype html><div id="paste-target" contenteditable></div><script src="/core.js"></script><script src="/clipboard.js"></script><script src="/image-merge.js"></script>');
});
let browser, socket;
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'xcopy-merge-'));
  let stderr = '';
  browser = spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', [...(process.argv.includes('--headful') ? [] : ['--headless=new']), '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true });
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
  await call('Browser.grantPermissions', { origin: `http://127.0.0.1:${server.address().port}`, permissions: ['clipboardSanitizedWrite', 'clipboardReadWrite'] });
  await call('Emulation.setFocusEmulationEnabled', { enabled: true });
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
    const image = {dataUrl:await dataUrl(await source.convertToBlob({type:'image/png'})),width:300,height:180};
    await XCopyClipboard.writeText({original:'Original #art',translation:'译文 #作品',postUrl:'https://x.com/a/status/123?s=20',images:[image],mergedImage:image});
    const [item] = await navigator.clipboard.read();
    if (item.types.includes('image/png')) throw new Error('Native PNG overrides text and source in desktop chats');
    const html = await(await item.getType('text/html')).text(), parsed = new DOMParser().parseFromString(html,'text/html');
    if (parsed.images.length !== 1 || parsed.images[0].src !== image.dataUrl) throw new Error('Mixed clipboard must preserve the exact PNG');
    const png = await createImageBitmap(await(await fetch(parsed.images[0].src)).blob());
    if (png.width !== 300 || png.height !== 180) throw new Error('Chat image dimensions changed');
    png.close();
    const plain = (await(await item.getType('text/plain')).text()).split(String.fromCharCode(13)).join('');
    if (plain !== ['Original','','译文','https://x.com/a/status/123'].join(String.fromCharCode(10))) throw new Error('Merged copy lost text or source');
    return {cases:reports,corruptInputRejected:rejected,mixedClipboard:{types:item.types,images:1,pngSize:[300,180],textAndSource:true}};
  })()`);
  console.log(JSON.stringify(result, null, 2));
  const clipboardArg = process.argv.indexOf('--clipboard-sample-dir');
  if (clipboardArg >= 0) {
    const directory = path.resolve(process.argv[clipboardArg + 1]);
    const names=(await fs.readdir(directory)).filter(name=>/^\d+\.jpg$/.test(name)).sort((a,b)=>parseInt(a)-parseInt(b));
    const inputs = await Promise.all(names.map(async name => ({ dataUrl: 'data:image/jpeg;base64,' + (await fs.readFile(path.join(directory, name))).toString('base64') })));
    const tweet=JSON.parse((await fs.readFile(path.join(directory,'tweet.json'),'utf8')).replace(/^\uFEFF/,''));
    await call('Browser.grantPermissions', { origin: `http://127.0.0.1:${server.address().port}`, permissions: ['clipboardSanitizedWrite', 'clipboardReadWrite'] });
    await call('Emulation.setFocusEmulationEnabled', { enabled: true });
    const actualClipboard = await evaluate(`(async()=>{
      const inputs = ${JSON.stringify(inputs)};
      const images = await XCopyImageMerge.mergeImages(inputs);
      await XCopyClipboard.writeText({original:${JSON.stringify(tweet.text)},translation:'测试中文译文',postUrl:'https://x.com/i/status/${tweet.id}',images,mergedImage:images[0]});
      const [item] = await navigator.clipboard.read();
      const html = await (await item.getType('text/html')).text();
      const parsed = new DOMParser().parseFromString(html,'text/html');
      const picture = parsed.querySelector('img');
      if (item.types.includes('image/png')) throw new Error('Native PNG overrides mixed paste');
      if (!picture?.src.startsWith('data:image/png;base64,')) throw new Error('Lossless PNG is missing');
      const native = await createImageBitmap(await(await fetch(picture.src)).blob());
      const embedded = await createImageBitmap(await(await fetch(images[0].dataUrl)).blob());
      const comparison = new OffscreenCanvas(native.width,native.height), comparisonCtx = comparison.getContext('2d',{willReadFrequently:true});
      comparisonCtx.drawImage(native,0,0);
      const nativePixels = comparisonCtx.getImageData(0,0,native.width,native.height).data;
      comparisonCtx.clearRect(0,0,native.width,native.height); comparisonCtx.drawImage(embedded,0,0);
      const embeddedPixels = comparisonCtx.getImageData(0,0,embedded.width,embedded.height).data;
      const nativeSize = [native.width,native.height];
      native.close(); embedded.close(); comparison.width = comparison.height = 1;
      if (nativePixels.length !== embeddedPixels.length || !nativePixels.every((value,index)=>value===embeddedPixels[index])) throw new Error('Lossless PNG pixels changed');
      document.getElementById('paste-target').focus();
      return {types:item.types,images:parsed.images.length,srcLength:picture?.src?.length,width:images[0].width,height:images[0].height,pngSize:nativeSize,exactPixels:true,htmlLength:html.length,text:await(await item.getType('text/plain')).text()};
    })()`);
    await call('Input.dispatchKeyEvent', {type:'keyDown',key:'v',code:'KeyV',windowsVirtualKeyCode:86,modifiers:2});
    await call('Input.dispatchKeyEvent', {type:'keyUp',key:'v',code:'KeyV',windowsVirtualKeyCode:86,modifiers:2});
    const paste = await evaluate(`({images:document.getElementById('paste-target').querySelectorAll('img').length,text:document.getElementById('paste-target').textContent})`);
    if (paste.images !== 1 || !paste.text.includes(tweet.text) || !paste.text.includes(tweet.id)) throw new Error('Mixed clipboard breaks rich-text paste');
    console.log(JSON.stringify({actualClipboard,paste},null,2));
  }
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
  if (process.argv.includes('--hold-clipboard')) {
    console.log('Clipboard ready for desktop draft verification; test browser closes in 3 minutes.');
    await new Promise(resolve => setTimeout(resolve,180000));
  }
  await call('Browser.close');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { socket?.close(); browser?.kill(); server.close(); });
setTimeout(() => { browser?.kill(); console.error('Merge check exceeded its time limit'); process.exit(1); }, process.argv.includes('--hold-clipboard') ? 240000 : 30000).unref();
