'use strict';
// Fixed, independent diagnostic candidates in one disposable installation. Always restore it.
const fs=require('node:fs/promises'),path=require('node:path'),{spawn}=require('node:child_process'),{createHash}=require('node:crypto');
const [install,out,tag,installerSha]=process.argv.slice(2),sha=data=>createHash('sha256').update(data).digest('hex');
const file=path.join(install,'resources','assets','office','helix-office-runner.exe'),manifestFile=path.join(path.dirname(file),'manifest.json');
const report={variant:'independent-office-ab-candidates',fullInstallerValidated:false,releaseTag:tag,installerSha256:installerSha,rounds:[],passed:false};
let original,manifestBytes;
async function run(command,args,env,directory,timeoutMs){
 await fs.mkdir(directory,{recursive:true});const started=Date.now();
 return await new Promise(resolve=>{
  const child=spawn(command,args,{env:{...process.env,...env},stdio:['ignore','pipe','pipe'],windowsHide:true});let output='';
  const capture=data=>{const text=data.toString();process.stdout.write(text);output=(output+text).slice(-1024*1024);};child.stdout.on('data',capture);child.stderr.on('data',capture);
  const timer=setTimeout(()=>{const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});killer.on('error',()=>child.kill());},timeoutMs);
  child.on('error',error=>{clearTimeout(timer);resolve({exitCode:null,error:error.message,elapsedMs:Date.now()-started});});
  child.on('close',async(exitCode,signal)=>{clearTimeout(timer);await fs.writeFile(path.join(directory,'console.log'),output);resolve({exitCode,signal,elapsedMs:Date.now()-started});});
 });
}
async function restore(){if(original)await fs.writeFile(file,original);if(manifestBytes)await fs.writeFile(manifestFile,manifestBytes);}
(async()=>{
 const config=JSON.parse(await fs.readFile(path.join(__dirname,'office-ab-validation.json'),'utf8'));
 if(config.schema!==1||tag!=='v0.3.19'||config.releaseTag!==tag||config.installerSha256!==installerSha)throw Error('A/B diagnostics require the exact original 0.3.19 installer');
 if(config.fixture.sha256!=='f8e66db3afd796567b4a6f3831e91b6611bf9e8df6887f5374a802e5358f29e5'||config.fixture.repoPath!=='.github/fixtures/helix-calc-input.xlsx')throw Error('A/B fixture is not the exact prior synthetic workbook');
 const fixture=path.resolve(config.fixture.repoPath);if(sha(await fs.readFile(fixture))!==config.fixture.sha256)throw Error('Synthetic workbook SHA-256 mismatch');
 original=await fs.readFile(file);manifestBytes=await fs.readFile(manifestFile);const manifest=JSON.parse(manifestBytes);
 if(sha(original)!==config.originalBrokerSha256||manifest.files?.['helix-office-runner.exe']?.sha256!==sha(original))throw Error('Original broker is not the exact baseline');
 const host=await fs.readFile(path.join(path.dirname(file),'LibreOffice','program','helix-office-converter.exe'));if(sha(host)!==config.unchangedHostSha256)throw Error('Original converter differs from the fixed baseline');
 const assets=path.join(out,'ab-assets');await fs.mkdir(assets,{recursive:true});
 const candidates=[];
 for(const item of [...config.brokers,config.server]){
  if(!/^Helix-(?:Office-Broker-Validation-0[67]|Server-Validation-01)\.bin$/.test(item.assetName)||!Number.isSafeInteger(item.bytes)||item.bytes<1||item.bytes>32*1024*1024||!/^[a-f0-9]{64}$/.test(item.sha256))throw Error('Candidate is not a fixed bounded diagnostic asset');
  const response=await fetch('https://github.com/aiximi/helix-bio-releases/releases/download/'+tag+'/'+item.assetName,{signal:AbortSignal.timeout(60000)});if(!response.ok)throw Error('Candidate download HTTP '+response.status);
  const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length!==item.bytes||sha(bytes)!==item.sha256)throw Error('Candidate bytes or SHA mismatch: '+item.assetName);
  const candidatePath=path.join(assets,item.assetName);await fs.writeFile(candidatePath,bytes);candidates.push({...item,bytesData:bytes,path:candidatePath});
 }
 const brokers=candidates.slice(0,-1),server=candidates.at(-1),exe=path.join(install,'Helix Bio.exe');
 if(brokers.length!==2||brokers[0].variant!=='A'||brokers[1].variant!=='B')throw Error('A/B candidates must be independent A then B');
 const native=path.join(__dirname,'office-native-preload.cjs'),serverPreload=path.join(__dirname,'server-candidate-preload.cjs');
 const observerEnv={HELIX_TEST_NATIVE_OBSERVER:path.join(__dirname,'observe-office-process.ps1'),HELIX_TEST_POWERSHELL:process.env.HELIX_TEST_POWERSHELL||'pwsh.exe'};
 const apply=async candidate=>{await restore();if(candidate){const updated=structuredClone(manifest);updated.files['helix-office-runner.exe']={...updated.files['helix-office-runner.exe'],sha256:candidate.sha256,bytes:candidate.bytesData.length};updated.totalBytes+=candidate.bytesData.length-original.length;await fs.writeFile(file,candidate.bytesData);await fs.writeFile(manifestFile,JSON.stringify(updated,null,2)+'\n');}};
 let selected=null;
 for(const candidate of [null,...brokers]){
  const variant=candidate?.variant||'baseline',roundOut=path.join(out,'calc-'+variant);await apply(candidate);
  console.log('Beginning isolated Calc round: '+variant);
  const execution=await run(exe,['--require',native,path.join(__dirname,'calc-round-probe.cjs'),install,roundOut,fixture,config.fixture.sha256,variant],{...observerEnv,ELECTRON_RUN_AS_NODE:'1',HELIX_NATIVE_DIAGNOSTIC_OUT:path.join(roundOut,'native')},roundOut,230000);
  const result=await fs.readFile(path.join(roundOut,'calc-result.json'),'utf8').then(JSON.parse).catch(error=>({passed:false,error:error.message}));report.rounds.push({variant,brokerSha256:candidate?.sha256||sha(original),...execution,result});await fs.writeFile(path.join(out,'office-ab-result.json'),JSON.stringify(report,null,2));
  if(candidate&&execution.exitCode===0&&result.passed===true){selected=candidate;break;}
 }
 await apply(selected);report.selectedVariant=selected?.variant||null;
 const finalOut=path.join(out,'candidate-functional');await fs.mkdir(finalOut,{recursive:true});
 const candidateEnv={...observerEnv,HELIX_NATIVE_DIAGNOSTIC_OUT:path.join(finalOut,'native'),HELIX_TEST_SERVER_CANDIDATE:server.path,HELIX_TEST_SERVER_SHA256:server.sha256,HELIX_TEST_SERVER_ORIGINAL_SHA256:server.originalSha256,HELIX_TEST_PACKAGE_VARIANT:'office-ab-candidate'};
 if(selected){
  console.log('Beginning complete installed synthetic functional validation with candidate '+selected.variant);
  const execution=await run(process.env.HELIX_TEST_POWERSHELL||'pwsh.exe',['-NoLogo','-NoProfile','-File',path.join(__dirname,'run-installed-validation.ps1'),'-Install',install,'-Out',finalOut,'-ReleaseTag',tag,'-InstallerSha256',installerSha],candidateEnv,finalOut,1200000);
  const result=await fs.readFile(path.join(finalOut,'installed-validation.json'),'utf8').then(JSON.parse).catch(error=>({passed:false,error:error.message}));report.functional={...execution,result};report.passed=execution.exitCode===0&&result.passed===true;
 }else{
  console.log('Both independent Calc candidates failed; preserving separate production Word/PPT preview scope.');
  report.independentPreviews=await run(exe,['--require',native,'--require',serverPreload,path.join(__dirname,'office-preview-probe.cjs'),install,finalOut,'--create-synthetic'],{...candidateEnv,ELECTRON_RUN_AS_NODE:'1'},finalOut,420000);
 }
 report.serverCandidateSha256=server.sha256;report.installedServerBytesModified=false;
})().catch(error=>{report.error=error.message;console.error(error.message);}).finally(async()=>{
 try{await restore();report.baselineRestored=!!original&&sha(await fs.readFile(file))===sha(original)&&Buffer.from(await fs.readFile(manifestFile)).equals(manifestBytes);if(!report.baselineRestored)report.passed=false;}catch(error){report.restoreError=error.message;report.passed=false;}
 await fs.mkdir(out,{recursive:true});await fs.writeFile(path.join(out,'office-ab-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));process.exitCode=report.passed?0:1;
});
