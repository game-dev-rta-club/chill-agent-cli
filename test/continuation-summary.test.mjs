import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGoal,updateGoal,appendAgentComment} from '../lib/goal-store.mjs';
import {continuationObservation} from '../lib/continuation-observation.mjs';
test('monitor summary includes the root, derived Waiting and own Letters without changing eligibility',async()=>{
 const old=process.env.CHILL_AGENT_DATA_DIR,dir=await mkdtemp(join(tmpdir(),'chill-summary-'));process.env.CHILL_AGENT_DATA_DIR=dir;
 const connect=fn=>fn({request:async method=>{
  if(method==='thread/read')return {thread:{status:{type:'notLoaded'}}};
  if(method==='thread/turns/list')return {data:[{id:'ended',status:'completed',completedAt:1}]};
  if(method==='thread/queue/list')return {data:[]};throw Error(method);
 }});
 try{
  const root=await createGoal({title:'Root',threadId:'00000000-0000-0000-0000-000000000001'});
  const child=await createGoal({title:'Child',parentId:root.id,state:'waiting',waitReason:'An answer'});
  await appendAgentComment({goalId:child.id,type:'letter',title:'Question?',text:'Details'});
  const observe=async()=>(await continuationObservation(root.id,null,{connect})).context.goals;
  assert.deepEqual(await observe(),{total:2,unfinished:2,letters:1,open:0,running:0,paused:0,waiting:2,done:0});
  await updateGoal(child.id,{state:'done'});
  assert.equal((await observe()).unfinished,1,'an Open root remains unfinished when its last child finishes');
  await updateGoal(root.id,{state:'done'});
  assert.equal((await observe()).unfinished,0);assert.equal((await observe()).letters,1,'Done does not close a Letter');
 }finally{if(old===undefined)delete process.env.CHILL_AGENT_DATA_DIR;else process.env.CHILL_AGENT_DATA_DIR=old;await rm(dir,{recursive:true,force:true});}
});
