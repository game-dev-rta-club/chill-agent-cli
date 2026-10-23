import test from 'node:test';
import assert from 'node:assert/strict';
import {createApproveAllExtension} from '../lib/approve-all-extension.mjs';

test('Approve all is a header control only for agents that can answer prompts, and saves through the agent',async()=>{
 let on=false;
 const claude={readApproveAll:async()=>on,setApproveAll:async value=>{on=value;}};
 const roots={'1':{id:'1'},'2':{id:'2'}};
 const extension=createApproveAllExtension({context:async id=>({root:roots[id]}),agent:root=>root.id==='1'?claude:{}});
 assert.equal(await extension.read('2'),null,'no switch for an agent without Approve all');
 await assert.rejects(extension.set('2',{enabled:true}),/not available/);
 const control=await extension.read('1');
 assert.deepEqual({rootId:control.rootId,enabled:control.enabled,placement:control.placement,icon:control.icon},{rootId:'1',enabled:false,placement:'header',icon:'shield'});
 assert.equal(control.activity,undefined);assert.equal((await extension.read('1',{activity:true})).activity.label,'Approve all');
 assert.equal(control.confirmOn.confirmLabel,'Turn on');
 await extension.set('1',{enabled:true,rootId:'1'});assert.equal(on,true);assert.equal((await extension.read('1')).enabled,true);
 await assert.rejects(extension.set('1',{enabled:false,rootId:'9'}),/Agent changed/);assert.equal(on,true);
});
