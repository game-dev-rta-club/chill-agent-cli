import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {once} from 'node:events';
import {mkdtemp,mkdir,chmod,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createGoal,appendFeedback} from '../lib/goal-store.mjs';
import {prepareDelivery,deliverFeedback,readDeliveryState,updateDelivery,collectHookFeedback} from '../lib/delivery.mjs';
import {pauseFeedback,readFeedbackHold,resumeHeldFeedback,reconcileFeedbackHold} from '../lib/feedback-hold.mjs';
import {withCodex} from '../lib/codex-client.mjs';
import {readAgentActivity,invalidateActivity} from '../lib/agent-activity.mjs';
const thread='00000000-0000-0000-0000-000000000001',turn='00000000-0000-0000-0000-000000000002';
async function fixture(run){
 const dir=await mkdtemp(join(tmpdir(),'chill-hold-')),saved={...process.env};
 process.env.CHILL_AGENT_DATA_DIR=dir;process.env.CHILL_AGENT_CODEX_PATH=new URL('./fake-codex.mjs',import.meta.url).pathname;process.env.CODEX_HOME=dir;
 await mkdir(join(dir,'ipc'),{recursive:true,mode:0o700});const path=join(dir,'ipc/ipc.sock');let requests=[],dropStart=false;
 const history=async value=>writeFile(join(dir,'fake-history.json'),JSON.stringify(value));
 await history({turns:[{id:turn,completedAt:null,status:'inProgress',items:[]}],items:{}});
 const server=net.createServer(socket=>{let bytes=Buffer.alloc(0),chain=Promise.resolve();socket.on('data',chunk=>{
  bytes=Buffer.concat([bytes,chunk]);while(bytes.length>=4&&bytes.length>=bytes.readUInt32LE()+4){const size=bytes.readUInt32LE(),m=JSON.parse(bytes.subarray(4,size+4));bytes=bytes.subarray(size+4);chain=chain.then(async()=>{
   let result={};requests.push(m);
   if(m.method==='initialize')result={clientId:'test'};
   if(m.method==='thread-follower-interrupt-turn'){
    const h=JSON.parse(await readFile(join(dir,'fake-history.json'),'utf8')),t=h.turns[0];
    const match=t&&t.id===m.params.expectedTurnId&&t.completedAt==null;
    if(match){t.completedAt=123;t.status='interrupted';await history(h);}
    result={ok:true,interruptedTurnId:match?t.id:null};
   }
   if(m.method==='thread-follower-start-turn'){
    const id=randomUUID(),input=m.params.turnStart.request.input;
    assert.ok(input.every(p=>p.type!=='text'||Array.isArray(p.text_elements)));
    await history({turns:[{id,completedAt:null,status:'inProgress',items:[{type:'userMessage',content:input}]}],items:{[id]:[{turnId:id,item:{type:'userMessage',content:input}}]}});
    result={result:{turn:{id}}};if(dropStart){socket.destroy();return;}
   }
   const body=Buffer.from(JSON.stringify({type:'response',requestId:m.requestId,resultType:'success',result})),header=Buffer.alloc(4);header.writeUInt32LE(body.length);socket.write(Buffer.concat([header,body]));
  }).catch(e=>{socket.destroy(e);});}
 });});
 server.listen(path);await once(server,'listening');await chmod(path,0o600);
 try{
  const root=await createGoal({title:'Root',threadId:thread}),child=await createGoal({title:'Other',parentId:root.id});
  const feedback=async(text,goalId=root.id)=>{const e=await appendFeedback({goalId,text});await prepareDelivery(e);return e;};
  await run({dir,history,requests,root,child,feedback,drop:()=>{dropStart=true},queue:()=>withCodex(c=>c.request('thread/queue/list',{threadId:thread,limit:100})),stop:e=>pauseFeedback(e.goalId,{action:'stop',eventId:e.changeId,threadId:thread,turnId:null,requestId:randomUUID()},{goalId:e.goalId})});
 }finally{invalidateActivity(thread);server.close();process.env=saved;await rm(dir,{recursive:true,force:true});}
}
test('queued pause preserves comments; next comment and held input become one queue entry without touching other Goal',()=>fixture(async f=>{
 const a=await f.feedback('Make it blue'),other=await f.feedback('Other work',f.child.id);
 await deliverFeedback(a.changeId);await deliverFeedback(other.changeId);
 invalidateActivity(thread);const activity=await readAgentActivity(a.goalId,{fresh:true});assert.equal(activity.status,'queued');assert.equal(activity.capabilities.stop,true);
 await f.stop(a);assert.equal((await readAgentActivity(a.goalId)).status,'paused');
 let pending=await f.queue();assert.equal(pending.data.length,1);assert.match(pending.data[0].input[0].text,/Other work/);
 assert.equal((await readFeedbackHold(a.goalId)).phase,'paused');
 assert.deepEqual((await collectHookFeedback({threadId:thread,turnId:turn})).map(e=>e.eventId),[other.changeId],'Unselected Goals are offered while manually paused input stays held');
 const stored=JSON.parse(await readFile(join(f.dir,'workspace/events',a.changeId+'.json'),'utf8'));assert.equal(stored.text,'Make it blue');
 const b=await f.feedback('Actually green and small');await deliverFeedback(b.changeId);
 pending=await f.queue();assert.equal(pending.data.length,2);
 const merged=pending.data[1].input[0].text;assert.ok(merged.indexOf('Make it blue')<merged.indexOf('Actually green and small'));assert.ok(merged.startsWith('=== chill-agent · User Feedback ===\n'));assert.doesNotMatch(merged,/chill-batch:|PauseしていたGoal/);
 assert.equal((merged.match(/^=== Message ===$/gm)||[]).length,1);
 const payload=JSON.parse(merged.match(/```json\n([\s\S]*?)\n```/)[1]);
 assert.deepEqual(payload.messages.map(m=>[m.eventId,m.text]),[[a.changeId,'Make it blue'],[b.changeId,'Actually green and small']]);
 assert.doesNotMatch(merged,/Other work/);assert.equal(f.requests.filter(r=>r.method==='thread-follower-interrupt-turn'&&r.params.expectedTurnId===turn).length,0);
 assert.equal((await readDeliveryState(a.changeId)).batchId,(await readDeliveryState(b.changeId)).batchId);
 assert.deepEqual(await collectHookFeedback({threadId:thread,turnId:turn}),[],'Resumed bundles keep one native delivery and are not split into hook notices');
 await deliverFeedback(b.changeId);assert.equal((await f.queue()).data.length,2);
}));
test('saved input can be paused before dispatch and resumed without a new comment',()=>fixture(async f=>{
 const a=await f.feedback('Not dispatched');await f.stop(a);await deliverFeedback(a.changeId);assert.equal((await f.queue()).data.length,0);
 const h=await readFeedbackHold(a.goalId);await resumeHeldFeedback(a.goalId,{threadId:thread,holdId:h.id});assert.equal((await f.queue()).data.length,1);
 await assert.rejects(resumeHeldFeedback(a.goalId,{threadId:thread,holdId:h.id}));assert.equal((await f.queue()).data.length,1);
}));
test('running pause and supplement start one normalized IPC turn; lost start response is reconciled without resend',()=>fixture(async f=>{
 const a=await f.feedback('Original task');await deliverFeedback(a.changeId);
 const s=await readDeliveryState(a.changeId),item={type:'userMessage',content:[{type:'text',text:`[chill-agent:${s.messageId}]`}]};
 await f.history({turns:[{id:turn,completedAt:null,status:'inProgress',items:[item]}],items:{[turn]:[{turnId:turn,item}]}});
 await updateDelivery(a.changeId,{turnId:turn});await f.stop(a);
 assert.equal((await readFeedbackHold(a.goalId)).phase,'paused');
 const b=await f.feedback('Supplement');f.drop();await assert.rejects(deliverFeedback(b.changeId));
 assert.equal((await readFeedbackHold(a.goalId)).phase,'uncertain');
 await reconcileFeedbackHold(a.goalId);assert.equal((await readFeedbackHold(a.goalId)).phase,'sent');
 await deliverFeedback(b.changeId);assert.equal(f.requests.filter(r=>r.method==='thread-follower-start-turn').length,1);
 const text=f.requests.find(r=>r.method==='thread-follower-start-turn').params.turnStart.request.input[0].text;
 assert.match(text,/Original task/);assert.match(text,/Supplement/);assert.equal((await f.queue()).data.length,0);
 assert.ok((await readDeliveryState(a.changeId)).batchTurnId);
}));
test('a missing unconfirmed queued input is never claimed paused or replayed',()=>fixture(async f=>{
 const a=await f.feedback('Unknown dispatch');await updateDelivery(a.changeId,{mayHaveSent:true,status:'queued'});
 await assert.rejects(f.stop(a),/Queue removal unconfirmed/);assert.equal((await readFeedbackHold(a.goalId)).phase,'uncertain');
 const b=await f.feedback('Supplement');await assert.rejects(deliverFeedback(b.changeId),/Checking/);assert.equal((await f.queue()).data.length,0);
}));

