import {callerOwns,agentFor,agentKey as defaultAgentKey} from './agents/index.mjs';
import {hidden} from './hidden-failure.mjs';
import webpush from 'web-push';
import {randomUUID} from 'node:crypto';
import {storage,readGoalContext,readFeedback,readEventsSince,readPublicOrigin,touch,requireProtocol,workspacePort,listGoals} from './extension-api.mjs';
requireProtocol(1);
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value);
// For each Root, each browser chooses what its count shows: Letters (questions
// that need an answer) and Replies (every other Agent post). Notification On
// sends that browser what its count shows. Earlier choices carry over: Letters
// only keeps Letters; every reply, or no saved choice, keeps both.
const kindOf=event=>event.type==='letter'?'letters':'replies';
export function kindsOf(choice){
 if(!choice?.enabled)return {letters:false,replies:false};
 if(typeof choice.letters==='boolean'&&typeof choice.replies==='boolean')return {letters:choice.letters,replies:choice.replies};
 return {letters:true,replies:choice.scope!=='letters'};
}
// What a browser's count shows. Both count until it switches one off.
export const countsOf=choice=>typeof choice?.letters==='boolean'&&typeof choice?.replies==='boolean'?{letters:choice.letters,replies:choice.replies}:{letters:true,replies:true};
const reply=event=>event?.author==='agent'&&['comment','letter'].includes(event.type);
// Whether the Root's agent is at work on this Root. Replies saved meanwhile wait
// for the work to end; work only in its other Roots holds nothing here. An agent that chill continues by polling (live continuation) pauses
// briefly between turns, so for it the end must last a while.
const working=['working','queued','checking'];
async function rootActivity(root){
 const agent=agentFor(root);if(!agent)return {running:false,settleMs:0};
 const {status,elsewhere}=await agent.presence(root.id).catch(hidden('web-notifications.activity',{status:'unknown'}));
 return {running:working.includes(status)&&!elsewhere,settleMs:agent.continuation?.live?45000:0};
}
const readThroughFor=async goalId=>(await import('./read-marks.mjs')).readThroughFor(goalId);
export function validateSubscription(value){
 try{
  // Chrome 156 subscribes on Google hosts such as jmt17.google.com, not only FCM.
  const url=new URL(value.endpoint),providers=['fcm.googleapis.com','google.com','push.apple.com','push.services.mozilla.com','notify.windows.com'];
  if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443')||url.hash||value.endpoint.length>4096||!providers.some(h=>url.hostname===h||url.hostname.endsWith(`.${h}`)))throw Error();
  const keys=value.keys;if(!keys||!['auth','p256dh'].every(k=>typeof keys[k]==='string'&&/^[A-Za-z0-9_-]+={0,2}$/.test(keys[k])))throw Error();
  const pub=Buffer.from(keys.p256dh,'base64url');if(Buffer.from(keys.auth,'base64url').length!==16||pub.length!==65||pub[0]!==4)throw Error();
  return {endpoint:url.href,keys:{auth:keys.auth,p256dh:keys.p256dh}};
 }catch{throw Error('This browser returned an unsupported push subscription.');}
}
const initial=()=>({version:3,keys:null,devices:{},roots:{},jobs:{},claims:{}});
// The Goals of a Root's tree, so a notification can find a tab showing any of
// them from its address. They are ordered by steps through the tree from the
// notified Goal, so when a very large tree does not fit in a push, only tabs
// far from it fall back to a new tab.
export function nearestGoalIds(goals,rootId,goalId){
 const children=new Map(),parent=new Map(),inTree=new Set([String(rootId)]);
 for(const g of goals){parent.set(String(g.id),String(g.parentId));if(!children.has(String(g.parentId)))children.set(String(g.parentId),[]);children.get(String(g.parentId)).push(String(g.id));}
 for(const id of inTree)for(const child of children.get(id)||[])inTree.add(child);
 const ids=[inTree.has(String(goalId))?String(goalId):String(rootId)],seen=new Set(ids);
 for(let i=0;i<ids.length;i++)for(const next of [parent.get(ids[i]),...(children.get(ids[i])||[])])if(inTree.has(next)&&!seen.has(next)){seen.add(next);ids.push(next);}
 return ids;
}
const treeGoalIds=async(rootId,goalId)=>nearestGoalIds(await listGoals(),rootId,goalId);
// A push carries at most about 4 KB, and a larger one is refused. The ids fill
// what the rest leaves under a safe limit.
export const pushLimit=3500;
export function pushPayload(job,ids){
 const payload={id:job.id,receipt:job.receipt,title:Array.from(job.title||'').slice(0,120).join(''),body:job.message,url:job.url,rootId:job.rootId,goalIds:[]};
 let size=Buffer.byteLength(JSON.stringify(payload));
 for(const id of ids){const n=Number(id),more=String(n).length+1;if(!Number.isSafeInteger(n)||size+more>pushLimit)break;payload.goalIds.push(n);size+=more;}
 return JSON.stringify(payload);
}
export function createWebNotifications({goalIds=treeGoalIds,activity=rootActivity,readThrough=readThroughFor,store=storage('web-notifications'),context=readGoalContext,events=readFeedback,eventsSince=readEventsSince,publicOrigin=readPublicOrigin,use=touch,now=Date.now,owns=root=>callerOwns(root),agentKey=defaultAgentKey,recentMs=30*60*1000,generateKeys=()=>webpush.generateVAPIDKeys(),send=(subscription,payload,keys)=>webpush.sendNotification(subscription,payload,{TTL:300,urgency:'normal',timeout:15000,vapidDetails:{subject:'https://github.com/game-dev-rta-club/chill-agent',...keys}})}={}){
 let busy=0;
 async function state(){const s=await store.read('1')||initial();if(s.version===1){for(const r of Object.values(s.roots)){r.devices=Object.fromEntries(Object.keys(r.devices||{}).map(id=>[id,{enabled:Boolean(r.enabled),cutoff:r.cutoff||0}]));delete r.enabled;delete r.cutoff;}s.version=2;}
  // Letters and Replies were Off on every Off device; now they say what its count shows.
  if(s.version===2){for(const r of Object.values(s.roots))for(const c of Object.values(r.devices||{})){if(c.enabled)Object.assign(c,kindsOf(c));else{delete c.letters;delete c.replies;}delete c.scope;}s.version=3;}
  if(s.version!==3)throw Error('Unsupported Web notification data.');return s;}
 const change=fn=>store.lock('1',async()=>{const s=await state();await syncOrigin(s);const result=await fn(s);await store.write('1',s);return result;});
 const cutoff=async()=>Math.max(0,...(await events()).map(e=>e.id));
 const active=(s,r,id)=>Boolean(r?.devices?.[id]?.enabled&&s.devices[id]&&!s.devices[id].expired&&!s.devices[id].retired);
 const usable=(s,r)=>Object.keys(r?.devices||{}).some(id=>active(s,r,id));
 async function syncOrigin(s){
  const origin=await publicOrigin();if(origin)s.publicOrigin=origin;
  if(!s.publicOrigin)return;
  for(const [id,d] of Object.entries(s.devices))if(d.origin.startsWith('https:')&&d.origin!==s.publicOrigin){
   d.retired=true;
   for(const j of Object.values(s.jobs))if(j.deviceId===id&&j.status==='scheduled')j.status='cancelled';
  }
 }
 const deliverable=j=>j.test||j.confirmation||Number.isSafeInteger(j.eventId)||/#\/goal\/\d+\/letter\/\d+$/.test(j.url||'');
 function visible(job){return {id:job.id,title:job.title,at:job.at,status:job.status,receivedAt:job.receivedAt||null,clickedAt:job.clickedAt||null,error:job.error||null,test:job.test};}
 async function rootFor(goalId,rootId){const ctx=await context(goalId);if(rootId&&ctx.root.id!==rootId)throw Error('Goal moved. Refresh to retry.');return ctx;}
 function prune(s){const terminal=Object.values(s.jobs).filter(j=>!['scheduled','sending'].includes(j.status)).sort((a,b)=>b.at-a.at);for(const j of terminal.slice(200))delete s.jobs[j.id];for(const [id] of Object.entries(s.claims).sort(([,a],[,b])=>b.at-a.at).slice(1000))delete s.claims[id];}
 async function dispatch(id){
  busy++;
  try{
   const reservation=await change(s=>{
    const j=s.jobs[id];if(!j||j.status!=='scheduled'||j.dueAt>now())return null;
    const r=s.roots[j.rootId],d=s.devices[j.deviceId];
    if(!active(s,r,j.deviceId)||!deliverable(j)){j.status='cancelled';return null;}
    j.status='sending';return {job:structuredClone(j),device:structuredClone(d),keys:s.keys};
   });
   if(!reservation)return;
   const {job,device,keys}=reservation;
   try{
    const tree=await goalIds(job.rootId,job.goalId).catch(()=>[]);
    await send(device.subscription,pushPayload(job,tree),keys);
    await change(s=>{const j=s.jobs[id];if(j&&j.status==='sending')j.status='accepted';});
   }catch(error){await change(s=>{const j=s.jobs[id];if(!j||['received','clicked'].includes(j.status))return;j.status='failed';j.error=[404,410].includes(error.statusCode)?'Subscription expired. Turn notifications on again.':'Push service did not confirm acceptance.';if([404,410].includes(error.statusCode)&&s.devices[j.deviceId])s.devices[j.deviceId].expired=true;});}
  }finally{busy--;}
 }
 function reserve(s,{root,goal,deviceId,title,message,eventId=null,test=false,confirmation=false}){
  const d=s.devices[deviceId],id=randomUUID();
  const suffix=eventId?`/letter/${eventId}`:'';
  s.jobs[id]={id,receipt:randomUUID(),rootId:root.id,goalId:goal.id,deviceId,eventId,title,message,test,confirmation,at:now(),dueAt:now()+(test||confirmation?5000:0),status:'scheduled',url:`${d.origin}/#/goal/${goal.id}${suffix}`};
  prune(s);return id;
 }
 // One claim per event, whether the Agent asked (prepare) or Web noticed the
 // reply first (scan): each subscription receives a reply at most once, and
 // only replies saved after that device was turned On. Every claimed reply
 // counts as unread, whether or not a device was sent it.
 function claim(s,root,goal,event,more=0){
  if(s.claims[event.id])return [];
  s.claims[event.id]={at:now(),rootId:root.id,...(kindOf(event)==='replies'?{reply:true}:{})};prune(s);
  const endpoints=new Set(),r=s.roots[root.id];
  const ids=Object.keys(r?.devices||{}).filter(id=>{
   const choice=r.devices[id];if(!active(s,r,id)||event.id<=choice.cutoff||!kindsOf(choice)[kindOf(event)])return false;
   const endpoint=s.devices[id].subscription.endpoint;if(endpoints.has(endpoint))return false;endpoints.add(endpoint);return true;
  }).map(deviceId=>reserve(s,{root,goal,deviceId,title:event.title||goal.title,message:Array.from(event.text||'').slice(0,350).join('')+(more?`\n(+${more} more ${more===1?'reply':'replies'})`:''),eventId:event.id}));
  return ids;
 }
 // New Agent replies reach enabled devices without an Agent command, for Codex
 // and Claude alike. The cursor starts at the end of the Conversation, and
 // replies older than the recent window (saved while Web was stopped) are not sent late.
 async function scan(){
  const s0=await state();
  // Most ticks see no new event and read nothing else.
  const seen=Number.isSafeInteger(s0.cursor)?await eventsSince(s0.cursor):null;
  if(seen&&!seen.events.length)return;
  // The agents' activity is read before taking the store lock.
  const running=new Map();
  for(const event of seen?.events||[])if(reply(event)&&kindOf(event)==='replies'){
   let found;try{found=await context(event.goalId);}catch{continue;}
   if(!running.has(found.root.id))running.set(found.root.id,(await activity(found.root)).running);
  }
  const ids=await change(async s=>{
   if(!Number.isSafeInteger(s.cursor)){s.cursor=(await eventsSince(Number.MAX_SAFE_INTEGER)).cursor;return [];}
   const fresh=await eventsSince(s.cursor);s.cursor=fresh.cursor;
   const ids=[];
   for(const event of fresh.events){
    if(!reply(event)||s.claims[event.id]||now()-Date.parse(event.updatedAt)>recentMs)continue;
    let found;try{found=await context(event.goalId);}catch{continue;}
    if(kindOf(event)==='replies'&&running.get(found.root.id)){hold(s,found.root,event);continue;}
    ids.push(...claim(s,found.root,found.goal,event));
   }
   return ids;
  });
  await Promise.all(ids.map(dispatch));
 }
 // A reply saved while its Root's agent works waits for the work to end, in the
 // count as in a notification. Letters never wait: they ask for an answer.
 function hold(s,root,event){(s.held??={})[event.id]={rootId:root.id,goalId:event.goalId,at:now()};}
 // When the work ends, the replies still unread become one notification per
 // device: the newest, saying how many more there are. Every one of them then
 // counts as unread, so the count matches what was announced.
 async function release(){
  const s0=await state(),held=Object.values(s0.held||{});if(!held.length)return;
  const checks=new Map();
  for(const h of held)if(!checks.has(h.rootId)){
   let found;try{found=await context(h.goalId);}catch{checks.set(h.rootId,{gone:true});continue;}
   checks.set(h.rootId,found.root.id===h.rootId?{root:found.root,...await activity(found.root)}:{gone:true});
  }
  // Every Root's work holds replies, so a tick with nothing to do writes nothing.
  if(![...checks.values()].some(c=>c.gone||!c.running)&&!Object.keys(s0.settle||{}).length)return;
  const ids=await change(async s=>{
   s.settle??={};const out=[];
   for(const [rootId,check] of checks){
    const entries=Object.entries(s.held||{}).filter(([,h])=>h.rootId===rootId).map(([id,h])=>({...h,id:Number(id)}));
    if(!entries.length||check.gone){for(const e of entries)delete s.held[e.id];delete s.settle[rootId];continue;}
    if(check.running){delete s.settle[rootId];continue;}
    if(check.settleMs){s.settle[rootId]??=now();if(now()-s.settle[rootId]<check.settleMs)continue;}
    delete s.settle[rootId];for(const e of entries)delete s.held[e.id];
    const all=new Map((await events()).map(e=>[e.id,e])),unread=[];
    for(const e of entries.sort((a,b)=>a.id-b.id)){const event=all.get(e.id);if(event&&!event.deletedAt&&!s.claims[e.id]&&event.id>await readThrough(event.goalId))unread.push(event);}
    if(!unread.length)continue;
    const newest=unread.at(-1),others=unread.slice(0,-1);
    let found;try{found=await context(newest.goalId);}catch{continue;}
    const sent=claim(s,found.root,found.goal,newest,others.length);out.push(...sent);
    for(const event of others)s.claims[event.id]={at:now(),rootId,reply:true};
   }
   return out;
  });
  await Promise.all(ids.map(dispatch));
 }
 const replyTypes=(s,r)=>[...new Set(Object.keys(r?.devices||{}).filter(id=>active(s,r,id)).flatMap(id=>{const k=kindsOf(r.devices[id]);return [...(k.replies?['comment']:[]),...(k.letters?['letter']:[])];}))];
 return {
  // Replies (not Letters) past the wait for their Root's work: what a count shows.
  announcedReplies:async()=>new Set(Object.entries((await state()).claims).filter(([,c])=>c.reply).map(([id])=>Number(id))),
  busy:async()=>busy>0||Object.values((await state()).jobs).some(j=>j.status==='scheduled'),
  async initialize(){await change(async s=>{s.keys??=generateKeys();s.cursor??=(await eventsSince(Number.MAX_SAFE_INTEGER)).cursor;for(const j of Object.values(s.jobs)){if(j.status==='sending')j.status='unconfirmed';if(j.status==='scheduled'&&!deliverable(j))j.status='cancelled';}});},
  // What each Root's count shows in this browser.
  async counts(clientId){const s=await state();return rootId=>countsOf(s.roots[rootId]?.devices?.[clientId]);},
  async settings(goalId){const s=await state();await syncOrigin(s);if(!goalId)return {enabled:Object.values(s.roots).some(r=>usable(s,r)),on:[...new Set(Object.values(s.roots).flatMap(r=>replyTypes(s,r)))]};const {root}=await context(goalId);return {rootId:root.id,selected:Object.values(s.roots[root.id]?.devices||{}).some(c=>'cutoff' in c),enabled:Boolean(usable(s,s.roots[root.id])),on:replyTypes(s,s.roots[root.id])};},
  async control(goalId,{clientId=null}={}){const {root}=await context(goalId),s=await state();await syncOrigin(s);return {rootId:root.id,enabled:active(s,s.roots[root.id],clientId),...countsOf(s.roots[root.id]?.devices?.[clientId]),publicKey:s.keys?.publicKey,placement:'letters',menu:false,manifest:'/extensions/web-notifications/manifest.webmanifest',icon:'bell',panelModule:'/extensions/web-notifications/panel.js',description:'Send what the count shows to this browser.'};},
  async read(goalId,deviceId){const {root}=await context(goalId),s=await state(),r=s.roots[root.id];await syncOrigin(s);return {rootId:root.id,enabled:active(s,r,deviceId),connected:Boolean(r?.devices?.[deviceId]&&s.devices[deviceId]&&!s.devices[deviceId].expired&&!s.devices[deviceId].retired),publicKey:s.keys?.publicKey,...countsOf(r?.devices?.[deviceId]),
   history:Object.values(s.jobs).filter(j=>j.rootId===root.id&&j.deviceId===deviceId).sort((a,b)=>b.at-a.at).slice(0,10).map(visible)};},
  async configure({goalId,rootId,enabled,deviceId,subscription,origin,letters,replies}){
   if(typeof enabled!=='boolean')throw Error('Choose On or Off.');
   if([letters,replies].some(v=>v!==undefined&&typeof v!=='boolean'))throw Error('Choose Letters and Replies.');
   if(!uuid(deviceId))throw Error('Invalid device registration.');
   const {root,goal}=await rootFor(goalId,rootId);
   const normalized=enabled?validateSubscription(subscription):null;
   const originUrl=enabled?new URL(origin):null;
   if(enabled&&!(originUrl.protocol==='https:'||originUrl.origin===`http://127.0.0.1:${workspacePort()}`))throw Error('Use HTTPS or the local workspace.');
   await change(async s=>{
    await rootFor(goalId,root.id);s.keys??=generateKeys();
    if(enabled&&originUrl.protocol==='https:'&&s.publicOrigin&&originUrl.origin!==s.publicOrigin)throw Error('This link has changed. Scan the latest QR on your computer.');
    const r=s.roots[root.id]||{devices:{}};let wasEnabled=active(s,r,deviceId);
    if(enabled){
     const existing=s.devices[deviceId];if(existing&&existing.origin!==originUrl.origin)throw Error('Register this device from its original URL.');
     // One browser subscription has one recipient, even if its local ID was reset.
     for(const [id,d] of Object.entries(s.devices))if(id!==deviceId&&d.subscription.endpoint===normalized.endpoint){
      if(d.origin!==originUrl.origin)throw Error('Register this device from its original URL.');
      wasEnabled ||= active(s,r,id);
      // A new ID that only chose its count keeps that choice, and the old ID's notifications.
      for(const x of Object.values(s.roots)){const mine=x.devices[deviceId];if(x.devices[id]&&!(mine&&'cutoff' in mine))x.devices[deviceId]={...x.devices[id],...(mine&&{letters:mine.letters,replies:mine.replies})};delete x.devices[id];}
      for(const j of Object.values(s.jobs))if(j.deviceId===id&&j.status==='scheduled')j.deviceId=deviceId;
      delete s.devices[id];
     }
     if(!existing&&Object.values(s.devices).filter(d=>!d.retired).length>=30)throw Error('Device limit reached. Remove an old device first.');
     s.devices[deviceId]={subscription:normalized,origin:originUrl.origin,expired:false};
    }
    const choice=r.devices[deviceId]||{enabled:false,cutoff:0},kept=countsOf(choice);
    // Notification sends what the count shows, so a count with nothing in it sends nothing.
    Object.assign(choice,{letters:letters??kept.letters,replies:replies??kept.replies});
    if(enabled&&!choice.letters&&!choice.replies)throw Error('Turn on Letters, Replies or both.');
    if(choice.enabled!==enabled||(enabled&&!wasEnabled))choice.cutoff=await cutoff();
    choice.enabled=enabled;delete choice.scope;r.devices[deviceId]=choice;s.roots[root.id]=r;
    if(!enabled)for(const j of Object.values(s.jobs))if(j.rootId===root.id&&j.deviceId===deviceId&&j.status==='scheduled')j.status='cancelled';
    if(enabled&&!wasEnabled)reserve(s,{root,goal,deviceId,title:'chill-agent',message:'Notifications are on for this device.',confirmation:true});
   });await use();return this.read(goalId,deviceId);
  },
  // Switch what this browser's count shows, with or without notifications.
  // Turning both off also turns Notification Off: this device's pending
  // notifications are cancelled, as with configure.
  async kinds({goalId,rootId,deviceId,letters,replies}){
   if(typeof letters!=='boolean'||typeof replies!=='boolean')throw Error('Choose Letters and Replies.');
   if(!uuid(deviceId))throw Error('Invalid device registration.');
   const {root}=await rootFor(goalId,rootId);
   await change(s=>{
    const r=s.roots[root.id]??={devices:{}},choice=r.devices[deviceId]??={enabled:false};
    Object.assign(choice,{letters,replies});delete choice.scope;
    if(!letters&&!replies){choice.enabled=false;for(const j of Object.values(s.jobs))if(j.rootId===root.id&&j.deviceId===deviceId&&j.status==='scheduled')j.status='cancelled';}
   });
   await use();return this.read(goalId,deviceId);
  },
  async remove(goalId,deviceId){const {root}=await context(goalId);await change(s=>{delete s.roots[root.id]?.devices[deviceId];if(!Object.values(s.roots).some(r=>r.devices?.[deviceId]))delete s.devices[deviceId];for(const j of Object.values(s.jobs))if(j.rootId===root.id&&j.deviceId===deviceId&&j.status==='scheduled')j.status='cancelled';});await use();return this.read(goalId,deviceId);},
  async test(goalId,deviceId){const {root,goal}=await context(goalId);return change(s=>{
   const r=s.roots[root.id];if(!active(s,r,deviceId))throw Error('Turn notifications on for this device first.');
   const previous=Object.values(s.jobs).filter(j=>j.deviceId===deviceId&&j.test).sort((a,b)=>b.at-a.at)[0];
   if(previous&&now()-previous.at<15000)throw Error('Wait a few seconds before another test.');
   const id=reserve(s,{root,goal,deviceId,title:'chill-agent',message:'Your test notification arrived.',test:true});return visible(s.jobs[id]);
  });},
  async acknowledge(id,receipt,kind){if(!['received','clicked'].includes(kind))throw Error('Invalid receipt.');await change(s=>{const j=s.jobs[id];if(!j||receipt!==j.receipt||!['sending','accepted','unconfirmed','received','clicked'].includes(j.status))return;if(!j.receivedAt)j.receivedAt=now();if(kind==='clicked')j.clickedAt=now();j.status=j.clickedAt?'clicked':'received';});return {ok:true};},
  async prepare(goalId,eventId){
   const {root,goal}=await context(goalId);if(!agentKey(root)||!await owns(root))throw Error('Use the assigned Agent chat for this notification.');
   const {running}=await activity(root);let held=false;
   const ids=await change(async s=>{
    const fresh=await context(goalId);if(fresh.root.id!==root.id||agentKey(fresh.root)!==agentKey(root))throw Error('Goal or Agent changed.');
    if(!usable(s,s.roots[root.id]))return [];
    const event=(await events()).find(e=>e.id===eventId&&e.goalId===goal.id&&e.author==='agent');if(!event)throw Error('Save an Agent Comment or Letter first.');
    if(running&&kindOf(event)==='replies'&&!s.claims[event.id]){hold(s,root,event);held=true;return [];}
    return claim(s,root,goal,event);
   });
   await Promise.all(ids.map(dispatch));
   if(held)return {enabled:false,handled:true,held:true,delivery:'web-push',results:[],note:'Held until your work ends; Web sends it then if it is still unread. Do not send it through a host tool.'};
   const s=await state();return {enabled:false,handled:ids.length>0,delivery:'web-push',results:ids.map(id=>visible(s.jobs[id])),note:'Web Push was handled here. Do not send it again through a host tool.'};
  },
  async drain(){const s=await state(),origin=await publicOrigin();if(origin&&s.publicOrigin!==origin)await change(()=>{});await scan();await release();for(const j of Object.values(s.jobs))if(j.status==='scheduled'&&j.dueAt<=now())await dispatch(j.id);},
 };
}
export const webNotifications=createWebNotifications();
export function createExtension(){
 let timer,running=null,stopped=false;
 async function tick(){if(stopped||running)return;running=webNotifications.drain();try{await running;}catch(error){console.error('Web notifications:',error.message);}finally{running=null;}}
 const types={'panel.js':'text/javascript; charset=utf-8','sw.js':'text/javascript; charset=utf-8','manifest.webmanifest':'application/manifest+json','icon-192.png':'image/png','icon-512.png':'image/png'};
 return {id:'web-notifications',label:'Notifications',assets:Object.fromEntries(Object.entries(types).map(([file,type])=>[file,{file:new URL(`../extensions/web-notifications/${file}`,import.meta.url),type,...(file==='sw.js'?{scope:'/'}:{})}])),
  async start(){await webNotifications.initialize();timer=setInterval(tick,1000);timer.unref();void tick();},
  async stop(){stopped=true;clearInterval(timer);await running;},busy:async()=>Boolean(running)||await webNotifications.busy(),
  read:(id,options)=>webNotifications.control(id,options),set:()=>{throw Error('Use the Notification menu to turn notifications on for this browser.');},
  async request({method,path,body,origin}){
   if(method!=='POST')return {status:404,body:{error:'Not found.'}};
   if(path==='state')return {body:await webNotifications.read(body.goalId,body.deviceId)};
   if(path==='toggle')return {body:await webNotifications.configure({...body,origin})};
   if(path==='kinds')return {body:await webNotifications.kinds(body)};
   if(path==='remove')return {body:await webNotifications.remove(body.goalId,body.deviceId)};
   if(path==='test')return {body:await webNotifications.test(body.goalId,body.deviceId)};
   if(path==='receipt')return {body:await webNotifications.acknowledge(body.id,body.receipt,body.kind)};
   return {status:404,body:{error:'Not found.'}};
  },
 };
}
