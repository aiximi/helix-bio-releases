'use strict';
// Read-only observations in a disposable runner containing synthetic documents.
const fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),cp=require('node:child_process');
const out=process.env.HELIX_NATIVE_DIAGNOSTIC_OUT;
if(!out)throw Error('Native diagnostics require an explicit isolated evidence directory');
fs.mkdirSync(out,{recursive:true});
const log=(event,data={})=>{try{fs.appendFileSync(path.join(out,'office-native.jsonl'),JSON.stringify({at:new Date().toISOString(),event,...data})+'\n');}catch{}};
const originalSpawn=cp.spawn;
function syntheticStage(stage){
 const inspection={cwd:typeof stage==='string'?stage:null,tempRoot:os.tmpdir(),accepted:false};
 try{
  if(typeof stage!=='string')throw Error('Spawn cwd is not a string');
  inspection.canonicalCwd=fs.realpathSync(stage);
  inspection.canonicalTempRoot=fs.realpathSync(inspection.tempRoot);
  const same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
  if(!same(path.dirname(inspection.canonicalCwd),inspection.canonicalTempRoot))throw Error('Spawn cwd is not a direct child of the canonical temporary directory');
  if(!/^hx-(?:office|calc)-[^\\/]+$/.test(path.basename(inspection.canonicalCwd)))throw Error('Spawn cwd is not an allowlisted synthetic Office directory');
  if(!fs.lstatSync(inspection.canonicalCwd).isDirectory())throw Error('Spawn cwd is not a directory');
  inspection.accepted=true;
 }catch(error){inspection.reason=error.message;}
 return inspection;
}
async function snapshotProfile(stage,pid,seconds){
 if(!syntheticStage(stage).accepted)return;
 const source=path.join(stage,'profile'),target=path.join(out,'profile-'+pid+'-'+seconds);let files=0,bytes=0;const errors=[];
 async function visit(dir,relative=''){
  const info=await fsp.lstat(dir);if(!info.isDirectory()||info.isSymbolicLink())return;
  const entries=await fsp.readdir(dir,{withFileTypes:true});
  for(const entry of entries){
   if(files>=1000||bytes>=32*1024*1024)return;
   if(entry.isSymbolicLink())continue;
   const from=path.join(dir,entry.name),rel=path.join(relative,entry.name);
   try{
    if(entry.isDirectory()){await visit(from,rel);continue;}
    const stat=await fsp.lstat(from);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024||bytes+stat.size>32*1024*1024)continue;
    await fsp.mkdir(path.dirname(path.join(target,rel)),{recursive:true});await fsp.copyFile(from,path.join(target,rel));files++;bytes+=stat.size;
   }catch(error){if(errors.length<20)errors.push({path:rel,error:error.message});}
  }
 }
 try{await visit(source);}catch(error){errors.push({error:error.message});}
 log('profile-snapshot',{pid,seconds,files,bytes,errors});
}
cp.spawn=function(command,args,options){
 const child=originalSpawn.apply(this,arguments);
 if(!String(command).toLowerCase().endsWith('helix-office-runner.exe'))return child;
 const inspected=syntheticStage(options?.cwd),stage=inspected.accepted?inspected.canonicalCwd:null;let stdout='',stderr='';const timers=[];
 log('office-start',{pid:child.pid,command:String(command),staging:stage,stagingInspection:inspected});
 child.stdout?.on('data',chunk=>{stdout=(stdout+chunk.toString()).slice(0,65536);});
 child.stderr?.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(0,65536);});
 child.on('error',error=>log('office-error',{pid:child.pid,error:error.message}));
 if(stage&&process.env.HELIX_TEST_NATIVE_OBSERVER&&process.env.HELIX_TEST_POWERSHELL){
  for(const seconds of [15,45,110])timers.push(setTimeout(()=>{
   void snapshotProfile(stage,child.pid,seconds);
   const destination=path.join(out,'office-observation-'+child.pid+'-'+seconds+'.json');
   const probe=originalSpawn(process.env.HELIX_TEST_POWERSHELL,['-NoLogo','-NoProfile','-NonInteractive','-File',process.env.HELIX_TEST_NATIVE_OBSERVER,'-Out',destination,'-Staging',stage,'-BrokerPid',String(child.pid),'-Elapsed',String(seconds)],{stdio:['ignore','ignore','pipe'],windowsHide:true});
   let error='';probe.stderr?.on('data',chunk=>error=(error+chunk).slice(0,2048));
   const deadline=setTimeout(()=>probe.kill('SIGKILL'),10000);
   probe.on('error',e=>log('observation-error',{error:e.message}));
   probe.on('close',code=>{clearTimeout(deadline);log('observation-completed',{pid:child.pid,seconds,code,error});});
  },seconds*1000));
 }
 child.on('close',(code,signal)=>{for(const timer of timers)clearTimeout(timer);log('office-exit',{pid:child.pid,code,signal,stdout,stderr});});
 return child;
};
log('preload-ready',{platform:process.platform,electron:process.versions.electron,node:process.versions.node});
