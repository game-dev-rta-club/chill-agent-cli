import test from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import assert from 'node:assert/strict';
import {createMonitorRunner,continuationMessage,configureMonitor,readMonitor,reportMonitorResult} from '../lib/continuation-monitor.mjs';
import {continuationEligibility,continuationObservation} from '../lib/continuation-observation.mjs';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGoal,updateGoal,updateBrief,appendFeedback,readFeedback} from '../lib/goal-store.mjs';
const idle=()=>({rootId:'1',threadId:'t',observedAt:'2026-01-01T00:00:00Z',rootState:'idle',revision:'r1',candidates:[{id:'2',title:'Work'}],lastUserEvent:1,paused:false,pendingFeedback:[],queue:[],stable:true,harnessState:'notLoaded',heartbeatFresh:false,turn:{id:'turn',status:'completed',completedAt:1}});
function fixture(){
 let saved={enabled:true,threadId:'t',attempts:[]},time=1000,f=idle(),sent=[],failure=false,observations=0,mutate=()=>{};
 const deps={read:async()=>structuredClone(saved),write:async(_id,s)=>{saved=structuredClone(s);},observe:async()=>{mutate(++observations);return structuredClone(f);},lock:async(_id,fn)=>fn(),now:()=>time,send:async(_f,text,id)=>{sent.push({text,id});if(failure)throw Error('timeout');return {queuedSubmission:{id:'q'}};}};
 return {run:()=>createMonitorRunner(deps)('1'),get state(){return saved;},get sent(){return sent;},f,advance:(n=101)=>{time+=n;},fail:()=>{failure=true;},mutate:fn=>{mutate=fn;},complete:()=>{f.pendingWork={endedAt:new Date(time).toISOString()};f.turn={id:'next'+sent.length,status:'completed',completedAt:time/1000};},deps};
}
for(const [name,patch] of Object.entries({queued:{queue:[{id:'other-goal'}]},sending:{pendingFeedback:[{eventId:2,status:'sending'}]},saved:{pendingFeedback:[{eventId:2,status:'saved'}]},paused:{paused:true},unfinished:{turn:{id:'x',completedAt:null,status:'interrupted'}},heartbeat:{heartbeatFresh:true},unknown:{harnessState:'unknown'},changing:{stable:false},interrupted:{turn:{id:'t',completedAt:1,status:'interrupted'}}})){
 test(`never sends for ${name}`,async()=>{const x=fixture();Object.assign(x.f,patch);await x.run();x.advance(10000);await x.run();assert.equal(x.sent.length,0);});
}

test('idle gets one readable nudge immediately; queue blocks followups',async()=>{
 const x=fixture();await x.run();assert.equal(x.sent.length,1);
 assert.match(x.sent[0].text,/carry on with anything/);assert.match(x.sent[0].text,/monitor result/);
 assert.doesNotMatch(x.sent[0].text,/queueCount|latestTurn/);
 assert.equal(x.state.attempts[0].message,x.sent[0].text,'saved text is exactly what is sent');
 assert.ok(x.state.attempts[0].summary);
 x.f.queue=[{messageId:x.sent[0].id}];await x.run();assert.equal(x.sent.length,1);
});
test('one nudge per revision across restarts; completed result alone does not prove turn ended',async()=>{
 const x=fixture();await x.run();
 x.state.attempts[0].result={outcome:'no-work'};await x.run();assert.equal(x.sent.length,1);
 x.complete();assert.equal((await x.run()).status,'exhausted');assert.equal(x.sent.length,1);
 x.advance(10000);assert.equal((await x.run()).status,'exhausted');assert.equal(x.sent.length,1);
 x.f.revision='r2';await x.run();assert.equal(x.sent.length,2);assert.equal(x.state.history.length,1);
});
test('Done and no candidates do not suppress monitoring',async()=>{
 const x=fixture();x.f.rootState='done';x.f.candidates=[];await x.run();assert.equal(x.sent.length,1);
});
test('lost receipt is not blindly retried even when content changes',async()=>{
 const x=fixture();x.fail();assert.equal((await x.run()).status,'uncertain');
 x.f.revision='new';assert.equal((await x.run()).status,'awaiting-receipt');assert.equal(x.sent.length,1);
});
test('send-time recheck blocks newly queued input and changed revision',async()=>{
 for(const kind of ['queue','revision']){
  const x=fixture();x.mutate(n=>{if(n===2){if(kind==='queue')x.f.queue=[{id:'new'}];else x.f.revision='r2';}});
  assert.equal((await x.run()).status,'changed');assert.equal(x.sent.length,0);
 }
});
test('observation failure sends nothing',async()=>{
 const x=fixture();x.deps.observe=async()=>{throw Error('offline');};
 assert.equal((await x.run()).status,'unknown');assert.equal(x.sent.length,0);
});
test('no turn does not establish idle; active thread blocks even with old completion',()=>{
 assert.equal(continuationEligibility({...idle(),turn:null}),'unknown');assert.equal(continuationEligibility({...idle(),harnessState:'active'}),'running');
});
test('adapter paginates native queue and detects turns changing during observation',async()=>{
 const old=process.env.CHILL_AGENT_DATA_DIR,dir=await mkdtemp(join(tmpdir(),'chill-monitor-'));process.env.CHILL_AGENT_DATA_DIR=dir;
 try{
  const root=await createGoal({title:'root',threadId:'00000000-0000-0000-0000-000000000001'});let turns=0;
  const facts=await continuationObservation(root.id,null,{connect:fn=>fn({request:async(method,p)=>{
   if(method==='thread/read')return {thread:{status:{type:'notLoaded'}}};
   if(method==='thread/turns/list')return {data:[{id:++turns===1?'a':'b',completedAt:1,status:'completed'}]};
   if(method==='thread/queue/list')return p.cursor?{data:[{id:'other-goal'}]}:{data:[],nextCursor:'next'};
   throw Error(method);
  }})});
  assert.equal(facts.queue.length,1);assert.equal(facts.stable,false);assert.equal(continuationEligibility(facts),'queued');
 }finally{if(old===undefined)delete process.env.CHILL_AGENT_DATA_DIR;else process.env.CHILL_AGENT_DATA_DIR=old;await rm(dir,{recursive:true,force:true});}
});

