import test from 'node:test';
import assert from 'node:assert/strict';
import {createExtension} from '../lib/public-link-extension.mjs';
test('only local users publish; Off retains custom configuration and no fallback to Quick occurs',async()=>{
 let remote={mode:'named',url:'https://phone.test'},saved=null,live={enabled:false,url:null,status:'off'},calls=[];
 const store={read:async()=>saved,write:async(_,v)=>saved=v,lock:async(_,run)=>run()};
 const e=createExtension({tunnel:{read:()=>live,set:async(enabled,r)=>{calls.push(r.mode);live={enabled,status:enabled?'failed':'off',url:null};}},configured:false,store,settings:async()=>({remote}),save:async(_,v)=>remote=v,use:async()=>{},context:async()=>({root:{id:'1'}})});
 await assert.rejects(e.request({method:'POST',path:'toggle',body:{enabled:true},local:false}),/computer/);assert.equal(calls.length,0);
 await e.request({method:'POST',path:'toggle',body:{enabled:true},local:true});assert.deepEqual(calls,['named']);
 await e.request({method:'POST',path:'toggle',body:{enabled:false},local:true});assert.equal(remote.url,'https://phone.test');assert.equal(saved.enabled,false);
 remote={mode:'off'};await assert.rejects(e.request({method:'POST',path:'toggle',body:{enabled:true},local:true}),/Confirm/);assert.equal(remote.mode,'off');
});
