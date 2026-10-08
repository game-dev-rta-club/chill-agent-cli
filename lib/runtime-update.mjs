import {join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {dataDirectory} from './data-directory.mjs';
import {readJson,writeJsonAtomically,withStoreLock} from './storage.mjs';
import {prepareRuntime} from './runtime-package.mjs';

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

export const updateWorkerLabel=(directory,id)=>`com.chill-agent.update.${createHash('sha256').update(directory).digest('hex').slice(0,12)}.${id}`;
export async function launchUpdateWorker({directory,port,duration,id,root=runtimeRoot,run=execute}){
 const label=updateWorkerLabel(directory,id);
 const log=join(directory,'runtime',`update-${id}.log`);
 // A separate launchd job survives bootout of the Web job and its descendants.
 await run('/bin/launchctl',['submit','-l',label,'-o',log,'-e',log,'--',process.execPath,join(root,'bin/chill-runtime-update.mjs'),directory,String(port),duration,id],{env:process.env});
 return label;
}

export function createRuntimeUpdater({directory=dataDirectory(),root=runtimeRoot,port,duration='3d',
 supported=process.platform==='darwin'&&process.env.CHILL_AGENT_MANAGED_TUNNEL==='1',
 provider=()=>runtimeUpdateProvider(root),launch=launchUpdateWorker}={}){
 async function facts(){
  if(!supported)return {supported:false,available:false};
  const adapter=await provider();if(!adapter)return {supported:false,available:false};
  const candidate=await adapter.candidate(directory),current=await adapter.current();
  if(!keyPattern.test(current||'')||!keyPattern.test(candidate?.key||''))return {supported:true,available:false};
  return {supported:true,available:candidate.key!==current,candidate:candidate.key};
 }
 async function status(){
  try{
   const state=await readJson(statePath(directory));
   const latest=await facts();
   return {...latest,phase:pending(state)?state.phase:'idle',...(state?.phase==='failed'?{error:'更新できませんでした。もう一度お試しください。'}:{})};
  }catch{return {supported,available:false,phase:'idle'};}
 }
 async function start(input){
  if(!keyPattern.test(input?.candidate||'')||!/^[-a-f0-9]{36}$/.test(input?.id||''))throw Error('Invalid update request.');
  return withStoreLock(join(directory,'runtime','update-lock'),async()=>{
   const latest=await facts();
   if(!latest.supported||!latest.available||latest.candidate!==input.candidate)throw Error('更新内容が変わりました。画面を再読み込みしてください。');
   const old=await readJson(statePath(directory));
   if(pending(old))return {phase:old.phase,id:old.id};
   const state={id:input.id,candidate:input.candidate,phase:'preparing',at:Date.now(),root,port:typeof port==='function'?port():port,duration};
   await writeJsonAtomically(statePath(directory),state);
   try{await launch({directory,port:state.port,duration,id:state.id,root});}
   catch(error){await writeJsonAtomically(statePath(directory),{...state,phase:'failed',detail:error.message});throw Error('更新を開始できませんでした。もう一度お試しください。');}
   return {phase:'preparing',id:state.id};
  });
 }
 return {status,start};
}

export async function performRuntimeUpdate({directory,port,duration,id,root=runtimeRoot,
 provider=()=>runtimeUpdateProvider(root),prepare=prepareRuntime,run=execute}={}){
 const initial=await readJson(statePath(directory));
 if(initial?.id!==id||initial.phase!=='preparing'||initial.root!==root||initial.port!==port)throw Error('Update request no longer matches this worker.');
 const save=async patch=>{if((await readJson(statePath(directory)))?.id===id)await writeJsonAtomically(statePath(directory),{...initial,...patch,at:Date.now()});};
 let switched=false;
 const env={...process.env,CHILL_AGENT_DATA_DIR:directory,PORT:String(port)};
 const restart=target=>run(process.execPath,[join(target,'bin/chill-server.mjs'),'restart','--configured','--idle-timeout',duration],{env,timeout:90000,maxBuffer:1024*1024});
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
  const installed=await prepare(target,directory);
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
