import test from 'node:test';
import assert from 'node:assert/strict';
import {createAgentObservationStore,agentPresence} from '../lib/agent-observation.mjs';
import {createCodexDesktopConnection} from '../lib/codex-desktop-connection.mjs';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const connection=(harnessId,readRunSnapshot)=>({harnessId,sessionId:'same-native-id',readRunSnapshot});

test('run, pause and heartbeat evidence never crosses harnesses with equal session IDs',async()=>{
 const store=createAgentObservationStore(),wait=deferred();let reads=0;
 const first=connection('codex-desktop',()=>{reads++;return wait.promise;});
 const second=connection('other-harness',async()=>({threadState:'idle',turn:null,view:null,heartbeat:null}));
 const one=store.read(first),also=store.read(first);
 const other=await store.read(second);
 assert.equal(reads,1);assert.equal(agentPresence(other),'idle');
 wait.resolve({threadState:'notLoaded',turn:{id:'run',completedAt:null},view:{status:'paused'},heartbeat:{turnId:'run'}});
 const stopped=await one;
 assert.equal(await also,stopped);assert.equal(agentPresence(stopped),'paused');
 assert.equal(await store.read(second),other);assert.equal(other.heartbeat,null);
 store.invalidate(first);
 assert.equal(await store.read(second),other,'invalidating one harness preserves the other');
});

test('an older failed observation cannot erase a successful fresh read',async()=>{
 const store=createAgentObservationStore(),old=deferred(),started=deferred();
 const agent=connection('test',()=>{started.resolve();return old.promise;});
 const pending=store.read(agent),failure=assert.rejects(pending,/disconnected/);
 await started.promise;
 agent.readRunSnapshot=async()=>({threadState:'active'});
 const fresh=await store.read(agent,{fresh:true});
 old.reject(Error('disconnected'));await failure;
 agent.readRunSnapshot=async()=>{throw Error('fresh cache was lost');};
 assert.equal(await store.read(agent),fresh);
});

test('expired observations are refreshed and a disconnect cannot reuse old idle evidence',async()=>{
 let now=0,reads=0;
 const store=createAgentObservationStore({now:()=>now,ttl:10});
 const agent=connection('test',async()=>{reads++;if(reads>1)throw Error('disconnected');return {threadState:'idle'};});
 await store.read(agent);now=9;await store.read(agent);assert.equal(reads,1);
 now=10;await assert.rejects(store.read(agent),/disconnected/);
 await assert.rejects(store.read(agent),/disconnected/);assert.equal(reads,3,'failure does not become cached Idle');
});

test('an unsupported observer stays unknown and incomplete identities cannot share a cache entry',async()=>{
 const store=createAgentObservationStore();
 const missing=await store.read(connection('unsupported'));
 assert.equal(agentPresence(missing),'unknown');assert.equal(missing.turn,null);assert.equal(missing.heartbeat,null);
 assert.equal(agentPresence(await store.read(connection('empty',async()=>null))),'unknown');
 for(const invalid of [null,{}, {harnessId:'test'}, {harnessId:'',sessionId:'same-native-id'}]) {
  await assert.rejects(store.read(invalid),/required/);
 }
});

function nativeFixture({threadId='native',queueError=false,threadError=false}={}) {
 const calls=[];
 const adapter=createCodexDesktopConnection('native',{
  readControl:async()=>({action:'stop',turnId:'run',target:{goalId:'2'}}),
  readHeartbeat:async()=>({turnId:'run',heartbeatAt:'2026-10-06T00:00:00.000Z'}),
  run:async action=>action({request:async(method,params)=>{
   calls.push({method,params});
   if(method==='thread/read'){if(threadError)throw Error('thread offline');return {thread:{id:threadId,status:{type:'notLoaded'},privatePrompt:'secret'}};}
   if(method==='thread/turns/list')return {data:[{id:'run',status:'interrupted',completedAt:12,items:[{text:'private input'}],error:{message:'private error'}}]};
   if(method==='thread/queue/list'){if(queueError)throw Error('queue offline');return {data:[{id:'pending',input:[{text:'private queue'}]}]};}
   throw Error('unexpected RPC');
  }}),
 });
 return {adapter,calls};
}

test('Codex observation keeps pause evidence and returns no transcript, input or error text',async()=>{
 const {adapter,calls}=nativeFixture();
 const result=await adapter.readRunSnapshot();
 assert.equal(agentPresence(result),'paused');assert.equal(result.view.goalId,'2');
 assert.deepEqual(result.turn,{id:'run',status:'interrupted',completedAt:12});
 assert.deepEqual(result.queue,{data:[{id:'pending'}]});
 assert.equal(result.heartbeat.turnId,'run');assert.doesNotMatch(JSON.stringify(result),/private|secret/);
 assert.equal(calls.length,3);assert(calls.every(call=>call.params.threadId==='native'));
});

test('queue failure remains separate; missing or mismatched native conversations never produce an observation',async()=>{
 const result=await nativeFixture({queueError:true}).adapter.readRunSnapshot();
 assert.equal(result.queue,null);assert.equal(agentPresence(result),'paused');
 for(const threadId of ['someone-else',null])await assert.rejects(nativeFixture({threadId}).adapter.readRunSnapshot(),/assignment changed/);
 await assert.rejects(nativeFixture({threadError:true}).adapter.readRunSnapshot(),/thread offline/);
});
