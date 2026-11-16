#!/usr/bin/env node
import '../lib/quiet-sqlite-warning.mjs';
import {execFile} from 'node:child_process';
import {appendFileSync} from 'node:fs';
import {rm} from 'node:fs/promises';
import {join} from 'node:path';
import {format} from 'node:util';
const [directory,rawPort,duration,id]=process.argv.slice(2);
const validId=/^[-a-f0-9]{36}$/.test(id||'');
// launchd writes the log on macOS. A Windows task has no output, so the worker writes its own.
if(process.platform==='win32'&&directory&&validId){
 const log=join(directory,'runtime',`update-${id}.log`);
 for(const level of ['log','info','warn','error'])console[level]=(...values)=>{try{appendFileSync(log,`${format(...values)}\n`);}catch{}};
}
try{
 const port=Number(rawPort);
 if(!directory||!Number.isInteger(port)||port<1||port>65535||!/^\d+(?:\.\d+)?(?:ms|s|m|h|d)$/.test(duration||'')||!validId)throw Error('Invalid runtime update worker input.');
 process.env.CHILL_AGENT_DATA_DIR=directory;process.env.PORT=rawPort;
 const {performRuntimeUpdate}=await import('../lib/runtime-update.mjs');
 await performRuntimeUpdate({directory,port,duration,id});
}catch(error){console.error(error.message);process.exitCode=1;}
finally{
 // The job or task is named from the directory and ID, so it is removed even after invalid input.
 if(directory&&validId){
  const api=await import('../lib/runtime-update.mjs');
  if(process.platform==='win32'){
   const {deleteTask}=await import('../lib/web-service-windows.mjs');
   await deleteTask(api.updateWorkerTask(directory,id));await rm(join(directory,'runtime',`update-${id}.xml`),{force:true});
  }else execFile('/bin/launchctl',['remove',api.updateWorkerLabel(directory,id)],()=>{});
 }
}
