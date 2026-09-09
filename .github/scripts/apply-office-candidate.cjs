'use strict';
// Optional isolated-runner diagnostic patch. This never changes a published installer.
const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash}=require('node:crypto');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function applyCandidate({install,out,releaseTag,installerSha256,manifest,download=async url=>{
  const response=await fetch(url,{signal:AbortSignal.timeout(60000)});
  if(!response.ok)throw Error('Candidate download failed (HTTP '+response.status+')');
  const bytes=Buffer.from(await response.arrayBuffer());
  if(bytes.length>10*1024*1024)throw Error('Candidate broker exceeds diagnostic size limit');
  return bytes;
}}){
  if(manifest.schema!==1||manifest.releaseTag!==releaseTag||manifest.installerSha256!==installerSha256)throw Error('Candidate manifest does not match the installed release');
  if(!/^v\d+\.\d+\.\d+$/.test(releaseTag)||!/^Helix-Bio-Office-Broker-Candidate-[A-Za-z0-9.-]+\.exe$/.test(manifest.assetName))throw Error('Candidate release or asset name is invalid');
  for(const key of ['sha256','expectedOriginalSha256'])if(!/^[a-f0-9]{64}$/.test(manifest[key]))throw Error('Candidate manifest requires exact SHA-256 values');
  const office=path.join(install,'resources','assets','office');
  const broker=path.join(office,'helix-office-runner.exe');
  const manifestFile=path.join(office,'manifest.json');
  const original=await fs.readFile(broker);const originalManifestBytes=await fs.readFile(manifestFile);const originalManifest=JSON.parse(originalManifestBytes);
  const oldRecord=originalManifest.files?.['helix-office-runner.exe'];
  if(sha(original)!==manifest.expectedOriginalSha256||oldRecord?.sha256!==sha(original)||oldRecord.bytes!==original.length)throw Error('Original broker does not match the verified installer manifest');
  const url='https://github.com/aiximi/helix-bio-releases/releases/download/'+releaseTag+'/'+manifest.assetName;
  const candidate=await download(url);
  if(sha(candidate)!==manifest.sha256)throw Error('Candidate broker SHA-256 mismatch');
  const pe=candidate.length>64?candidate.readUInt32LE(0x3c):candidate.length;
  if(candidate.toString('ascii',0,2)!=='MZ'||pe+26>candidate.length||candidate.readUInt32LE(pe)!==0x4550||candidate.readUInt16LE(pe+4)!==0x8664||candidate.readUInt16LE(pe+24)!==0x20b)throw Error('Candidate broker must be a Windows x64 executable');
  const backup=path.join(out,'candidate-baseline');await fs.mkdir(backup,{recursive:true});
  await fs.writeFile(path.join(backup,'helix-office-runner.exe'),original,{flag:'wx'});
  await fs.writeFile(path.join(backup,'office-manifest.json'),originalManifestBytes,{flag:'wx'});
  const updated=structuredClone(originalManifest);
  updated.files['helix-office-runner.exe']={...oldRecord,sha256:manifest.sha256,bytes:candidate.length};
  if(typeof updated.totalBytes!=='number')throw Error('Office manifest totalBytes is missing');
  updated.totalBytes+=candidate.length-original.length;
  await fs.writeFile(broker,candidate);await fs.writeFile(manifestFile,JSON.stringify(updated,null,2)+'\n');
  const evidence={variant:'isolated-office-broker-candidate',fullInstallerValidated:false,releaseTag,installerSha256,assetName:manifest.assetName,candidateSha256:manifest.sha256,originalSha256:sha(original),originalBytes:original.length,candidateBytes:candidate.length,scope:'Only the disposable installed Office broker and its corresponding manifest record were changed. This is not acceptance of a rebuilt installer.'};
  await fs.writeFile(path.join(out,'package-variant.json'),JSON.stringify(evidence,null,2));
  return evidence;
}
module.exports={applyCandidate};
if(require.main===module){
  const [install,out,releaseTag,installerSha256]=process.argv.slice(2);
  fs.readFile(path.join(__dirname,'office-broker-candidate.json'),'utf8').then(JSON.parse).then(manifest=>applyCandidate({install,out,releaseTag,installerSha256,manifest})).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
