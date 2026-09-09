'use strict';
// Observes an installed app on a disposable GitHub Windows runner. Does not change app security settings.
const fs = require('node:fs');
const path = require('node:path');
const {spawn} = require('node:child_process');
const out = process.env.HELIX_TEST_OUT;
const exe = process.env.HELIX_TEST_EXE;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const record = (name,value) => fs.writeFileSync(path.join(out,name),JSON.stringify(value,null,2));
const events = [];
class CDP {
  constructor(url) {
    this.pending = new Map(); this.listeners = []; this.nextId=1;
    this.socket=new WebSocket(url);
    this.ready=new Promise((resolve,reject)=>{this.socket.addEventListener('open',resolve,{once:true});this.socket.addEventListener('error',reject,{once:true});});
    this.socket.addEventListener('message',event=>{
      const message=JSON.parse(event.data);
      if(message.id){const pending=this.pending.get(message.id);if(pending){clearTimeout(pending.timer);this.pending.delete(message.id);message.error?pending.reject(new Error(JSON.stringify(message.error))):pending.resolve(message.result);}}
      else {for(const listener of this.listeners)listener(message);}
    });
  }
  async call(method,params={}) {await this.ready;const id=this.nextId++;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('CDP timeout: '+method));},10000);this.pending.set(id,{resolve,reject,timer});this.socket.send(JSON.stringify({id,method,params}));});}
  close(){this.socket.close();}
}
async function endpoint(port,attempts=80) {
  for(let i=0;i<attempts;i++){try{const response=await fetch('http://127.0.0.1:'+port+'/json/list');if(response.ok){const targets=await response.json();if(targets.length)return targets;}}catch{}await wait(250);}
  throw new Error('No inspector targets on port '+port);
}
async function readCapabilities(baseUrl,{timeoutMs=480000,intervalMs=5000}={}) {
  const base=new URL(baseUrl);
  if(base.protocol!=='http:'||base.hostname!=='127.0.0.1')throw new Error('Reading validation requires the isolated local app origin');
  const sessionResponse=await fetch(new URL('/api/session',base),{signal:AbortSignal.timeout(5000)});
  if(!sessionResponse.ok)throw new Error('Validation session request failed (HTTP '+sessionResponse.status+')');
  const session=await sessionResponse.json();
  if(typeof session.token!=='string'||!session.token)throw new Error('Validation session response did not contain a token');
  // The disposable workspace token stays in memory and is never written to evidence.
  const headers={'x-helix-token':session.token};
  const deadline=Date.now()+timeoutMs;const polls=[];let reading;
  do {
    const response=await fetch(new URL('/api/reading-capabilities',base),{headers,signal:AbortSignal.timeout(Math.max(1,Math.min(5000,deadline-Date.now())))});
    if(response.status===401||response.status===403)throw new Error('Validation authentication failed (HTTP '+response.status+'); component readiness was not evaluated');
    if(!response.ok)throw new Error('Reading validation request failed (HTTP '+response.status+')');
    reading=await response.json();
    polls.push({at:new Date().toISOString(),...reading});
    if(reading.verification==='execution')break;
    await wait(Math.max(0,Math.min(intervalMs,deadline-Date.now())));
  } while(Date.now()<deadline);
  return {ready:reading?.verification==='execution'&&reading?.ready===true,last:reading,polls};
}
async function observe(){
  const stdout=fs.openSync(path.join(out,'observed-stdout.log'),'w');
  const stderr=fs.openSync(path.join(out,'observed-stderr.log'),'w');
  const child=spawn(exe,[...(process.env.HELIX_TEST_MODE==='compatibility'?['--helix-software-rendering']:[]),'--inspect-brk=9333','--remote-debugging-port=9222','--enable-logging','--log-file='+path.join(out,'chromium.log')],{stdio:['ignore',stdout,stderr],env:process.env});
  child.on('exit',(code,signal)=>{events.push({at:new Date().toISOString(),method:'app-process-exit',code,signal});record('observer-events.json',events);});
  let main;
  try {
    const [target]=await endpoint(9333);
    main=new CDP(target.webSocketDebuggerUrl);
    await main.call('Runtime.enable');
    await main.call('Debugger.enable');
    let pausedResolve;
    const paused=new Promise(resolve=>{pausedResolve=resolve;});
    main.listeners.push(message=>{if(message.method==='Debugger.paused')pausedResolve(message.params);if(message.method==='Runtime.exceptionThrown')events.push(message);});
    await main.call('Runtime.runIfWaitingForDebugger');
    const pause=await Promise.race([paused,wait(12000).then(()=>null)]);
    if(pause?.callFrames?.length){
      const expression=`(()=>{
        const electron=require('electron');const fs=require('node:fs');const path=require('node:path');
        const target=path.join(process.env.HELIX_TEST_OUT,'main-lifecycle.jsonl');
        const log=(event,data={})=>{try{fs.appendFileSync(target,JSON.stringify({at:new Date().toISOString(),event,...data})+'\\n');}catch{}};
        log('observer-installed',{versions:process.versions,softwareRenderingRequested:process.argv.includes('--helix-software-rendering')});
        const cp=require('node:child_process');const originalSpawn=cp.spawn;
        cp.spawn=function(command,args,options){
          const child=originalSpawn.apply(this,arguments);let stderr='';
          log('native-process-start',{pid:child.pid,command:String(command)});
          child.stderr?.on('data',chunk=>{if(stderr.length<16384)stderr+=chunk.toString().slice(0,16384-stderr.length);});
          child.on('error',error=>log('native-process-error',{pid:child.pid,command:String(command),message:error.message}));
          const observationTimers=[];
          if(String(command).toLowerCase().endsWith('helix-office-runner.exe')&&options?.cwd&&process.env.HELIX_TEST_NATIVE_OBSERVER&&process.env.HELIX_TEST_MODE!=='compatibility'){
            for(const seconds of [15,45,110])observationTimers.push(setTimeout(()=>{
              const destination=path.join(process.env.HELIX_TEST_OUT,'office-observation-'+child.pid+'-'+seconds+'.json');
              const probe=originalSpawn(process.env.HELIX_TEST_POWERSHELL,['-NoLogo','-NoProfile','-NonInteractive','-File',process.env.HELIX_TEST_NATIVE_OBSERVER,'-Out',destination,'-Staging',options.cwd,'-BrokerPid',String(child.pid),'-Elapsed',String(seconds)],{stdio:['ignore','ignore','pipe'],windowsHide:true});
              let probeError='';probe.stderr?.on('data',chunk=>{if(probeError.length<1024)probeError+=chunk.toString().slice(0,1024-probeError.length);});
              const timer=setTimeout(()=>probe.kill('SIGKILL'),8000);
              probe.on('error',error=>log('office-observation-error',{message:error.message}));
              probe.on('close',code=>{clearTimeout(timer);log('office-observation-completed',{code,seconds,error:probeError});});
            },seconds*1000));
          }
          child.on('close',(code,signal)=>{for(const timer of observationTimers)clearTimeout(timer);log('native-process-exit',{pid:child.pid,command:String(command),code,signal,stderr});});
          return child;
        };
        const original=electron.dialog.showErrorBox;
        electron.dialog.showErrorBox=function(title,content){log('showErrorBox',{title,content});return original.apply(this,arguments);};
        electron.app.on('child-process-gone',(_event,details)=>log('child-process-gone',details));
        electron.app.once('gpu-info-update',()=>{log('gpu-feature-status',electron.app.getGPUFeatureStatus());electron.app.getGPUInfo('basic').then(info=>log('gpu-info',info)).catch(error=>log('gpu-info-error',{message:error.message}));});
        electron.app.on('browser-window-created',(_event,window)=>{
          window.once('ready-to-show',()=>log('ready-to-show'));
          const wc=window.webContents;log('browser-window-created',{id:wc.id,preferences:wc.getLastWebPreferences()});
          wc.on('render-process-gone',(_event,details)=>log('render-process-gone',details));
          wc.on('did-fail-load',(_event,errorCode,errorDescription,validatedURL,isMainFrame)=>log('did-fail-load',{errorCode,errorDescription,validatedURL,isMainFrame}));
          wc.on('did-fail-provisional-load',(_event,errorCode,errorDescription,validatedURL,isMainFrame)=>log('did-fail-provisional-load',{errorCode,errorDescription,validatedURL,isMainFrame}));
          for(const event of ['did-start-loading','did-stop-loading','dom-ready','did-finish-load','unresponsive','destroyed'])wc.on(event,()=>log(event));
          wc.on('console-message',(_event,level,message,line,sourceId)=>log('console-message',{level,message,line,sourceId}));
        });
        return 'observer-installed';
      })()`;
      const result=await main.call('Debugger.evaluateOnCallFrame',{callFrameId:pause.callFrames[0].callFrameId,expression,returnByValue:true});
      record('observer-injection.json',result);
      await main.call('Debugger.resume');
    } else {record('observer-injection.json',{error:'Main process did not pause before entry'});}
    // Stop pausing on exceptions: observation must not prevent normal startup or hide failures.
    await main.call('Debugger.disable');
    await wait(18000);
    const targets=await endpoint(9222,30);
    record('renderer-targets.json',targets);
    const page=targets.find(target=>target.type==='page'&&target.url.startsWith('http://127.0.0.1:'))||targets.find(target=>target.type==='page');
    if(!page)throw new Error('No renderer page target');
    const renderer=new CDP(page.webSocketDebuggerUrl);
    renderer.listeners.push(message=>{if(['Runtime.exceptionThrown','Inspector.targetCrashed','Page.frameStoppedLoading','Page.loadEventFired'].includes(message.method))events.push(message);});
    await renderer.call('Runtime.enable');await renderer.call('Page.enable');
    const state=await renderer.call('Runtime.evaluate',{expression:'JSON.stringify({url:location.href,title:document.title,readyState:document.readyState,text:document.body?.innerText,buttons:[...document.querySelectorAll("button")].map(b=>({text:b.innerText,label:b.getAttribute("aria-label"),title:b.title})),inputs:[...document.querySelectorAll("textarea,input,[contenteditable=true]")].map(e=>({tag:e.tagName,placeholder:e.getAttribute("placeholder")}))})',returnByValue:true});
    const parsed=JSON.parse(state.result.value);record('renderer-dom.json',parsed);
    const shot=await renderer.call('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'renderer.png'),Buffer.from(shot.data,'base64'));
    let accepted=Boolean(parsed.text?.includes('新对话')&&parsed.text?.includes('资料库'));
    if(accepted){
      const click=await renderer.call('Runtime.evaluate',{expression:'(()=>{const b=[...document.querySelectorAll("button")].find(b=>(b.innerText+" "+(b.getAttribute("aria-label")||"")).trim()==="资料库");if(b){b.click();return true;}return false;})()',returnByValue:true});
      await wait(1500);
      const library=await renderer.call('Runtime.evaluate',{expression:'JSON.stringify({text:document.body.innerText})',returnByValue:true});
      const libraryState=JSON.parse(library.result.value);record('library-dom.json',{clicked:click.result.value,...libraryState});
      const newChat=await renderer.call('Runtime.evaluate',{expression:'(()=>{const b=[...document.querySelectorAll("button")].find(b=>(b.innerText+" "+(b.getAttribute("aria-label")||"")).trim()==="新对话");if(b){b.click();return true;}return false;})()',returnByValue:true});
      await wait(1500);
      const chat=await renderer.call('Runtime.evaluate',{expression:'JSON.stringify({text:document.body.innerText,composer:!!document.querySelector("textarea,[contenteditable=true]")})',returnByValue:true});
      const chatState=JSON.parse(chat.result.value);record('new-chat-dom.json',{clicked:newChat.result.value,...chatState});
      accepted=accepted&&Boolean(click.result.value)&&Boolean(newChat.result.value)&&chatState.composer;
    }
    record('acceptance.json',{accepted,criterion:'Fresh installed app renders its UI; library and new chat open and a message composer exists. No model requests are made.',observedWithSecurityOverrides:false});
    if(accepted&&process.env.HELIX_TEST_MODE!=='compatibility'){
      try {
        const reading=await readCapabilities(parsed.url);
        record('reading-capabilities.json',reading);
        console.log('Reading component verification: '+JSON.stringify(reading.last));
        if(!reading.ready)process.exitCode=2;
      } catch(error) {
        record('reading-capabilities.json',{ready:false,validationError:error.message});
        process.exitCode=2;
      }
    }
    renderer.close();
    if(!accepted)process.exitCode=1;
  }catch(error){record('observer-error.json',{message:error.message,stack:error.stack});process.exitCode=1;}
  finally {record('observer-events.json',events);main?.close();}
  // PowerShell captures the actual desktop and error dialogs before ending this isolated app process.
  setTimeout(()=>process.exit(process.exitCode||0),500);
}
module.exports={readCapabilities};
if(require.main===module)observe().catch(error=>{record('fatal-error.json',{message:error.message,stack:error.stack});process.exit(1);});
