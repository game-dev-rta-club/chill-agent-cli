import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {dataDirectory} from './data-directory.mjs';
import {readJson,writeJsonAtomically,withStoreLock} from './storage.mjs';
import {prepareWithOwnInstaller} from './runtime-package.mjs';
import {largeSize} from './limits.mjs';
import {runHeadlessTask} from './web-service-windows.mjs';

const execute=promisify(execFile);
const runtimeRoot=fileURLToPath(new URL('../',import.meta.url));
const keyPattern=/^[a-f0-9]{40}$/;
const pending=state=>['preparing','restarting'].includes(state?.phase)&&Date.now()-state.at<15*60*1000;
const statePath=directory=>join(directory,'runtime','update.json');

// Only the installed package can register a provider. Browser requests never
// supply a module, command, path, URL, package name or data directory.
export async function runtimeUpdateProvider(root=runtimeRoot){
 const manifest=await readJson(join(root,'extensions.json'));
 const source=manifest?.runtimeUpdates;
 if(!source)return null;
 if(typeof source!=='string'||!/^\.\/lib\/[a-z0-9-]+\.mjs$/.test(source))throw Error('Invalid runtime update provider.');
 return (await import(pathToFileURL(join(root,source)).href)).createRuntimeUpdates();
}

const directoryKey=directory=>createHash('sha256').update(directory).digest('hex').slice(0,12);
export const updateWorkerLabel=(directory,id)=>`com.chill-agent.update.${directoryKey(directory)}.${id}`;
export const updateWorkerTask=(directory,id)=>`\\chill-agent\\update-${directoryKey(directory)}-${id}`;
export const updateWorkerLog=(directory,id)=>join(directory,'runtime',`update-${id}.log`);
export async function launchUpdateWorker({directory,port,duration,id,root=runtimeRoot,run=execute,platform=process.platform}){
 const worker=[process.execPath,join(root,'bin/chill-runtime-update.mjs'),directory,String(port),duration,id];
 // Windows: stopping Web ends the Web task's process tree, so the worker runs as
 // its own task. The worker deletes the registration when it finishes.
 if(platform==='win32'){
  const name=updateWorkerTask(directory,id);
  await runHeadlessTask({name,file:join(directory,'runtime',`update-${id}.xml`),args:worker,cwd:root,description:'chill-agent update',execute:run});
  return name;
 }
 const label=updateWorkerLabel(directory,id),log=updateWorkerLog(directory,id);
 // A separate launchd job survives bootout of the Web job and its descendants.
 await run('/bin/launchctl',['submit','-l',label,'-o',log,'-e',log,'--',...worker],{env:process.env});
 return label;
}

// Updates replace a background Web: launchd's on macOS, Task Scheduler's on
// Windows (the server passes whether it was started that way).
export function createRuntimeUpdater({directory=dataDirectory(),root=runtimeRoot,port,duration='3d',
 supported=process.platform==='darwin'&&process.env.CHILL_AGENT_MANAGED_TUNNEL==='1',
 provider=()=>runtimeUpdateProvider(root),launch=launchUpdateWorker}={}){
 async function facts(){
  if(!supported)return {supported:false,available:false};
  const adapter=await provider();if(!adapter)return {supported:false,available:false};
  const candidate=await adapter.candidate(directory),current=await adapter.current(directory);
  if(!keyPattern.test(current||'')||!keyPattern.test(candidate?.key||''))return {supported:true,available:false};
  return {supported:true,available:candidate.key!==current,candidate:candidate.key};
 }
 async function status(){
  try{
   const state=await readJson(statePath(directory));
   const latest=await facts();
   return {...latest,phase:pending(state)?state.phase:'idle',...(state?.phase==='failed'?{error:'The update failed. Please try again.'}:{})};
  }catch{return {supported,available:false,phase:'idle'};}
 }
 async function start(input){
  if(!keyPattern.test(input?.candidate||'')||!/^[-a-f0-9]{36}$/.test(input?.id||''))throw Error('Invalid update request.');
  return withStoreLock(join(directory,'runtime','update-lock'),async()=>{
   const latest=await facts();
   if(!latest.supported||!latest.available||latest.candidate!==input.candidate)throw Error('The update changed. Reload the page.');
   const old=await readJson(statePath(directory));
   if(pending(old))return {phase:old.phase,id:old.id};
   const state={id:input.id,candidate:input.candidate,phase:'preparing',at:Date.now(),root,port:typeof port==='function'?port():port,duration};
   await writeJsonAtomically(statePath(directory),state);
   try{await launch({directory,port:state.port,duration,id:state.id,root});}
   catch(error){await writeJsonAtomically(statePath(directory),{...state,phase:'failed',detail:error.message});throw Error('Could not start the update. Please try again.');}
   return {phase:'preparing',id:state.id};
  });
 }
 return {status,start};
}

export async function performRuntimeUpdate({directory,port,duration,id,root=runtimeRoot,
 provider=()=>runtimeUpdateProvider(root),prepare=prepareWithOwnInstaller,run=execute}={}){
 const initial=await readJson(statePath(directory));
 if(initial?.id!==id||initial.phase!=='preparing'||initial.root!==root||initial.port!==port)throw Error('Update request no longer matches this worker.');
 const save=async patch=>{if((await readJson(statePath(directory)))?.id===id)await writeJsonAtomically(statePath(directory),{...initial,...patch,at:Date.now()});};
 let switched=false;
 const env={...process.env,CHILL_AGENT_DATA_DIR:directory,PORT:String(port),CHILL_AGENT_VERSION_SWITCHED:'1'};
 const restart=target=>run(process.execPath,[join(target,'bin/chill-server.mjs'),'restart','--configured','--idle-timeout',duration],{env,timeout:90000,maxBuffer:largeSize});
 try{
  const adapter=await provider();
  if((await adapter.candidate(directory))?.key!==initial.candidate)throw Error('Update changed before acquisition.');
  const previous=await readJson(join(directory,'runtime','installation.json'));
  const target=await adapter.acquire(directory,initial.candidate);
  // A pull during download must not silently install a different choice.
  if((await adapter.candidate(directory))?.key!==initial.candidate)throw Error('Update changed during acquisition.');
  const selected=await readJson(join(directory,'runtime','installation.json'));
  if((await readJson(statePath(directory)))?.id!==id)throw Error('Another update replaced this request.');
  if(JSON.stringify(selected)!==JSON.stringify(previous))throw Error('Another operation changed the runtime.');
  await save({phase:'restarting'});
  switched=true;
  const installed=await prepare(target,directory,{package:await adapter.package?.(directory,initial.candidate)});
  await restart(installed.root);
  await save({phase:'complete'});
 }catch(error){
  let recovery='';
  if(switched){
   try{const restored=await prepare(root,directory);await restart(restored.root);recovery='Previous runtime restored.';}
   catch(rollback){recovery=`Recovery needs attention: ${rollback.message}`;}
  }
  await save({phase:'failed',detail:`${error.message} ${recovery}`.trim()});
  throw error;
 }
}
