// Exercise the actual extension on an intercepted X fixture, with real JPEGs.
const {spawn}=require('node:child_process');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {fileURLToPath}=require('node:url');
const root=path.resolve(__dirname,'..');
const sample=path.resolve(process.argv[2]||path.join(root,'test-results/issue-2119234009901543927'));
let browser;const sockets=[];
async function waitFor(fn){const start=Date.now();while(Date.now()-start<45000){const result=await fn();if(result)return result;await new Promise(r=>setTimeout(r,100))}throw new Error('Extension merge check timed out')}
async function connect(url){
  const socket=new WebSocket(url);sockets.push(socket);await new Promise(resolve=>socket.addEventListener('open',resolve,{once:true}));
  let id=0;const jobs=new Map();
  socket.addEventListener('message',event=>{const msg=JSON.parse(event.data),job=jobs.get(msg.id);if(job){jobs.delete(msg.id);msg.error?job.reject(new Error(JSON.stringify(msg.error))):job.resolve(msg.result)}});
  return {socket,call:(method,params={})=>new Promise((resolve,reject)=>{jobs.set(++id,{resolve,reject});socket.send(JSON.stringify({id,method,params}))})};
}
async function evaluate(session,expression){const result=await session.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(result.exceptionDetails)throw new Error(JSON.stringify(result.exceptionDetails));return result.result.value}
(async()=>{
  const profile=await fs.mkdtemp(path.join(os.tmpdir(),'xcopy-merged-file-'));
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'xcopy-merged-files-'));
  await fs.mkdir(path.join(profile,'Default'),{recursive:true});
  await fs.writeFile(path.join(profile,'Default','Preferences'),JSON.stringify({download:{default_directory:directory,prompt_for_download:false,directory_upgrade:true}}));
  let stderr='';
  browser=spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--disable-background-networking','--enable-unsafe-extension-debugging','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{windowsHide:true});
  browser.stderr.on('data',data=>stderr+=data);
  const ws=await waitFor(()=>stderr.match(/DevTools listening on (ws:\/\/\S+)/)?.[1]);
  const control=await connect(ws),debug=ws.replace(/^ws:/,'http:').replace(/\/devtools\/.*$/,'');
  const {id:extensionId}=await control.call('Extensions.loadUnpacked',{path:root});
  await control.call('Browser.grantPermissions',{origin:'https://x.com',permissions:['clipboardSanitizedWrite','clipboardReadWrite']});
  await control.call('Target.createTarget',{url:`chrome-extension://${extensionId}/popup.html`});
  const workerTarget=await waitFor(async()=>(await control.call('Target.getTargets')).targetInfos.find(t=>t.type==='service_worker'&&t.url===`chrome-extension://${extensionId}/background.js`));
  const worker=await connect(`ws://${new URL(debug).host}/devtools/page/${workerTarget.targetId}`);
  const {targetId}=await control.call('Target.createTarget',{url:'about:blank'});
  const page=await connect(`ws://${new URL(debug).host}/devtools/page/${targetId}`);
  const jpeg=await Promise.all([1,2,3,4].map(n=>fs.readFile(path.join(sample,n+'.jpg'))));
  const html='<!doctype html><meta charset="utf-8"><article><div data-testid="tweetText">Original</div><div data-testid="tweetText">译文</div>'+[1,2,3,4].map(n=>`<img src="https://pbs.twimg.com/media/FIX${n}.jpg">`).join('')+'<a href="https://x.com/qa/status/2119234009901543927"><time>now</time></a><div role="group"><button data-testid="reply">Reply</button><button data-testid="like" onclick="this.dataset.testid=\'unlike\'">Like</button><button data-testid="share">Share</button></div></article>';
  for(const session of [worker,page]){
    session.socket.addEventListener('message',async event=>{
      const message=JSON.parse(event.data);if(message.method!=='Fetch.requestPaused')return;
      const {requestId,request}=message.params,u=new URL(request.url);
      try{
        const match=u.pathname.match(/\/media\/FIX([1-4])/);
        const body=match?jpeg[Number(match[1])-1]:Buffer.from(html);
        await session.call('Fetch.fulfillRequest',{requestId,responseCode:200,responseHeaders:[{name:'Content-Type',value:match?'image/jpeg':'text/html; charset=utf-8'},{name:'Access-Control-Allow-Origin',value:'*'}],body:body.toString('base64')});
      }catch(error){console.error('Fixture interception failed:',error.message)}
    });
    await session.call('Fetch.enable',{patterns:[{urlPattern:'https://x.com/*'},{urlPattern:'https://pbs.twimg.com/*'}]});
  }
  await page.call('Page.navigate',{url:'https://x.com/qa/status/2119234009901543927'});
  await control.call('Target.activateTarget',{targetId});
  await page.call('Emulation.setFocusEmulationEnabled',{enabled:true});
  await waitFor(()=>evaluate(page,'!!document.querySelector(".x-copy-post-button")'));
  const reports=[], generated=[];let previousDownloadId=null;
  for(const originalOnly of [false,true,false,true]){
    await evaluate(page,`document.querySelector('.x-copy-post-button').dispatchEvent(new MouseEvent('click',{shiftKey:true,altKey:${originalOnly},bubbles:true}))`);
    await waitFor(async()=>{const state=await evaluate(page,'({done:!document.querySelector(".x-copy-post-button").disabled,error:document.querySelector(".x-copy-toast-error")?.textContent})');if(state.error)throw new Error(state.error);return state.done});
    const downloadId=await waitFor(async()=>{const saved=await evaluate(worker,"chrome.storage.local.get(['mergedClipboardFiles','activeMergedClipboardId'])");const last=saved.mergedClipboardFiles?.at(-1);return last&&last.id!==previousDownloadId&&last.id===saved.activeMergedClipboardId?last.id:null});
    previousDownloadId=downloadId;
    const [download]=await evaluate(worker,`chrome.downloads.search({id:${downloadId}})`);
    const clipboard=await waitFor(async()=>{
      const value=await evaluate(page,`(async()=>{const [item]=await navigator.clipboard.read({unsanitized:['text/html']});const html=await(await item.getType('text/html')).text();const doc=new DOMParser().parseFromString(html,'text/html');return {text:(await(await item.getType('text/plain')).text()).replaceAll(String.fromCharCode(13),''),types:item.types,htmlBytes:new Blob([html]).size,images:doc.images.length,src:doc.images[0]?.getAttribute('src'),link:doc.querySelector('a')?.href,liked:!!document.querySelector('[data-testid=unlike]')}})()`);
      return value.src&&require('node:url').fileURLToPath(value.src)===download.filename?value:null;
    });
    if(clipboard.images!==1||!clipboard.src?.startsWith('file:///')||clipboard.types.includes('image/png')||!clipboard.liked||clipboard.link!=='https://x.com/qa/status/2119234009901543927')throw new Error('Invalid mixed file clipboard: '+JSON.stringify(clipboard));
    const expectedText=originalOnly?'Original\nhttps://x.com/qa/status/2119234009901543927':'Original\n\n译文\nhttps://x.com/qa/status/2119234009901543927';
    if(clipboard.text!==expectedText)throw new Error('Text or source lost');
    generated.push(fileURLToPath(clipboard.src));
    const bytes=await fs.readFile(generated.at(-1));
    if(!bytes.equals(await fs.readFile(path.join(sample,'merged.png'))))throw new Error('Merged PNG bytes changed');
    const {src,...safe}=clipboard;
    reports.push({...safe,originalOnly,fileBytes:bytes.length,exactPngBytes:true});
  }
  let remaining;
  await waitFor(async()=>{remaining=await Promise.all(generated.map(filename=>fs.stat(filename).then(()=>true).catch(()=>false)));return generated.filter((filename,index)=>remaining[index]).filter((filename,index,all)=>all.indexOf(filename)===index).length<=3});
  if(new Set(generated).size!==4||new Set(generated.filter((filename,index)=>remaining[index])).size!==3||remaining[0]||!remaining.at(-1))throw new Error('Real cache file count is not bounded to 3 or current file deleted: '+JSON.stringify({remaining,leaves:generated.map(filename=>path.basename(filename)),cache:await evaluate(worker,"(async()=>{const saved=await chrome.storage.local.get('mergedClipboardFiles');return Promise.all(saved.mergedClipboardFiles.map(async file=>{const [item]=await chrome.downloads.search({id:file.id});return {id:file.id,same:!!item&&file.filename===item.filename,exists:item?.exists,state:item?.state}}))})()")}));
  await waitFor(async()=>{const saved=await evaluate(worker,"chrome.storage.local.get(['mergedClipboardFiles','activeMergedClipboardId'])");return saved.mergedClipboardFiles.length===3&&saved.activeMergedClipboardId===saved.mergedClipboardFiles.at(-1).id});
  console.log(JSON.stringify({actualExtensionMergedCopies:reports,createdFiles:new Set(generated).size,remainingByCopy:remaining,cacheFiles:new Set(generated.filter((filename,index)=>remaining[index])).size},null,2));
  await evaluate(worker,"(async()=>{const saved=await chrome.storage.local.get('mergedClipboardFiles');for(const file of saved.mergedClipboardFiles)await chrome.downloads.removeFile(file.id)})()");
  await control.call('Browser.close');
})().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>{sockets.forEach(socket=>socket.close());browser?.kill()});
setTimeout(()=>{browser?.kill();console.error('Merged file verification exceeded time limit');process.exit(1)},90000).unref();