test('pausing an already bundled queue retains every member through another supplement',()=>fixture(async f=>{
 const a=await f.feedback('A');await deliverFeedback(a.changeId);await f.stop(a);
 const b=await f.feedback('B');await deliverFeedback(b.changeId);
 await updateDelivery(a.changeId,{agentReported:true,status:'completed'});
 await f.stop(b);assert.deepEqual((await readFeedbackHold(a.goalId)).eventIds,[a.changeId,b.changeId]);
 const c=await f.feedback('C');await deliverFeedback(c.changeId);
 const pending=await f.queue();assert.equal(pending.data.length,1);
 for(const e of [a,b,c])assert.ok(pending.data[0].input[0].text.includes(`Feedback: #${e.changeId}`));
 assert.equal((await readDeliveryState(a.changeId)).status,'completed','already completed receipt is not reset');
}));
test('queue claim races pause: stop only the turn containing the selected input',()=>fixture(async f=>{
 const a=await f.feedback('Race');await deliverFeedback(a.changeId);
 process.env.CHILL_TEST_START_ON_DELETE='1';await f.stop(a);
 const h=await readFeedbackHold(a.goalId);assert.equal(h.phase,'paused');assert.equal(h.sourceTurnId,'00000000-0000-0000-0000-000000000003');
 const calls=f.requests.filter(r=>r.method==='thread-follower-interrupt-turn');assert.equal(calls.length,1);assert.equal(calls[0].params.expectedTurnId,h.sourceTurnId);
}));
test('lost merged-queue receipt is found by batch ID, never added twice',()=>fixture(async f=>{
 const a=await f.feedback('Old input');await deliverFeedback(a.changeId);await f.stop(a);
 const b=await f.feedback('New input');process.env.CHILL_TEST_DROP_AFTER_ADD='1';
 await assert.rejects(deliverFeedback(b.changeId));delete process.env.CHILL_TEST_DROP_AFTER_ADD;
 assert.equal((await readFeedbackHold(a.goalId)).phase,'uncertain');
 await reconcileFeedbackHold(a.goalId);await deliverFeedback(b.changeId);
 assert.equal((await f.queue()).data.length,1);assert.equal((await readFeedbackHold(a.goalId)).phase,'sent');
}));
test('concurrent supplements are delivered once, with one of them joining the held batch',()=>fixture(async f=>{
 const a=await f.feedback('A');await deliverFeedback(a.changeId);await f.stop(a);
 const b=await f.feedback('B'),c=await f.feedback('C');await Promise.all([deliverFeedback(b.changeId),deliverFeedback(c.changeId)]);
 const entries=(await f.queue()).data;assert.equal(entries.length,2);
 for(const e of [a,b,c])assert.equal(entries.filter(q=>q.input[0].text.includes(`Feedback: #${e.changeId}\n`)).length,1);
}));
test('confirmed no-op removal failure releases the hold so the user can stop again',()=>fixture(async f=>{
 const a=await f.feedback('Retry stop');await deliverFeedback(a.changeId);
 process.env.CHILL_TEST_DELETE_FAIL='1';await assert.rejects(f.stop(a));delete process.env.CHILL_TEST_DELETE_FAIL;
 assert.equal((await readFeedbackHold(a.goalId)).phase,'uncertain');
 await reconcileFeedbackHold(a.goalId);assert.equal((await readDeliveryState(a.changeId)).heldBy,null);
 await f.stop(a);assert.equal((await readFeedbackHold(a.goalId)).phase,'paused');assert.equal((await f.queue()).data.length,0);
}));

