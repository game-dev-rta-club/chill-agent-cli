import test from 'node:test';
import assert from 'node:assert/strict';
import {mount} from '../extensions/web-notifications/panel.js';

// The page's globals the panel reads, stubbed before any test.
Object.assign(globalThis,{window:{Notification:{},PushManager:{}},Notification:{requestPermission:async()=>'granted'},isSecureContext:true});
// A switch and its row, as much of the page as the panel touches.
function page(){
 const input={},message={textContent:''};
 return {input,message,element:{set innerHTML(_){},querySelector:selector=>selector==='input'?input:message}};
}
test('turning Notification on subscribes a browser that has no subscription yet',async t=>{
 const subscription={endpoint:'https://push.test/1'};let subscribed=0,saved=null,changes=0;
 const registration={active:true,pushManager:{getSubscription:async()=>null,subscribe:async()=>{subscribed++;return {toJSON:()=>subscription};}}};
 Object.defineProperty(navigator,'serviceWorker',{value:{register:async()=>registration},configurable:true});
 t.after(()=>{delete navigator.serviceWorker;});
 const view=page(),control={rootId:'1',enabled:false,letters:true,replies:true,publicKey:'AAAA'};
 await mount({element:view.element,control,goalId:'2',clientId:'device',api:async(path,body)=>{saved=[path,body];return {enabled:true};},changed:()=>changes++,signal:new AbortController().signal});
 assert.equal(view.input.checked,false);assert.equal(view.input.checked,false);
 view.input.checked=true;await view.input.onchange();
 assert.equal(subscribed,1);assert.deepEqual(saved,['toggle',{goalId:'2',rootId:'1',enabled:true,deviceId:'device',subscription}]);
 assert.equal(view.input.checked,true);assert.equal(view.input.checked,true);assert.equal(changes,1);
 assert.match(view.message.textContent,/confirmation/);
});
test('Notification cannot be turned on while the count shows nothing',async()=>{
 const view=page();
 const shown=await mount({element:view.element,control:{rootId:'1',enabled:false,letters:true,replies:false},goalId:'2',clientId:'device',api:async()=>({}),changed(){},signal:new AbortController().signal});
 assert.equal(view.input.disabled,false);
 shown.update({rootId:'1',enabled:false,letters:false,replies:false});assert.equal(view.input.disabled,true);
});
