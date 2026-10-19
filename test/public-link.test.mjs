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
test('the QR signs a phone in with a code only the computer sees, and only the computer signs phones out',async()=>{
 const live={enabled:true,url:'https://phone-test.trycloudflare.com',status:'running'};let signedOut=0;
 const access={code:async()=>'ABCD2345',phones:async()=>2,signOutAll:async()=>{signedOut++;}};
 const e=createExtension({tunnel:{read:()=>live},access,store:{read:async()=>({enabled:true,confirmedPublic:true})},settings:async()=>({remote:{mode:'quick'}})});
 const local=(await e.request({method:'GET',path:'state',body:{},query:{goalId:'3'},local:true})).body;
 assert.equal(local.code,'ABCD2345');assert.equal(local.phones,2);
 assert.equal(local.link,'https://phone-test.trycloudflare.com/#/goal/3');
 assert.match(local.qr,/^data:image\/png;base64,/);
 const phone=(await e.request({method:'GET',path:'state',body:{},query:{goalId:'3'},local:false})).body;
 assert.equal(phone.code,null);assert.equal(phone.qr,null);
 await assert.rejects(e.request({method:'POST',path:'sign-out',body:{},local:false}),/computer/);
 await e.request({method:'POST',path:'sign-out',body:{},local:true});assert.equal(signedOut,1);
});
