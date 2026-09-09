'use strict';
// Optional isolated-runner diagnostic patch. This never changes a published installer.
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {createHash}=require('node:crypto');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function validatePe(bytes,expected){
  if(sha(bytes)!==expected)throw Error('Candidate executable SHA-256 mismatch');
  const pe=bytes.length>64?bytes.readUInt32LE(0x3c):bytes.length;
  if(bytes.length>10*1024*1024||bytes.toString('ascii',0,2)!=='MZ'||pe+26>bytes.length||bytes.readUInt32LE(pe)!==0x4550||bytes.readUInt16LE(pe+4)!==0x8664||bytes.readUInt16LE(pe+24)!==0x20b)throw Error('Candidate must be a bounded Windows x64 executable');
}
async function runAccessProbe({broker,appRoot,probe,stage}){
  if(process.platform!=='win32')throw Error('Native AppContainer preflight requires Windows');
  const env={};for(const key of ['SystemRoot','WINDIR','TEMP','TMP'])if(process.env[key])env[key]=process.env[key];
  return await new Promise(resolve=>{
    const started=Date.now(),child=spawn(broker,[appRoot,stage,probe,appRoot,stage],{cwd:stage,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='',timedOut=false,killTimer;
    child.stdout.on('data',data=>stdout=(stdout+data).slice(0,65536));
    child.stderr.on('data',data=>stderr=(stderr+data).slice(0,65536));
    const timer=setTimeout(()=>{timedOut=true;child.stdin.end();killTimer=setTimeout(()=>child.kill(),5000);},30000);
    child.stdin.on('error',()=>{}); // Keep cancellation input open until exit or our deadline.
    child.on('error',error=>{clearTimeout(timer);clearTimeout(killTimer);resolve({exitCode:null,elapsedMs:Date.now()-started,timedOut,error:error.message,stdout,stderr});});
    child.on('close',(exitCode,signal)=>{clearTimeout(timer);clearTimeout(killTimer);resolve({exitCode,signal,elapsedMs:Date.now()-started,timedOut,stdout,stderr});});
  });
}
async function applyCandidate({install,out,releaseTag,installerSha256,manifest,executeProbe=runAccessProbe,download=async url=>{
  const response=await fetch(url,{signal:AbortSignal.timeout(60000)});
  if(!response.ok)throw Error('Candidate download failed (HTTP '+response.status+')');
  const bytes=Buffer.from(await response.arrayBuffer());
  if(bytes.length>10*1024*1024)throw Error('Candidate exceeds diagnostic size limit');
  return bytes;
}}){
  if(manifest.schema!==1||manifest.releaseTag!==releaseTag||manifest.installerSha256!==installerSha256)throw Error('Candidate manifest does not match the installed release');
  if(!/^v\d+\.\d+\.\d+$/.test(releaseTag)||!/^Helix-Office-Broker-Validation-[0-9]{2}\.bin$/.test(manifest.assetName))throw Error('Candidate release or asset name is invalid');
  for(const key of ['sha256','expectedOriginalSha256'])if(!/^[a-f0-9]{64}$/.test(manifest[key]))throw Error('Candidate manifest requires exact SHA-256 values');
  if(manifest.converter&&(!/^Helix-Office-Converter-Validation-[0-9]{2}\.bin$/.test(manifest.converter.assetName)||!/^[a-f0-9]{64}$/.test(manifest.converter.sha256)))throw Error('Candidate converter must name an exact asset and SHA-256');
  if(manifest.preflight&&(!manifest.converter||!/^Helix-Office-Broker-Validation-[0-9]{2}\.bin$/.test(manifest.preflight.beforeBroker?.assetName)||!/^Helix-Office-Access-Validation-[0-9]{2}\.bin$/.test(manifest.preflight.probe?.assetName)||![manifest.preflight.beforeBroker,manifest.preflight.probe].every(item=>/^[a-f0-9]{64}$/.test(item.sha256))))throw Error('Preflight requires exact fixed broker and access-probe assets');
  const office=path.join(install,'resources','assets','office');
  const broker=path.join(office,'helix-office-runner.exe');
  const converterRelative='LibreOffice/program/helix-office-converter.exe';
  const converterFile=path.join(office,...converterRelative.split('/'));
  const manifestFile=path.join(office,'manifest.json');
  const original=await fs.readFile(broker);const originalManifestBytes=await fs.readFile(manifestFile);const originalManifest=JSON.parse(originalManifestBytes);
  const oldRecord=originalManifest.files?.['helix-office-runner.exe'];
  if(sha(original)!==manifest.expectedOriginalSha256||oldRecord?.sha256!==sha(original)||oldRecord.bytes!==original.length)throw Error('Original broker does not match the verified installer manifest');
  if(typeof originalManifest.totalBytes!=='number')throw Error('Office manifest totalBytes is missing');
  const assetUrl=name=>'https://github.com/aiximi/helix-bio-releases/releases/download/'+releaseTag+'/'+name;
  const candidate=await download(assetUrl(manifest.assetName));validatePe(candidate,manifest.sha256);
  let converter;
  if(manifest.converter){
    if(originalManifest.files[converterRelative]||await fs.stat(converterFile).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;}))throw Error('Converter candidate must be a new file in the verified baseline');
    converter=await download(assetUrl(manifest.converter.assetName));validatePe(converter,manifest.converter.sha256);
  }
  let beforeBroker,probe;
  if(manifest.preflight){
    beforeBroker=await download(assetUrl(manifest.preflight.beforeBroker.assetName));validatePe(beforeBroker,manifest.preflight.beforeBroker.sha256);
    probe=await download(assetUrl(manifest.preflight.probe.assetName));validatePe(probe,manifest.preflight.probe.sha256);
  }
  // All downloads and hashes must pass before the first installed-file mutation.
  const backup=path.join(out,'candidate-baseline');await fs.mkdir(backup,{recursive:true});
  await fs.writeFile(path.join(backup,'helix-office-runner.exe'),original,{flag:'wx'});
  await fs.writeFile(path.join(backup,'office-manifest.json'),originalManifestBytes,{flag:'wx'});
  if(probe){
    const beforeFile=path.join(backup,'before-preflight-broker.exe');await fs.writeFile(beforeFile,beforeBroker,{flag:'wx'});
    const results=[];let probeWritten=false;
    try{
      await fs.writeFile(converterFile,probe,{flag:'wx'});probeWritten=true;
      for(const phase of ['before','after']){
        if(phase==='after')await fs.writeFile(broker,candidate);
        const stage=await fs.mkdtemp(path.join(os.tmpdir(),'hx-office-access-'));
        let result;
        try{result=await executeProbe({broker:phase==='before'?beforeFile:broker,appRoot:path.join(office,'LibreOffice'),probe:converterFile,stage});}
        catch(error){result={exitCode:null,error:error.message};}
        finally{await fs.rm(stage,{recursive:true,force:true}).catch(()=>{});}
        results.push({phase,brokerSha256:phase==='before'?sha(beforeBroker):sha(candidate),probeSha256:sha(probe),...result});
        await fs.writeFile(path.join(out,'office-access-preflight.json'),JSON.stringify(results,null,2));
        if(result.exitCode!==0||result.timedOut||!result.stdout?.includes('"appContainer":true'))throw Error('AppContainer access preflight did not complete: '+phase);
      }
    }finally{
      await fs.writeFile(broker,original);
      if(probeWritten){
        if(sha(await fs.readFile(converterFile))!==sha(probe))throw Error('Preflight executable changed unexpectedly; refusing removal');
        await fs.unlink(converterFile);
      }
    }
    if(sha(await fs.readFile(broker))!==sha(original)||!Buffer.from(await fs.readFile(manifestFile)).equals(originalManifestBytes))throw Error('Preflight did not restore the verified baseline');
  }
  const updated=structuredClone(originalManifest);
  updated.files['helix-office-runner.exe']={...oldRecord,sha256:manifest.sha256,bytes:candidate.length};
  updated.totalBytes+=candidate.length-original.length;
  if(converter){updated.files[converterRelative]={sha256:manifest.converter.sha256,bytes:converter.length};updated.totalBytes+=converter.length;}
  await fs.writeFile(broker,candidate);
  if(converter)await fs.writeFile(converterFile,converter,{flag:'wx'});
  await fs.writeFile(manifestFile,JSON.stringify(updated,null,2)+'\n');
  const evidence={variant:'isolated-office-candidate',fullInstallerValidated:false,releaseTag,installerSha256,assetName:manifest.assetName,candidateSha256:manifest.sha256,originalSha256:sha(original),originalBytes:original.length,candidateBytes:candidate.length,...converter?{converter:{assetName:manifest.converter.assetName,sha256:manifest.converter.sha256,path:converterRelative,bytes:converter.length}}:{},scope:'Only the disposable installed Office broker, optional fixed converter executable, and their matching manifest records were changed. This is not acceptance of a rebuilt installer.'};
  await fs.writeFile(path.join(out,'package-variant.json'),JSON.stringify(evidence,null,2));
  return evidence;
}
module.exports={applyCandidate};
if(require.main===module){
  const [install,out,releaseTag,installerSha256]=process.argv.slice(2);
  fs.readFile(path.join(__dirname,'office-broker-candidate.json'),'utf8').then(JSON.parse).then(manifest=>applyCandidate({install,out,releaseTag,installerSha256,manifest})).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
