// Tests an isolated Chrome profile and local post fixtures. No user clipboard reads.
const {spawn}=require('node:child_process');
const fs=require('node:fs/promises'),http=require('node:http'),path=require('node:path'),os=require('node:os');
const root=path.resolve(__dirname,'..'),nativeMode=process.argv.includes('--native');
const allowed=new Set(['/tests/browser-fixture.html','/core.js','/extractor.js','/clipboard.js','/content.js','/content.css']);
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');if(!allowed.has(url.pathname)){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',url.pathname.endsWith('.html')?'text/html; charset=utf-8':url.pathname.endsWith('.css')?'text/css':'application/javascript; charset=utf-8');
  res.end(await fs.readFile(path.join(root,url.pathname)));
});
let browser,socket;const startedAt=new Date().toISOString();
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;
  const profile=await fs.mkdtemp(path.join(os.tmpdir(),'xcopy-browser-test-'));let stderr='';
  browser=spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--host-resolver-rules=MAP pbs.twimg.com ~NOTFOUND','about:blank'],{windowsHide:true});
  browser.stderr.on('data',chunk=>{stderr+=chunk.toString();});
  const waitUntil=async(predicate,ms=15000)=>{const start=Date.now();while(Date.now()-start<ms){if(await predicate())return;await new Promise(resolve=>setTimeout(resolve,150));}throw new Error('Browser check timed out: '+stderr.slice(-400));};
  await waitUntil(()=>/DevTools listening on (ws:\/\/\S+)/.test(stderr));
  const wsUrl=stderr.match(/DevTools listening on (ws:\/\/\S+)/)[1];const debugOrigin=wsUrl.replace(/^ws:/,'http:').replace(/\/devtools\/.*$/,'');
  const targets=await(await fetch(`${debugOrigin}/json/list`)).json();socket=new WebSocket(targets.find(target=>target.type==='page').webSocketDebuggerUrl);
  await new Promise(resolve=>socket.addEventListener('open',resolve,{once:true}));let nextId=0;const pending=new Map();
  socket.addEventListener('message',event=>{const message=JSON.parse(event.data),job=pending.get(message.id);if(job){pending.delete(message.id);message.error?job.reject(new Error(JSON.stringify(message.error))):job.resolve(message.result);}});
  const cdp=(method,params={})=>new Promise((resolve,reject)=>{const id=++nextId;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
  await cdp('Browser.grantPermissions',{origin:`http://127.0.0.1:${port}`,permissions:['clipboardSanitizedWrite','clipboardReadWrite']});
  await cdp('Page.navigate',{url:`http://127.0.0.1:${port}/tests/browser-fixture.html${nativeMode?'?native=1':''}`});
  await cdp('Emulation.setFocusEmulationEnabled',{enabled:true});
  const evaluate=async expression=>(await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})).result.value;
  await waitUntil(async()=>await evaluate('Boolean(document.querySelector(".x-copy-post-button"))'));
  await evaluate('runFixture()');
  await waitUntil(async()=>await evaluate('Boolean(document.body.dataset.copyResult||document.querySelector(".x-copy-toast-error"))'));
  const result=await evaluate('({status:document.body.dataset.copyResult||"error",writes:testWrites.map(value=>Object.keys(value)),downloadCalls,likeClicks,likedPosts:document.querySelectorAll("article [data-testid=unlike]").length,buttonLayout,errors:testErrors,toast:document.querySelector(".x-copy-toast-error")?.textContent})');
  console.log(JSON.stringify({startedAt,nativeMode,...result},null,2));if(result.status!=='pass')process.exitCode=1;
  if(result.status==='pass'){
    const directory=path.join(root,'test-results','browser');await fs.mkdir(directory,{recursive:true});
    const screenshot=await cdp('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
    await fs.writeFile(path.join(directory,'text-only-layout.png'),Buffer.from(screenshot.data,'base64'));
  }
  await cdp('Browser.close');
})().catch(error=>{console.error(error.message);process.exitCode=1;}).finally(()=>{socket?.close();browser?.kill();server.close();});
setTimeout(()=>{browser?.kill();console.error('Overall browser test timeout');process.exit(1);},30000).unref();