test('adapter treats interrupted without an end timestamp as running',async()=>{
 const old=process.env.CHILL_AGENT_DATA_DIR,dir=await mkdtemp(join(tmpdir(),'chill-live-monitor-'));process.env.CHILL_AGENT_DATA_DIR=dir;
 try{
  const root=await createGoal({title:'root',threadId:'00000000-0000-0000-0000-000000000002'});
  const facts=await continuationObservation(root.id,null,{connect:fn=>fn({request:async(method)=>{
   if(method==='thread/read')return {thread:{status:{type:'notLoaded'}}};
   if(method==='thread/turns/list')return {data:[{id:'live',completedAt:null,status:'interrupted'}]};
   if(method==='thread/queue/list')return {data:[]};
   throw Error(method);
  }})});
  assert.equal(facts.paused,false);assert.equal(continuationEligibility(facts),'running');
 }finally{if(old===undefined)delete process.env.CHILL_AGENT_DATA_DIR;else process.env.CHILL_AGENT_DATA_DIR=old;await rm(dir,{recursive:true,force:true});}
});

test('real store: content revisions and internal results stay separate from Web events',async()=>{
 const old=process.env.CHILL_AGENT_DATA_DIR,dir=await mkdtemp(join(tmpdir(),'chill-monitor-result-'));process.env.CHILL_AGENT_DATA_DIR=dir;
 const threadId='00000000-0000-0000-0000-000000000003';
 const connect=fn=>fn({request:async(method)=>{
  if(method==='thread/read')return {thread:{status:{type:'notLoaded'}}};
  if(method==='thread/turns/list')return {data:[{id:'ended',status:'completed',completedAt:1}]};
  if(method==='thread/queue/list')return {data:[]};throw Error(method);
 }});
 try{
  const root=await createGoal({title:'root',threadId});
  const observe=()=>continuationObservation(root.id,null,{connect});
  let facts=await observe();const original=facts.revision;
  await updateGoal(root.id,{started:true});assert.equal((await observe()).revision,original);
  await updateGoal(root.id,{state:'done'});facts=await observe();
  assert.notEqual(facts.revision,original);assert.equal(continuationEligibility(facts),'idle');
  await writeFile(join(dir,'workspace/goals',root.id,'brief.md'),'New brief');
  await updateBrief(root.id);const briefRevision=(await observe()).revision;
  assert.notEqual(briefRevision,facts.revision);await updateBrief(root.id);assert.equal((await observe()).revision,briefRevision);
  const {appendAgentComment}=await import('../lib/goal-store.mjs');
  await appendAgentComment({goalId:root.id,type:'comment',text:'Done'});
  await appendAgentComment({goalId:root.id,type:'letter',title:'Question',text:'Which?'});
  assert.equal((await observe()).revision,briefRevision);
  assert.equal(continuationEligibility(await observe()),'idle');
  await appendFeedback({goalId:root.id,text:'New user input'});
  const revision=(await observe()).revision;assert.notEqual(revision,briefRevision);
  // Actual state persistence and shared thread lock; two monitors race.
  await configureMonitor(root.id,true);let sends=0;
  const run=createMonitorRunner({observe:async()=>({...idle(),rootId:root.id,threadId,revision}),
   send:async()=>{sends++;return {queuedSubmission:{id:'queue'}};}});
  await Promise.all([run(root.id),run(root.id)]);assert.equal(sends,1);
  const attempt=(await readMonitor(root.id)).attempts[0],events=await readFeedback();
  await assert.rejects(reportMonitorResult(root.id,attempt.id,'no-work','other'),/assigned/);
  const response=await promisify(execFile)(process.execPath,[new URL('../bin/chill-monitor.mjs',import.meta.url).pathname,'result','--id',root.id,'--attempt',attempt.id,'--outcome','no-work'],{env:{...process.env,CODEX_THREAD_ID:threadId}});
  assert.equal(JSON.parse(response.stdout).outcome,'no-work');
  await reportMonitorResult(root.id,attempt.id,'no-work',threadId);
  await assert.rejects(reportMonitorResult(root.id,attempt.id,'worked',threadId),/different result/);
  assert.deepEqual(await readFeedback(),events);assert.equal((await observe()).revision,revision);
  assert.equal((await run(root.id)).status,'awaiting-receipt');assert.equal(sends,1);
  await configureMonitor(root.id,false);await configureMonitor(root.id,true);
  assert.equal((await readMonitor(root.id)).attempts.length,1);
 }finally{if(old===undefined)delete process.env.CHILL_AGENT_DATA_DIR;else process.env.CHILL_AGENT_DATA_DIR=old;await rm(dir,{recursive:true,force:true});}
});

