import test from 'node:test';
import assert from 'node:assert/strict';
import {createExtension,linkQr,publicLinkOn} from '../lib/public-link-extension.mjs';
test('only local users publish; Off retains custom configuration and no fallback to Quick occurs',async()=>{
 let remote={mode:'named',url:'https://phone.test'},saved=null,live={enabled:false,url:null,status:'off'},calls=[],resets=0;
 const store={read:async()=>saved,write:async(_,v)=>saved=v,lock:async(_,run)=>run()};
 const access={resetCode:async()=>{resets+=1;}};
 const e=createExtension({tunnel:{read:()=>live,set:async(enabled,r)=>{calls.push(r.mode);live={enabled,status:enabled?'failed':'off',url:null};}},access,configured:false,store,settings:async()=>({remote}),save:async(_,v)=>remote=v,use:async()=>{},context:async()=>({root:{id:'1'}})});
 await assert.rejects(e.request({method:'POST',path:'toggle',body:{enabled:true},local:false}),/computer/);assert.equal(calls.length,0);
 await e.request({method:'POST',path:'toggle',body:{enabled:true},local:true});assert.deepEqual(calls,['named']);
 await e.request({method:'POST',path:'toggle',body:{enabled:false},local:true});assert.equal(remote.url,'https://phone.test');assert.equal(saved.enabled,false);
 assert.equal(resets,2,'turning the link On or Off ends the shown code');
 remote={mode:'off'};await assert.rejects(e.request({method:'POST',path:'toggle',body:{enabled:true},local:true}),/Confirm/);assert.equal(remote.mode,'off');
 assert.equal(resets,2,'a refused toggle keeps the code');
});
test('the QR opens the link, the computer and connected devices see the code and devices, and only the computer disconnects devices',async()=>{
 const live={enabled:true,url:'https://phone-test.trycloudflare.com',status:'running'};
 const devices=[{id:'a1',device:'iPhone · Safari',connectedAt:'2026-10-19T05:57:00.000Z'}],removed=[];
 const access={code:async()=>'123456',devices:async()=>devices,disconnect:async id=>{removed.push(id);},disconnectAll:async()=>{removed.push('all');}};
 const e=createExtension({tunnel:{read:()=>live},access,store:{read:async()=>({enabled:true,confirmedPublic:true})},settings:async()=>({remote:{mode:'quick'}})});
 const local=(await e.request({method:'GET',path:'state',body:{},query:{goalId:'3'},local:true})).body;
 assert.equal(local.code,'123456');assert.deepEqual(local.devices,devices);
 assert.equal(local.link,'https://phone-test.trycloudflare.com/#/goal/3');
 assert.equal(local.qr,await linkQr(local.link),'the QR carries the link, not the code');
 const phone=(await e.request({method:'GET',path:'state',body:{},query:{goalId:'3'},local:false})).body;
 assert.equal(phone.code,'123456','a connected device can let another one in');assert.deepEqual(phone.devices,devices);assert.equal(phone.local,false);
 await assert.rejects(e.request({method:'POST',path:'disconnect',body:{id:'a1'},local:false}),/computer/);
 await e.request({method:'POST',path:'disconnect',body:{id:'a1'},local:true});await e.request({method:'POST',path:'disconnect-all',body:{},local:true});
 assert.deepEqual(removed,['a1','all']);
});
test('a configured start follows the panel’s saved On/Off',async()=>{
 let saved=null;const store={read:async()=>saved};
 assert.equal(await publicLinkOn(store),true,'a saved connection without a panel choice starts On');
 saved={enabled:false,confirmedPublic:true};assert.equal(await publicLinkOn(store),false);
 saved={enabled:true,confirmedPublic:true};assert.equal(await publicLinkOn(store),true);
});
