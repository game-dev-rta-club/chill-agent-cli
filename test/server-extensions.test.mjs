import test from 'node:test';
import assert from 'node:assert/strict';
import {createExtensionHost} from '../lib/server-extensions.mjs';
import {createContinuationExtension,continuationKeepsAlive} from '../lib/continuation-extension.mjs';
import {codexContinuation} from '../lib/agents/codex-continuation.mjs';
const idle=()=>({queue:[],pendingFeedback:[],stable:true,harnessState:'idle',turn:{completedAt:1},revision:'r'});
const exhausted=()=>({threadId:'t',revision:'r',attempts:[{completedAt:1},{completedAt:2}]});
test('Autonomy alone is not a keepalive; actual work and unspent checks are',()=>{
 assert.equal(continuationKeepsAlive(idle(),exhausted(),true),false);
 assert.equal(continuationKeepsAlive(idle(),{...exhausted(),attempts:[{completedAt:1}]},true),false,'one completed check uses the allowance');
 assert.equal(continuationKeepsAlive(idle(),{...exhausted(),attempts:[{phase:'running'}]},true),true,'the single check must be allowed to finish');
 assert.equal(continuationKeepsAlive(idle(),{...exhausted(),revision:'old'},true),true);
 assert.equal(continuationKeepsAlive(idle(),{revision:'r',attempts:[]},true),true);
 assert.equal(continuationKeepsAlive(idle(),null,true),true,'a Root never checked has its check to come');
 assert.equal(continuationKeepsAlive(idle(),{revision:'r',attempts:[]},false),false,'no Goal asks for a check');
 assert.equal(continuationKeepsAlive({...idle(),paused:true},{},true),false);
 for(const patch of [{queue:[{}]},{pendingFeedback:[{}]},{heartbeatFresh:true},{harnessState:'active'},{turn:{completedAt:null}},{stable:false}])assert.equal(continuationKeepsAlive({...idle(),...patch},null,false),true);
 assert.equal(continuationKeepsAlive({...idle(),paused:true,pendingFeedback:[{}]},null,false),false);
 assert.equal(continuationKeepsAlive(idle(),{...exhausted(),attempts:[{phase:'uncertain'}]},true),true);
});
test('host does not overlap ticks, waits for running work on stop, and rejects further writes',async()=>{
 let release,calls=0,stops=0;
 const host=createExtensionHost([{id:'test',label:'Test',read:async()=>({enabled:false}),set:async()=>{},tick:()=>{calls++;return new Promise(r=>release=r);},stop:()=>stops++}]);
 const first=host.tick(),second=host.tick();assert.equal(calls,1);assert.equal(await host.busy(),true);
 let ended=false;const stopping=host.stop().then(()=>ended=true);await Promise.resolve();assert.equal(ended,false);
 release();await Promise.all([first,second,stopping]);assert.equal(stops,1);await host.tick();assert.equal(calls,1);
 await assert.rejects(host.change('1','test',{enabled:true}),/shutting down/);
});
test('the continuation host ticks polled Roots, retires the old process once and shows no Web control',async()=>{
 const retired=[];let observed=0;
 const codex=root=>codexContinuation(root,{read:async()=>exhausted(),plan:async()=>null,retireLegacy:async id=>retired.push(id),observe:async()=>{observed++;return idle();}});
 const ext=createContinuationExtension({roots:async()=>[{id:'1',threadId:'t'}],continuation:codex});
 await ext.start();await ext.tick();await ext.tick();assert.deepEqual(retired,['1']);assert.equal(observed,0,'a chat whose Goals ask for nothing is not observed');
 assert.equal(await ext.read('1'),null,'Autonomy is set per Goal in the comment box');
 assert.equal(await ext.busy(),false);
 const host=createExtensionHost([ext]);
 assert.deepEqual(await host.controls('1'),[]);
 await assert.rejects(host.change('1','continuation',{enabled:true}),/Unknown extension/,'there is no On/Off to set');
});
test('an agent that checks at its own Stop is not polled',async()=>{
 const ext=createContinuationExtension({roots:async()=>[{id:'3',connection:{sessionId:'s',contextId:'c'}}],continuation:()=>({live:false})});
 await ext.tick();assert.equal(await ext.busy(),false);
});
test('empty registry works, isolated tick failure does not stop other extensions',async()=>{
 assert.deepEqual(await createExtensionHost([]).controls('1'),[]);
 let ticks=0,errors=0;const host=createExtensionHost([{id:'bad',read:async()=>null,tick:async()=>{throw Error('bad');}},{id:'good',read:async()=>({enabled:false}),tick:async()=>ticks++}],{onError:()=>errors++});
 await host.tick();assert.equal(ticks,1);assert.equal(errors,1);assert.equal((await host.controls('1')).length,1);
});
