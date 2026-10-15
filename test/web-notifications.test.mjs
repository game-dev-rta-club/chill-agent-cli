import test from 'node:test';
import assert from 'node:assert/strict';
import {createWebNotifications,validateSubscription} from '../lib/web-notifications.mjs';
const device='00000000-0000-0000-0000-000000000001',other='00000000-0000-0000-0000-000000000002';
const subscription={endpoint:'https://fcm.googleapis.com/fcm/send/test',keys:{auth:Buffer.alloc(16).toString('base64url'),p256dh:Buffer.concat([Buffer.from([4]),Buffer.alloc(64)]).toString('base64url')}};
function fixture(seed=null){let saved=seed,queue=Promise.resolve(),time=100000,mode='ok',origin=null;const sends=[],events=[{id:1,goalId:'2',author:'agent',type:'letter',title:'Choose',text:'A decision'}];
 const store={read:async()=>structuredClone(saved),write:async(_,s)=>saved=structuredClone(s),lock:(_,run)=>{const result=queue.then(run);queue=result.catch(()=>{});return result;}};
 const api=createWebNotifications({store,context:async id=>({root:{id:'1',threadId:'chat'},goal:{id,title:'An outcome'}}),events:async()=>events,eventsSince:async since=>({cursor:Math.max(0,...events.map(e=>e.id)),events:events.filter(e=>e.id>since)}),publicOrigin:async()=>origin,owns:async root=>root.threadId==='chat',agentKey:root=>root.threadId||null,use:async()=>{},now:()=>time,generateKeys:()=>({publicKey:'public',privateKey:'private'}),send:async(s,p)=>{sends.push({endpoint:s.endpoint,...JSON.parse(p)});if(mode==='expired')throw {statusCode:410};}});
 const on=(id=device)=>api.configure({goalId:'2',rootId:'1',deviceId:id,enabled:true,subscription:{...subscription,endpoint:subscription.endpoint+id},origin:'https://phone.test'});
 const off=(id=device)=>api.configure({goalId:'2',rootId:'1',deviceId:id,enabled:false});
 return {api,on,off,sends,events,state:()=>saved,time:v=>time=v,mode:v=>mode=v,origin:v=>origin=v};
}
test('invalid endpoints and key lengths cannot be used to send arbitrary network requests',()=>{
 for(const endpoint of ['http://fcm.googleapis.com/x','https://127.0.0.1/x','https://fcm.googleapis.com.evil.test/x','https://google.com.evil.test/x','https://evil.test/x'])assert.throws(()=>validateSubscription({...subscription,endpoint}));
 assert.equal(validateSubscription({...subscription,endpoint:'https://jmt17.google.com/fcm/send/test'}).endpoint,'https://jmt17.google.com/fcm/send/test','Chrome 156 endpoint');
 assert.throws(()=>validateSubscription({...subscription,keys:{...subscription.keys,auth:'short'}}));assert.deepEqual(validateSubscription(subscription),subscription);
});
test('each browser owns its switch; Off cancels only its pending notifications',async()=>{
 const f=fixture();await f.api.initialize();await f.on();assert.equal((await f.api.control('2',{clientId:other})).enabled,false);await f.on(other);await f.off();
 assert.equal((await f.api.read('2',device)).enabled,false);assert.equal((await f.api.read('2',device)).connected,true);assert.equal((await f.api.control('2',{clientId:other})).enabled,true);assert.equal((await f.api.settings('2')).enabled,true);
 f.time(110000);await f.api.drain();assert.equal(f.sends.length,1);assert.equal(f.sends[0].endpoint,subscription.endpoint+other);
});
test('On schedules one confirmation; repeated On and read do not send again; receipts distinguish opening',async()=>{
 const f=fixture();await f.api.initialize();await f.on();await f.on();await f.api.read('2',device);await f.api.drain();assert.equal(f.sends.length,0);assert.equal(Object.values(f.state().jobs).length,1);
 f.time(105000);await Promise.all([f.api.drain(),f.api.drain()]);assert.equal(f.sends.length,1);const j=f.sends[0];assert.equal(j.body,'Notifications are on for this device.');assert.equal(f.state().jobs[j.id].status,'accepted');
 await f.api.acknowledge(j.id,'wrong','received');assert.equal(f.state().jobs[j.id].status,'accepted');
 await f.api.acknowledge(j.id,j.receipt,'clicked');await f.api.acknowledge(j.id,j.receipt,'received');assert.equal(f.state().jobs[j.id].status,'clicked');
});
test('agent chooses saved new events; repeats and older posts never send',async()=>{
 const f=fixture();await f.api.initialize();await f.on();assert.equal((await f.api.prepare('2',1)).handled,false);
 f.events.push({...f.events[0],id:2});const results=await Promise.all([f.api.prepare('2',2),f.api.prepare('2',2)]);assert.equal(results.filter(r=>r.handled).length,1);assert.equal(f.sends.length,1);assert.match(f.sends[0].url,/#\/goal\/2\/letter\/2$/);
});
test('turning one device on does not advance the other device cutoff',async()=>{
 const f=fixture();await f.api.initialize();await f.on();f.events.push({...f.events[0],id:2});await f.on(other);await f.api.prepare('2',2);assert.equal(f.sends.length,1);assert.equal(f.sends[0].endpoint,subscription.endpoint+device);
});
test('restart retains keys and devices but never retries an uncertain confirmation',async()=>{
 const f=fixture();await f.api.initialize();await f.on();const j=Object.values(f.state().jobs)[0];j.status='sending';await f.api.initialize();f.time(120000);await f.api.drain();assert.equal(f.sends.length,0);assert.equal(f.state().jobs[j.id].status,'unconfirmed');assert.equal(f.state().keys.privateKey,'private');
});
test('expired subscriptions turn off usable status; disconnect stops future deliveries',async()=>{
 const f=fixture();await f.api.initialize();await f.on();f.mode('expired');f.time(110000);await f.api.drain();assert.equal((await f.api.settings('2')).enabled,false);assert.equal((await f.api.read('2',device)).connected,false);
 await f.on();await f.api.remove('2',device);assert.equal((await f.api.settings('2')).enabled,false);assert.equal(f.state().devices[device],undefined);
});
test('migration preserves the old choice for each registered device without a welcome replay',async()=>{
 for(const enabled of [true,false]){const f=fixture({version:1,keys:{publicKey:'public',privateKey:'private'},devices:{[device]:{subscription,origin:'https://phone.test'}},roots:{'1':{enabled,cutoff:9,devices:{[device]:true}}},jobs:{},claims:{}});await f.api.initialize();assert.equal(f.state().version,2);assert.deepEqual(f.state().roots['1'].devices[device],{enabled,cutoff:9});assert.equal((await f.api.read('2',device)).enabled,enabled);assert.deepEqual(f.state().jobs,{});}
});
test('reads do not expose credentials, endpoints or receipt tokens, and moved roots fail',async()=>{
 const f=fixture();await f.api.initialize();await f.on();const output=JSON.stringify(await f.api.read('2',device));for(const secret of ['private','endpoint','receipt'])assert.equal(output.includes(secret),false);
 await assert.rejects(f.api.configure({goalId:'2',rootId:'9',deviceId:device,enabled:true,subscription,origin:'https://phone.test'}),/moved/);
});
test('Letters and Replies are separate switches; both On by default, both Off turns the device off',async()=>{
 const f=fixture();await f.api.initialize();
 assert.deepEqual(await f.api.read('2',device).then(r=>[r.enabled,r.letters,r.replies]),[false,false,false]);
 await f.on();assert.deepEqual(await f.api.read('2',device).then(r=>[r.letters,r.replies]),[true,true]);assert.deepEqual((await f.api.settings('2')).on,['comment','letter']);
 f.events.push({id:2,goalId:'2',author:'agent',type:'comment',text:'Here is the result'});
 assert.equal((await f.api.prepare('2',2)).handled,true);assert.equal(f.sends.length,1);assert.equal(f.sends[0].title,'An outcome');assert.match(f.sends[0].url,/#\/goal\/2\/letter\/2$/);
 await f.api.kinds({goalId:'2',rootId:'1',deviceId:device,letters:true,replies:false});
 assert.deepEqual((await f.api.settings('2')).on,['letter']);
 f.events.push({id:3,goalId:'2',author:'agent',type:'comment',text:'Progress'});assert.equal((await f.api.prepare('2',3)).handled,false);
 f.events.push({...f.events[0],id:4});await f.api.prepare('2',4);assert.equal(f.sends.length,2);
 await f.api.kinds({goalId:'2',rootId:'1',deviceId:device,letters:false,replies:true});
 f.events.push({...f.events[0],id:5},{id:6,goalId:'2',author:'agent',type:'comment',text:'Another result'});
 assert.equal((await f.api.prepare('2',5)).handled,false);assert.equal((await f.api.prepare('2',6)).handled,true);
 // Both Off is Off for this device, and a later first switch On registers it again.
 const off=await f.api.kinds({goalId:'2',rootId:'1',deviceId:device,letters:false,replies:false});
 assert.deepEqual([off.enabled,off.letters,off.replies],[false,false,false]);assert.equal((await f.api.settings('2')).enabled,false);
 await f.api.configure({goalId:'2',rootId:'1',deviceId:device,enabled:true,subscription:{...subscription,endpoint:subscription.endpoint+device},origin:'https://phone.test',letters:false,replies:true});
 assert.deepEqual(await f.api.read('2',device).then(r=>[r.enabled,r.letters,r.replies]),[true,false,true]);
 // Registering again without switches keeps this device's choice.
 await f.on();assert.deepEqual(await f.api.read('2',device).then(r=>[r.letters,r.replies]),[false,true]);
 await assert.rejects(f.api.kinds({goalId:'2',rootId:'1',deviceId:device,letters:'yes',replies:true}),/Choose Letters and Replies/);
 await assert.rejects(f.api.kinds({goalId:'2',rootId:'1',deviceId:other,letters:true,replies:false}),/Turn notifications on/);
 await assert.rejects(f.api.configure({goalId:'2',rootId:'1',deviceId:other,enabled:true,subscription,origin:'https://phone.test',letters:false,replies:false}),/Letters, Replies or both/);
});

test('earlier choices carry over: every reply keeps both, Letters only keeps Letters',async()=>{
 for(const [scope,expected] of [['replies',[true,true]],['letters',[true,false]],[undefined,[true,true]]]){
  const f=fixture({version:2,keys:{publicKey:'public',privateKey:'private'},devices:{[device]:{subscription,origin:'https://phone.test',expired:false}},roots:{'1':{devices:{[device]:{enabled:true,cutoff:0,...(scope?{scope}:{})}}}},jobs:{},claims:{}});
  await f.api.initialize();assert.deepEqual(await f.api.read('2',device).then(r=>[r.letters,r.replies]),expected);
  f.events.push({id:2,goalId:'2',author:'agent',type:'comment',text:'A reply'});
  assert.equal((await f.api.prepare('2',2)).handled,expected[1]);
 }
});

test('Web sends new Agent replies by itself, once, for Codex and Claude alike',async()=>{
 const f=fixture();f.time(Date.parse('2026-10-14T00:00:00Z'));const at=new Date(Date.parse('2026-10-14T00:00:00Z')).toISOString();
 f.events.push({id:2,goalId:'2',author:'agent',type:'comment',text:'Saved before Web started',updatedAt:at});
 await f.api.initialize();await f.on();f.time(Date.parse('2026-10-14T00:00:06Z'));await f.api.drain();
 assert.deepEqual(f.sends.map(s=>s.body),['Notifications are on for this device.'],'nothing older than the cursor is sent');
 f.events.push({id:3,goalId:'2',author:'user',type:'comment',text:'Mine',updatedAt:at},{id:4,goalId:'2',author:'agent',type:'comment',text:'A reply from Claude',updatedAt:at},{id:5,goalId:'2',author:'agent',type:'letter',title:'Pick one',text:'A or B',updatedAt:at});
 await Promise.all([f.api.drain(),f.api.drain()]);
 assert.deepEqual(f.sends.slice(1).map(s=>[s.title,s.body]),[['An outcome','A reply from Claude'],['Pick one','A or B']]);
 assert.equal((await f.api.prepare('2',4)).handled,false,'an Agent request for the same reply sends nothing more');
 // A reply saved long before Web noticed it (Web was stopped) is not sent late.
 f.events.push({id:6,goalId:'2',author:'agent',type:'comment',text:'Old',updatedAt:new Date(Date.parse(at)-31*60*1000).toISOString()});
 await f.api.drain();assert.equal(f.sends.length,3);
 // Off stops replies for this device.
 await f.off();f.events.push({id:7,goalId:'2',author:'agent',type:'comment',text:'After Off',updatedAt:at});await f.api.drain();assert.equal(f.sends.length,3);
});
test('a new public URL retires old registrations and pending jobs, retaining all devices on the current URL',async()=>{
 const third='00000000-0000-0000-0000-000000000003';
 const f=fixture();await f.api.initialize();f.origin('https://old.trycloudflare.com');
 await f.api.configure({goalId:'2',deviceId:device,enabled:true,subscription,origin:'https://old.trycloudflare.com'});
 f.origin('https://phone.test');await f.api.drain();assert.equal(f.state().devices[device].retired,true);assert.equal((await f.api.read('2',device)).enabled,false);
 await f.on(other);await f.on(third);f.time(105000);await f.api.drain();assert.equal(f.sends.length,2);
 f.events.push({...f.events[0],id:2});await f.api.prepare('2',2);assert.equal(f.sends.length,4);assert.ok(f.sends.every(j=>j.url.startsWith('https://phone.test/')));
 await assert.rejects(f.api.configure({goalId:'2',deviceId:device,enabled:true,subscription,origin:'https://old.trycloudflare.com'}),/latest QR/);
 // Closing the public entrance alone does not turn notifications off.
 f.origin(null);await f.off(other);f.events.push({...f.events[0],id:3});await f.api.prepare('2',3);
 assert.equal(f.sends.length,5);assert.equal(f.sends.at(-1).endpoint,subscription.endpoint+third);
});
test('reset browser identity with the same subscription transfers registration and sends no duplicate confirmation',async()=>{
 const f=fixture();await f.api.initialize();await f.on();
 f.state().roots['9']={devices:{[device]:{enabled:false,cutoff:10}}};
 await f.api.configure({goalId:'2',deviceId:other,enabled:true,subscription:{...subscription,endpoint:subscription.endpoint+device},origin:'https://phone.test'});
 assert.equal(Object.keys(f.state().devices).length,1);assert.equal(f.state().devices[device],undefined);
 assert.deepEqual(f.state().roots['9'].devices[other],{enabled:false,cutoff:10});
 f.time(105000);await f.api.drain();assert.equal(f.sends.length,1);
 f.events.push({...f.events[0],id:2});await Promise.all([f.api.prepare('2',2),f.api.prepare('2',2)]);assert.equal(f.sends.length,2);
 await f.off(other);f.events.push({...f.events[0],id:3});await f.api.prepare('2',3);assert.equal(f.sends.length,2);
});
test('duplicate legacy endpoint entries yield one Letter delivery',async()=>{
 const f=fixture();await f.api.initialize();await f.on();
 f.state().devices[other]=structuredClone(f.state().devices[device]);f.state().roots['1'].devices[other]={enabled:true,cutoff:1};
 f.events.push({...f.events[0],id:2});await f.api.prepare('2',2);assert.equal(f.sends.length,1);
});
test('restart cancels an old scheduled Comment but keeps an already reserved Letter',async()=>{
 const f=fixture();await f.api.initialize();await f.on();
 const j=Object.values(f.state().jobs)[0];j.confirmation=false;j.test=false;j.eventId=null;
 f.state().jobs.letter={...j,id:'letter',url:'https://phone.test/#/goal/2/letter/2'};
 await f.api.initialize();f.time(110000);await f.api.drain();assert.equal(f.sends.length,1);assert.equal(f.sends[0].id,'letter');
});

test('no-reply outcome uses the same once-only Letter delivery and respects Off',async()=>{
 const f=fixture();await f.api.initialize();await f.on();
 f.events.push({...f.events[0],id:2,replyRequired:false,title:'Ready',text:'A usable result'});
 const results=await Promise.all([f.api.prepare('2',2),f.api.prepare('2',2)]);
 assert.equal(results.filter(r=>r.handled).length,1);assert.equal(f.sends.length,1);
 assert.equal(f.sends[0].title,'Ready');assert.match(f.sends[0].url,/#\/goal\/2\/letter\/2$/);
 await f.off();f.events.push({...f.events[1],id:3});await f.api.prepare('2',3);assert.equal(f.sends.length,1);
});

test('local notification permission is scoped to the automatic project port',async t=>{
 const {prepareProject,workspacePort}=await import('../lib/project-workspace.mjs');const {mkdtemp,mkdir,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const base=await mkdtemp(join(tmpdir(),'chill-webpush-port-')),oldDir=process.env.CHILL_AGENT_DATA_DIR,oldPort=process.env.PORT;
 t.after(async()=>{if(oldDir===undefined)delete process.env.CHILL_AGENT_DATA_DIR;else process.env.CHILL_AGENT_DATA_DIR=oldDir;if(oldPort===undefined)delete process.env.PORT;else process.env.PORT=oldPort;await rm(base,{recursive:true,force:true});});
 const project=join(base,'project');await mkdir(project);process.env.CHILL_AGENT_DATA_DIR=await prepareProject(project,{base});delete process.env.PORT;
 const f=fixture(),port=workspacePort(),input={goalId:'2',rootId:'1',enabled:true,deviceId:device,subscription};
 await f.api.configure({...input,origin:`http://127.0.0.1:${port}`});
 await assert.rejects(f.api.configure({...input,origin:`http://127.0.0.1:${port===43199?43200:43199}`}),/Use HTTPS or the local workspace/);
});
