'use strict';
// Reuse only the failed synthetic self-test workspace and the installed product APIs.
const fs=require('node:fs/promises'),path=require('node:path'),{createHash}=require('node:crypto');
const [install,out]=process.argv.slice(2),hash=bytes=>createHash('sha256').update(bytes).digest('hex');
let backend;
(async()=>{
 const runs=await fs.readdir(path.join(out,'installed-functions'),{withFileTypes:true});
 const dirs=runs.filter(item=>item.isDirectory()&&item.name.startsWith('中文 路径验收 '));if(dirs.length!==1)throw Error('Preview diagnostics require exactly one synthetic self-test directory');
 const run=path.join(out,'installed-functions',dirs[0].name),dataDir=path.join(run,'独立工作区'),resources=path.join(install,'resources'),appRoot=path.join(resources,'app.asar');
 process.env.HELIX_APP_ROOT=appRoot;process.env.HELIX_ASSETS_DIR=path.join(resources,'assets');process.env.HELIX_SKILLS_DIR=path.join(resources,'skills');process.env.HELIX_DATA_DIR=dataDir;process.env.HELIX_USER_DATA_DIR=path.join(run,'隔离应用配置');
 const {startServer}=require(path.join(appRoot,'dist-server','index.cjs'));
 backend=await startServer(0,{appRoot,dataDir,deferReadingVerification:true,modelCall:async()=>{throw Error('Preview diagnostics must not request a model');}});
 const task=backend.store.state.tasks.find(task=>task.id==='windows-installed-core');
 const artifacts=task?.artifacts.filter(item=>/\.(docx|pptx)$/.test(item.name))||[];if(artifacts.length!==2)throw Error('Expected the exact synthetic Word and PPT artifacts');
 const origin='http://127.0.0.1:'+backend.port,results=[];
 for(const artifact of artifacts){
  const relative=path.relative(dataDir,artifact.path);if(relative.startsWith('..')||path.isAbsolute(relative))throw Error('Synthetic artifact escaped its test workspace');
  const before=hash(await fs.readFile(artifact.path));const result={name:artifact.name};
  console.log('Testing installed preview: '+artifact.name);
  try{
   const response=await fetch(origin+'/api/files/preview',{method:'POST',headers:{'Content-Type':'application/json','x-helix-token':backend.token},body:JSON.stringify({artifactId:artifact.id}),signal:AbortSignal.timeout(160000)});
   const preview=await response.json();if(!response.ok)throw Error(preview.error||'Preview request failed');if(preview.kind!=='pdf')throw Error('Preview did not produce an actual PDF');
   const url=new URL(preview.contentUrl,origin);if(url.origin!==origin)throw Error('Preview download left the isolated local backend');
   const file=await fetch(url,{signal:AbortSignal.timeout(10000)});const bytes=Buffer.from(await file.arrayBuffer());if(!file.ok||bytes.subarray(0,5).toString()!=='%PDF-')throw Error('Preview PDF was not readable');
   const saved=artifact.name+'.预览.pdf';await fs.writeFile(path.join(out,saved),bytes);Object.assign(result,{passed:true,pdfName:saved,pdfBytes:bytes.length,pdfSha256:hash(bytes)});
  }catch(error){result.passed=false;result.error=error.message;}
  result.sourceUnchanged=hash(await fs.readFile(artifact.path))===before;if(!result.sourceUnchanged)result.passed=false;
  results.push(result);await fs.writeFile(path.join(out,'independent-office-previews.json'),JSON.stringify({variant:'independent-original-installer-previews',doesNotOverrideXlsxFailure:true,results},null,2));console.log(JSON.stringify(result));
 }
 if(!results.every(item=>item.passed))process.exitCode=1;
})().catch(error=>{console.error(error.message);process.exitCode=1;}).finally(async()=>{
 if(!backend)return;
 let timer;
 try{await Promise.race([backend.close(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Preview backend close exceeded 20 seconds')),20000);})]);}
 catch(error){console.error(error.message);process.exitCode=1;setTimeout(()=>process.exit(1),1000);}
 finally{clearTimeout(timer);}
});
