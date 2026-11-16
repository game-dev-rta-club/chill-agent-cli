import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGoal,createOwnedRoot,updateGoal,appendAgentComment} from '../lib/goal-store.mjs';
import {setRootAutonomy} from '../lib/root-autonomy.mjs';
import {continuationObservation} from '../lib/agents/codex-continuation-observation.mjs';
import {codexThread,contractStub} from './codex-contract.mjs';
test('monitor summary includes the root, derived Waiting and own Letters without changing eligibility',async()=>{
 const old=process.env.CHILL_AGENT_DATA_DIR,dir=await mkdtemp(join(tmpdir(),'chill-summary-'));process.env.CHILL_AGENT_DATA_DIR=dir;
 const connect=fn=>fn(contractStub(async(method,p)=>{
  if(method==='thread/read')return {thread:codexThread({id:p.threadId})};
  if(method==='thread/turns/list')return {data:[{id:'ended',status:'completed',completedAt:1,items:[]}]};
  if(method==='thread/queue/list')return {data:[]};throw Error(method);
 }));
 try{
  const root=await createOwnedRoot({title:'Root'},{agent:'codex',id:'00000000-0000-0000-0000-000000000001'});await setRootAutonomy(root.id,2);
  const child=await createGoal({title:'Child',parentId:root.id,state:'waiting',waitReason:'An answer'});
  await appendAgentComment({goalId:child.id,type:'letter',title:'Question?',text:'Details'});
  const observe=async()=>(await continuationObservation(root.id,null,{connect})).context.goals;
  assert.deepEqual(await observe(),{total:2,unfinished:2,letters:1,open:0,running:0,paused:0,waiting:2,done:0});
  await updateGoal(child.id,{state:'done'});
  assert.equal((await observe()).unfinished,1,'an Open root remains unfinished when its last child finishes');
  await appendAgentComment({goalId:root.id,type:'letter',title:'Another?',text:'Details'});
  assert.equal((await observe()).letters,2,'Done does not close a Letter');
  await updateGoal(root.id,{state:'done'});
  assert.equal((await observe()).total,0,'a Done Root is not continued, so nothing of it counts');
 }finally{if(old===undefined)delete process.env.CHILL_AGENT_DATA_DIR;else process.env.CHILL_AGENT_DATA_DIR=old;await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
