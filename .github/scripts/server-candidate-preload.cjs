'use strict';
// Exact compiled-server substitution for a disposable candidate test only.
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),{createHash}=require('node:crypto');
if(process.env.HELIX_TEST_SERVER_CANDIDATE){
 const file=process.env.HELIX_TEST_SERVER_CANDIDATE,expected=process.env.HELIX_TEST_SERVER_SHA256;
 if(!/^[a-f0-9]{64}$/.test(expected||''))throw Error('Candidate server requires an exact SHA-256');
 const bytes=fs.readFileSync(file);if(bytes.length>32*1024*1024||createHash('sha256').update(bytes).digest('hex')!==expected)throw Error('Compiled server candidate does not match its fixed SHA-256');
 const entry=path.join(path.dirname(process.execPath),'resources','app.asar','dist-server','index.cjs'),load=Module._extensions['.cjs']||Module._extensions['.js'];
 const originalSha=process.env.HELIX_TEST_SERVER_ORIGINAL_SHA256;if(!/^[a-f0-9]{64}$/.test(originalSha||'')||createHash('sha256').update(fs.readFileSync(entry)).digest('hex')!==originalSha)throw Error('Original installed server does not match the candidate baseline');
 const intercepted=function(module,filename){
  if(path.resolve(filename).toLowerCase()===path.resolve(entry).toLowerCase()){
   console.log('Using exact compiled server candidate SHA-256 '+expected);
   return module._compile(bytes.toString('utf8'),filename);
  }
  return load(module,filename);
 };
 Module._extensions['.cjs']=intercepted;
}
