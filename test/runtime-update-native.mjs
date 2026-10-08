// Explicit macOS probe. All stores, runtimes and launchd jobs are disposable.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:net';
import {request} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {copyRuntime,prepareRuntime} from '../lib/runtime-package.mjs';
const run=promisify(execFile),root=fileURLToPath(new URL('../',import.meta.url));
if(process.platform!=='darwin')throw Error('This probe requires launchd on macOS.');
const base=await mkdtemp(join(tmpdir(),'chill-native-update-')),data=join(base,'data');
const port=await new Promise(resolve=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const n=s.address().port;s.close(()=>resolve(n));});});
const env={...process.env,CHILL_AGENT_DATA_DIR:data,PORT:String(port),CHILL_AGENT_EXTENSIONS:'none',CHILL_AGENT_CODEX_PATH:join(root,'test/fake-codex.mjs'),CODEX_THREAD_ID:'00000000-0000-0000-0000-000000000001'};
const old=join(base,'old'),target=join(base,'target'),url=`http://127.0.0.1:${port}`;
let launcher,keep=false;
try{
 for(const [path,key] of [[old,'a'.repeat(40)],[target,'b'.repeat(40)]]){
  await mkdir(path);await copyRuntime(root,path);
  await writeFile(join(path,'extensions.json'),JSON.stringify({runtimeUpdates:'./lib/probe-update.mjs',modules:[]}));
  await writeFile(join(path,'lib/probe-update.mjs'),`export const createRuntimeUpdates=()=>({current:async()=>${JSON.stringify(key)},candidate:async()=>({key:${JSON.stringify('b'.repeat(40))}}),acquire:async()=>${JSON.stringify(target)}});`);
 }
 ({launcher}=await prepareRuntime(old,data));
 await run(process.execPath,[join(old,'bin/chill-agent.mjs'),'create','--title','更新の操作確認'],{env});
 await run(process.execPath,[launcher,'server','start','--local','--idle-timeout','10m'],{env});
 const before=await (await fetch(url+'/api/goals')).json();
 const state=await (await fetch(url+'/api/runtime-update')).json();assert.equal(state.available,true);
 for(const headers of [{origin:'https://foreign.example'},{origin:url,'cf-ray':'public'},{origin:url,host:'foreign.example'}]){
  const denied=await new Promise((resolve,reject)=>{const req=request(url+'/api/runtime-update',{method:'POST',headers:{'Content-Type':'application/json',...headers}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end(JSON.stringify({candidate:state.candidate,id:randomUUID()}));});assert.equal(denied,403,JSON.stringify(headers));
 }
 if(process.argv.includes('--serve')){keep=true;console.log(JSON.stringify({base,data,port,url,launcher,oldInstance:state.instance}));}
 else{
  const started=await fetch(url+'/api/runtime-update',{method:'POST',headers:{Origin:url,'Content-Type':'application/json'},body:JSON.stringify({candidate:state.candidate,id:randomUUID()})});assert.equal(started.status,202,await started.text());
  let after;
  for(let i=0;i<120;i++){
   await new Promise(resolve=>setTimeout(resolve,500));
   try{after=await (await fetch(url+'/api/runtime-update')).json();if(after.error)throw Error(after.error);if(after.instance!==state.instance&&after.phase==='idle'&&!after.available)break;}catch(error){if(error.message==='更新できませんでした。もう一度お試しください。')throw error;}
  }
  assert.notEqual(after?.instance,state.instance);assert.equal(after?.phase,'idle');assert.equal(after?.available,false);
  assert.deepEqual(await (await fetch(url+'/api/goals')).json(),before);
  console.log('PASS: launchd worker survived Web restart; same URL, Goal data, completed receipt, and no update icon after adoption. Public/cross-origin requests rejected.');
 }
}finally{
 if(!keep){if(launcher)await run(process.execPath,[launcher,'server','stop'],{env}).catch(()=>{});await rm(base,{recursive:true,force:true});}
}