test('Saved is stoppable before Desktop I/O, even after a completed earlier execution',()=>fixture(async f=>{
 const old=await f.feedback('Completed');await updateDelivery(old.changeId,{status:'completed',agentReported:true,turnId:turn,mayHaveSent:true});
 const a=await f.feedback('Saved');
 const previous=process.env.CHILL_AGENT_CODEX_PATH;process.env.CHILL_AGENT_CODEX_PATH='/missing-codex';
 const activity=await readAgentActivity(a.goalId,{fresh:true});assert.equal(activity.eventId,a.changeId);assert.equal(activity.status,'saved');assert.equal(activity.capabilities.stop,true);
 await f.stop(a);assert.equal((await readFeedbackHold(a.goalId)).phase,'paused');
 process.env.CHILL_AGENT_CODEX_PATH=previous;
 await deliverFeedback(a.changeId);assert.equal((await f.queue()).data.length,0);assert.equal(f.requests.length,0);
}));

test('pause wins while delivery is preparing; preparation cannot enqueue the held comment',()=>fixture(async f=>{
 const a=await f.feedback('Slow preparation');process.env.CHILL_TEST_READ_DELAY='1500';
 const sending=deliverFeedback(a.changeId);
 for(let i=0;i<100;i++){
  const log=await readFile(join(f.dir,'fake-requests.jsonl'),'utf8').catch(()=>'');
  if(log.includes('thread/read'))break;
  if(i===99)throw Error('Preparation did not start');
  await new Promise(r=>setTimeout(r,20));
 }
 const start=Date.now();await f.stop(a);assert.ok(Date.now()-start<1000,'Pause does not wait for connection preparation');
 await sending;assert.equal((await f.queue()).data.length,0);assert.equal((await readFeedbackHold(a.goalId)).phase,'paused');
}));


test('pausing deferred feedback preserves unrelated live work and cannot be undone by deferment',()=>fixture(async f=>{
 const a=await f.feedback('Later request');await deliverFeedback(a.changeId);
 await f.history({turns:[{id:turn,status:'inProgress',completedAt:null,items:[]}],items:{[turn]:[]}});
 const {recordActivity}=await import('../lib/delivery.mjs');
 await collectHookFeedback({threadId:thread,turnId:turn});
 await recordActivity(a.changeId,'deferred',thread);
 const activity=await readAgentActivity(a.goalId,{fresh:true});assert.equal(activity.status,'queued');assert.equal(activity.turnId,null);
 await f.stop(a);
 assert.equal((await readFeedbackHold(a.goalId)).sourceTurnId,null);
 assert.equal((await readFeedbackHold(a.goalId)).phase,'paused');
 assert.equal(f.requests.filter(r=>r.method==='thread-follower-interrupt-turn'&&r.params.expectedTurnId===turn).length,0);
 await assert.rejects(recordActivity(a.changeId,'deferred',thread),/unclaimed queued/);
 assert.deepEqual(await collectHookFeedback({threadId:thread,turnId:randomUUID()}),[]);
}));
