#!/usr/bin/env node
import '../lib/quiet-sqlite-warning.mjs';
import {execFile} from 'node:child_process';
import {appendFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
const [directory,rawPort,duration,id]=process.argv.slice(2);
let api;
try{
 const port=Number(rawPort);
 if(!directory||!Number.isInteger(port)||port<1||port>65535||!/^\d+(?:\.\d+)?(?:ms|s|m|h|d)$/.test(duration||'')||!/^[-a-f0-9]{36}$/.test(id||''))throw Error('Invalid runtime update worker input.');
 process.env.CHILL_AGENT_DATA_DIR=directory;process.env.PORT=rawPort;
 api=await import('../lib/runtime-update.mjs');
 await api.performRuntimeUpdate({directory,port,duration,id});
}catch(error){
 console.error(error.message);process.exitCode=1;
 // launchd writes the log on macOS; a Windows task has no output to keep.
 if(api&&process.platform==='win32')await appendFile(api.updateWorkerLog(directory,id),`${error.message}\n`).catch(()=>{});
}
finally{
 if(api&&process.platform==='win32'){
  const {deleteTask}=await import('../lib/web-service-windows.mjs');
  await deleteTask(api.updateWorkerTask(directory,id));await rm(join(directory,'runtime',`update-${id}.xml`),{force:true});
 }else if(api)execFile('/bin/launchctl',['remove',api.updateWorkerLabel(directory,id)],()=>{});
}
