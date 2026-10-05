import test from 'node:test';
import assert from 'node:assert/strict';
import {createExtensionHost} from '../lib/server-extensions.mjs';
import {createRequestSender,requireProtocol} from '../lib/extension-api.mjs';
const id='00000000-0000-0000-0000-000000000001';
const facts={rootId:'1',threadId:id,revision:'r',paused:false,pendingFeedback:[],queue:[],stable:true,harnessState:'idle',heartbeatFresh:false,turn:{id:'turn',status:'completed',completedAt:1}};
test('host request IDs are durable and never resend after a lost receipt',async()=>{
 const journal=new Map();let sends=0;
 const options={lock:async(_,run)=>run(),read:async p=>journal.get(p),write:async(p,v)=>journal.set(p,v),observeState:async()=>facts,send:async()=>{sends++;throw Error('lost receipt')}};
 await assert.rejects(createRequestSender(options)(facts,'hello',id),/lost/);
 await assert.rejects(createRequestSender(options)(facts,'hello',id),/uncertain/);assert.equal(sends,1);
});
test('fresh queued or changed execution blocks enqueue before reservation',async()=>{
 for(const fresh of [{...facts,queue:[{}]},{...facts,revision:'new'},{...facts,paused:true},{...facts,threadId:'different'}]){
 let writes=0,sends=0;
 const send=createRequestSender({lock:async(_,run)=>run(),read:async()=>null,write:async()=>writes++,observeState:async()=>fresh,send:async()=>sends++});
 await assert.rejects(send(facts,'hello',id),/changed/);assert.equal(writes,0);assert.equal(sends,0);
 }
});
test('accepted requests are idempotent and mismatched protocol fails closed',async()=>{
 const journal=new Map();let sends=0;const result={queuedSubmission:{id:'q'}};
 const send=createRequestSender({lock:async(_,run)=>run(),read:async p=>journal.get(p),write:async(p,v)=>journal.set(p,v),observeState:async()=>facts,send:async()=>{sends++;return result}});
 assert.deepEqual(await send(facts,'hello',id),result);assert.deepEqual(await send(facts,'hello',id),result);assert.equal(sends,1);
 await assert.rejects(send(facts,'different',id),/already used/);assert.throws(()=>requireProtocol(2),/Unsupported/);
});

test('extension changes return detailed activity when requested and keep header reads light',async()=>{
 let enabled=false;const activity={total:1,entries:[{id:'saved',message:'Continue agreed work.'}]};
 const host=createExtensionHost([{id:'example',read:async(_,options)=>({enabled,...(options.activity?{activity}:{})}),set:async(_,input)=>{enabled=input.enabled}}]);
 const detailed=await host.change('1','example',{enabled:true},{activity:true});
 assert.equal(detailed[0].enabled,true);assert.deepEqual(detailed[0].activity,activity);
 const light=await host.change('1','example',{enabled:false});
 assert.equal(light[0].enabled,false);assert.equal(light[0].activity,undefined);
});