test('continuation gives a filtered index command and names open Letters without counters or report dumps',()=>{
 const id='00000000-0000-0000-0000-000000000123';
 const f={...idle(),context:{goals:{total:3,unfinished:2,waiting:0},latestReport:'長い過去の報告',letters:[{goalId:'27',title:'対象を選んでください'}]}};
 const text=continuationMessage(f,1,id);
 assert.match(text,/Goal #27: “対象を選んでください”/);
 assert.match(text,/chill goal review --id 1/);
 assert.match(text,/Workflow:/);assert.match(text,/--section context/);
 assert.match(text,/Before stopping, review the next action; use a Letter only when a user reply, choice or permission is needed/);
 assert.match(text,/Open Letters for the user’s attention/);
 assert.doesNotMatch(text,/Waiting for your user’s answer/);
 assert.doesNotMatch(text,/1\/2|2\/2|配送照合|<!--|長い過去の報告|回答待ち：1件/);
 assert.equal(text.split(id).length-1,1,'identifier only appears in the result command');
});

test('combined continuation template is English while saved Letter titles retain their wording',()=>{
 assert.doesNotMatch(continuationMessage(idle(),1,'id'),/[\u3040-\u30ff\u3400-\u9fff]/);
});

test('the combined handoff points to a readable guide shipped in the active runtime',async()=>{
 const text=continuationMessage(idle(),1,'id');
 const path=JSON.parse(text.match(/^Workflow: (".*?")\./m)[1]);
 assert.ok(path.endsWith('/references/auto-mode/continue.md'));
 const guide=await readFile(path,'utf8');
 assert.ok(guide.length>0);
 assert.match(text,/Auto mode is On/);
 assert.match(text,/In this same pass, check any reason to stop/);
});

test('nudge describes unfinished Goals, pending Letters, and a settled tree without confusing them',()=>{
 const message=(goals,letters=[])=>continuationMessage({...idle(),context:{goals,letters}},1,'id');
 const unfinished=message({total:5,unfinished:2,waiting:1});
 assert.match(unfinished,/2 unfinished Goals, including 1 Waiting/);
 assert.match(unfinished,/review --id 1 --state unfinished/);
 assert.doesNotMatch(unfinished,/Every Goal is marked Done/);
 const pending=message({total:5,unfinished:0,waiting:0},[{goalId:'4',title:'Approve the result?'}]);
 assert.match(pending,/Every Goal is marked Done, with Letters still open/);assert.match(pending,/review --id 1 --letters/);assert.match(pending,/Approve the result/);
 const done=message({total:5,unfinished:0,waiting:0});
 assert.match(done,/Every Goal is marked Done, and no Letters/);assert.match(done,/review --id 1\n/);assert.match(done,/leave the project at rest/);
 for(const text of [unfinished,pending,done])assert.doesNotMatch(text,/read every Goal|whole tree|1\/2|2\/2|latestReport/);
 assert.match(continuationMessage(idle(),1,'id'),/goal tree --id 1/,'older CLI releases get the supported compact tree command');
});


test('continuation anchors to the last work Goal and preserves the observed run when archived',async()=>{
 const x=fixture();x.f.context={focus:{id:'7',title:'Current outcome'}};
 await x.run();assert.equal(x.state.attempts[0].goalId,'7');
 assert.equal(x.state.attempts[0].goalTitle,'Current outcome');
 x.f.context.focus={id:'8',title:'Next outcome'};x.complete();
 x.f.pendingWork.turnId='auto-run';x.f.pendingWork.messages=[{text:'Public update'}];
 x.f.revision='r2';await x.run();
 assert.equal(x.state.history[0].goalId,'7');assert.equal(x.state.history[0].turnId,'auto-run');
 assert.deepEqual(x.state.history[0].work.messages,[{text:'Public update'}]);
 assert.equal(x.state.attempts[0].goalId,'8');
});
