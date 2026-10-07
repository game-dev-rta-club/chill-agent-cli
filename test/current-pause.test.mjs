import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createGoal} from '../lib/goal-store.mjs';
import {createControlService} from '../lib/agent-control.mjs';
import {continuationObservation,continuationEligibility} from '../lib/continuation-observation.mjs';

test('current-run pause without feedback blocks continuation until explicit resume',async()=>{
 const old=process.env.CHILL_AGENT_DATA_DIR,dir=await mkdtemp(join(tmpdir(),'chill-current-pause-'));
 process.env.CHILL_AGENT_DATA_DIR=dir;
 const threadId='00000000-0000-0000-0000-000000000001',turnId='00000000-0000-0000-0000-000000000002',requestId='00000000-0000-0000-0000-000000000003',next='00000000-0000-0000-0000-000000000004';
 let record=null,turn={id:turnId,status:'completed',completedAt:null};
 try{
  const root=await createGoal({title:'autonomous work',threadId});
  await mkdir(join(dir,'workspace/agent-controls'),{recursive:true});
  const service=createControlService({context:async()=>({root}),read:async()=>record,write:async(_,value)=>{record=value;await writeFile(join(dir,'workspace/agent-controls',threadId+'.json'),JSON.stringify(value));},latest:async()=>turn,stop:async()=>{turn={...turn,status:'interrupted',completedAt:1};return {ok:true,interruptedTurnId:turnId};},resume:async()=>{turn={id:next,status:'completed',completedAt:null};return {result:{turn:{id:next}}};}});
  const observe=()=>continuationObservation(root.id,null,{connect:fn=>fn({request:async method=>{
   if(method==='thread/read')return {thread:{status:{type:'notLoaded'}}};
   if(method==='thread/turns/list')return {data:[turn]};
   if(method==='thread/queue/list')return {data:[]};throw Error(method);
  }})});
  await service(root.id,{action:'stop',threadId,turnId,requestId},{goalId:root.id});
  assert.equal(continuationEligibility(await observe()),'paused');
  assert.equal(continuationEligibility(await observe()),'paused','repeated observations must not restart work');
  await service(root.id,{action:'resume',threadId,turnId,requestId:next},null);
  assert.equal(continuationEligibility(await observe()),'running');
  turn={...turn,completedAt:2};
  assert.equal(continuationEligibility(await observe()),'idle','continuation becomes eligible only after resumed work ends');
 }finally{if(old===undefined)delete process.env.CHILL_AGENT_DATA_DIR;else process.env.CHILL_AGENT_DATA_DIR=old;await rm(dir,{recursive:true,force:true});}
});
