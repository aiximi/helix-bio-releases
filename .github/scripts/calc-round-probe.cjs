'use strict';
// One fixed synthetic workbook through the installed production tool and its sandbox.
const fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict'),{createHash}=require('node:crypto');
const [install,out,fixture,expectedSha,variant]=process.argv.slice(2),hash=data=>createHash('sha256').update(data).digest('hex');
let backend,source,original,modelFailure,step=0,timer;
const report={variant,syntheticModelOnly:true,passed:false,startedAt:new Date().toISOString()};
const bounded=(p,ms,message)=>Promise.race([p,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(message)),ms);})]).finally(()=>clearTimeout(timer));
(async()=>{
 await fs.mkdir(out,{recursive:true});
 const resources=path.join(install,'resources'),appRoot=path.join(resources,'app.asar'),dataDir=path.join(out,'synthetic-workspace');
 original=await fs.readFile(fixture);assert.equal(hash(original),expectedSha,'Exact synthetic XLSX fixture SHA mismatch');report.inputSha256=hash(original);
 const output=path.join(dataDir,'artifacts','synthetic-calc');await fs.mkdir(output,{recursive:true});source=path.join(output,'固定 公式核对.xlsx');await fs.writeFile(source,original);
 process.env.HELIX_APP_ROOT=appRoot;process.env.HELIX_ASSETS_DIR=path.join(resources,'assets');process.env.HELIX_SKILLS_DIR=path.join(resources,'skills');process.env.HELIX_DATA_DIR=dataDir;process.env.HELIX_USER_DATA_DIR=path.join(out,'isolated-profile');
 const helpers=require(path.join(resources,'docs','verify-windows-installed.cjs')),XLSX=require(path.join(appRoot,'node_modules','xlsx'));
 const {startServer}=require(path.join(appRoot,'dist-server','index.cjs'));
 backend=await startServer(0,{appRoot,dataDir,deferReadingVerification:true,modelCall:async messages=>{
  try{
   step++;
   if(step===1)return {text:'',toolCalls:[{id:'synthetic-recalculate',name:'artifact_recalculate',arguments:{artifactId:'synthetic-input'}}]};
   assert.equal(step,2);const value=JSON.parse(messages.at(-1).content);if(value.error)throw Error(value.error);
   helpers.verifyCompleteCalculation(value.calculation,4);report.semanticChecks=helpers.verifyRecalculatedWorkbook(await fs.readFile(value.artifact.path),XLSX);report.calculation=value.calculation;report.outputSha256=hash(await fs.readFile(value.artifact.path));
   return {text:'合成公式结果已按实际保存值核对。',toolCalls:[]};
  }catch(error){modelFailure=error;throw error;}
 }});
 const at=new Date().toISOString(),task={id:'synthetic-calc',title:'合成公式诊断',prompt:'',status:'idle',source:'chat',permissionMode:'workspace',providerId:'deepseek',attachments:[],skillIds:[],messages:[],events:[],artifacts:[{id:'synthetic-input',name:path.basename(source),path:source,mime:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',bytes:original.length,createdAt:at}],approvals:[],createdAt:at,updatedAt:at};
 backend.store.setKey('deepseek','synthetic-local-only');backend.store.state.tasks.push(task);
 await backend.runtime.start(task,'仅重新计算当前合成工作簿，并核对实际保存的数值。');await bounded(backend.runtime.wait(task.id),180000,'Isolated Calc round exceeded 180 seconds');
 if(modelFailure)throw modelFailure;assert.equal(task.status,'completed',task.error);assert.equal(step,2);assert.equal(task.artifacts.length,2);report.passed=true;
})().catch(error=>{report.error=error.message;process.exitCode=1;}).finally(async()=>{
 if(source&&original){report.sourceUnchanged=hash(await fs.readFile(source))===hash(original);if(!report.sourceUnchanged)report.passed=false;}
 try{await bounded(Promise.resolve(backend?.close()),20000,'Calc diagnostic backend close timed out');}catch(error){report.closeError=error.message;report.passed=false;setTimeout(()=>process.exit(1),1000);}
 report.completedAt=new Date().toISOString();await fs.mkdir(out,{recursive:true});await fs.writeFile(path.join(out,'calc-result.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));process.exitCode=report.passed?0:1;
});
