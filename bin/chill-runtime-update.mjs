#!/usr/bin/env node
import {execFile} from 'node:child_process';
const [directory,rawPort,duration,id]=process.argv.slice(2);
let updateWorkerLabel;
try{
 const port=Number(rawPort);
 if(!directory||!Number.isInteger(port)||port<1||port>65535||!/^\d+(?:\.\d+)?(?:ms|s|m|h|d)$/.test(duration||'')||!/^[-a-f0-9]{36}$/.test(id||''))throw Error('Invalid runtime update worker input.');
 process.env.CHILL_AGENT_DATA_DIR=directory;process.env.PORT=rawPort;
 const api=await import('../lib/runtime-update.mjs');updateWorkerLabel=api.updateWorkerLabel;
 const {performRuntimeUpdate}=api;
 await performRuntimeUpdate({directory,port,duration,id});
}catch(error){console.error(error.message);process.exitCode=1;}
finally{if(updateWorkerLabel)execFile('/bin/launchctl',['remove',updateWorkerLabel(directory,id)],()=>{});}
