import test from 'node:test';
import assert from 'node:assert/strict';
import {createMonitorRunner,continuationMessage,readMonitor} from '../lib/continuation-monitor.mjs';
import {codexTurnPlan} from '../lib/agents/codex-continuation.mjs';
import {continuationObservation} from '../lib/agents/codex-continuation-observation.mjs';
import {continuationEligibility} from '../lib/continuation-eligibility.mjs';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGoal,createOwnedRoot,updateGoal,updateBrief,appendFeedback,readFeedback} from '../lib/goal-store.mjs';
import {setRootAutonomy} from '../lib/root-autonomy.mjs';
import {mkdir} from 'node:fs/promises';
import {recordVersionSource} from '../lib/version-source.mjs';
import {codexThread,contractStub} from './codex-contract.mjs';

import {expectHidden} from './hidden-failures.mjs';
// The skill lives outside the runtime; setup records its guide in the data directory.
async function installedSkill(t){
 const dir=await mkdtemp(join(tmpdir(),'chill-guide-')),skill=join(dir,'skill'),old=process.env.CHILL_AGENT_DATA_DIR;
 await mkdir(join(skill,'references/auto-mode'),{recursive:true});
 await writeFile(join(skill,'SKILL.md'),'# Guide\n');await writeFile(join(skill,'references/auto-mode/continue.md'),'# Continue\n');
 await writeFile(join(skill,'chill-agent.json'),JSON.stringify({package:'example'}));
 process.env.CHILL_AGENT_DATA_DIR=join(dir,'data');
 await recordVersionSource(process.env.CHILL_AGENT_DATA_DIR,{versionFile:join(skill,'chill-agent.json'),agentGuide:join(skill,'SKILL.md')});
 t.after(async()=>{if(old===undefined)delete process.env.CHILL_AGENT_DATA_DIR;else process.env.CHILL_AGENT_DATA_DIR=old;await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
}
const idle=()=>({rootId:'1',threadId:'t',observedAt:'2026-01-01T00:00:00Z',rootState:'idle',revision:'r1',progress:'p1',candidates:[{id:'2',title:'Work'}],lastUserEvent:1,paused:false,pendingFeedback:[],queue:[],stable:true,harnessState:'notLoaded',heartbeatFresh:false,turn:{id:'turn',status:'completed',completedAt:1}});
// The chat's Autonomy plan: its Root at Auto Continue, its revision following the facts'.
const planFor=f=>({rootId:'1',threadId:'t',owner:{agent:'codex',id:'t'},level:2,goalId:'1',goalTitle:'Root',revision:f.revision,roots:[{id:'1',title:'Root',level:2}]});
function fixture(){
 let saved=null,time=1000,f=idle(),sent=[],failure=false,observations=0,mutate=()=>{};
 const deps={plan:async()=>deps.planned===undefined?planFor(f):deps.planned,read:async()=>structuredClone(saved),write:async(_id,s)=>{saved=structuredClone(s);},observe:async()=>{mutate(++observations);return structuredClone(f);},lock:async(_id,fn)=>fn(),now:()=>time,send:async(_f,text,id)=>{sent.push({text,id});if(failure)throw Error('timeout');return {queuedSubmission:{id:'q'}};}};
 return {run:()=>createMonitorRunner(deps)('1'),get state(){return saved;},get sent(){return sent;},f,advance:(n=101)=>{time+=n;},fail:()=>{failure=true;},mutate:fn=>{mutate=fn;},complete:()=>{f.pendingWork={endedAt:new Date(time).toISOString()};f.turn={id:'next'+sent.length,status:'completed',completedAt:time/1000};},deps};
}
for(const [name,patch] of Object.entries({queued:{queue:[{id:'other-goal'}]},sending:{pendingFeedback:[{eventId:2,status:'sending'}]},saved:{pendingFeedback:[{eventId:2,status:'saved'}]},paused:{paused:true},unfinished:{turn:{id:'x',completedAt:null,status:'interrupted'}},heartbeat:{heartbeatFresh:true},unknown:{harnessState:'unknown'},changing:{stable:false},interrupted:{turn:{id:'t',completedAt:1,status:'interrupted'}}})){
 test(`never sends for ${name}`,async()=>{const x=fixture();Object.assign(x.f,patch);await x.run();x.advance(10000);await x.run();assert.equal(x.sent.length,0);});
}

test('idle gets one readable nudge immediately; queue blocks followups',async()=>{
 const x=fixture();await x.run();assert.equal(x.sent.length,1);
 assert.match(x.sent[0].text,/carry on with anything/);assert.doesNotMatch(x.sent[0].text,/```|monitor result|chill goal|agent wake/);
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
test('nothing is checked while no Root asks for it, or for a Root the plan does not name',async()=>{
 const x=fixture();x.deps.planned=null;assert.equal((await x.run()).status,'off');assert.equal(x.sent.length,0);
 x.deps.planned={...planFor(x.f),rootId:'9'};assert.equal((await x.run()).status,'off','the chat gets one message, from the Root of its highest level');
 x.deps.planned=undefined;await x.run();assert.equal(x.sent.length,1);
 assert.match(x.sent[0].text,/- Root Goal #1 “Root”, Auto Continue: After each turn, keep carrying out what you and the user clearly see the same way, in any Goal under Root Goal #1/);
});
test('a level change is a new revision',async()=>{
 const x=fixture();await x.run();x.complete();assert.equal((await x.run()).status,'exhausted');
 x.deps.planned={...planFor(x.f),level:3,revision:'level-3',roots:[{id:'1',title:'Root',level:3,open:[{id:'2',title:'Work'}],taken:[]}]};
 await x.run();assert.equal(x.sent.length,2);assert.match(x.sent[1].text,/Root Goal #1 “Root”, Ultra Continue: Root Goal #1 is delegated to you/);
 assert.match(x.sent[1].text,/Unfinished in that tree: #2 “Work”\./);
});
test('an adopted Root keeps its level for its new chat; the earlier request is closed, never resent',async t=>{
 expectHidden(t,'continuation-monitor.send');
 const x=fixture();x.fail();await x.run();await x.deps.write('1',{...x.state,autonomy:3});
 x.deps.planned={...planFor(x.f),threadId:'u',owner:{agent:'codex',id:'u'}};x.f.threadId='u';
 await x.run();assert.equal(x.state.history[0].phase,'assignment-changed');assert.deepEqual(x.state.owner,{agent:'codex',id:'u'});assert.equal(x.state.autonomy,3);
});
test('a record written before any chat worked on the Root is taken over with its level',async()=>{
 const x=fixture();await x.deps.write('1',{rootId:'1',attempts:[],autonomy:2});
 await x.run();assert.equal(x.sent.length,1);assert.deepEqual(x.state.owner,{agent:'codex',id:'t'});assert.equal(x.state.autonomy,2);assert.equal(x.state.status,'queued');
});
test('Done and no candidates do not suppress monitoring',async()=>{
 const x=fixture();x.f.rootState='done';x.f.candidates=[];await x.run();assert.equal(x.sent.length,1);
});
test('lost receipt is not blindly retried even when content changes',async t=>{
 expectHidden(t,'continuation-monitor.send');
 const x=fixture();x.fail();assert.equal((await x.run()).status,'uncertain');
 x.f.revision='new';assert.equal((await x.run()).status,'awaiting-run');assert.equal(x.sent.length,1);
});
test('send-time recheck blocks newly queued input and changed revision',async()=>{
 for(const kind of ['queue','revision']){
  const x=fixture();x.mutate(n=>{if(n===2){if(kind==='queue')x.f.queue=[{id:'new'}];else x.f.revision='r2';}});
  assert.equal((await x.run()).status,'changed');assert.equal(x.sent.length,0);
 }
});
test('observation failure sends nothing',async t=>{
 expectHidden(t,'continuation-monitor.observe');
 const x=fixture();x.deps.observe=async()=>{throw Error('offline');};
 assert.equal((await x.run()).status,'unknown');assert.equal(x.sent.length,0);
});
test('no turn does not establish idle; active thread blocks even with old completion',()=>{
 assert.equal(continuationEligibility({...idle(),turn:null}),'unknown');assert.equal(continuationEligibility({...idle(),harnessState:'active'}),'running');
});
test('adapter paginates native queue and detects turns changing during observation',async()=>{
 const old=process.env.CHILL_AGENT_DATA_DIR,dir=await mkdtemp(join(tmpdir(),'chill-monitor-'));process.env.CHILL_AGENT_DATA_DIR=dir;
 try{
  const root=await createOwnedRoot({title:'root'},{agent:'codex',id:'00000000-0000-0000-0000-000000000001'});let turns=0;
  const facts=await continuationObservation(root.id,null,{connect:fn=>fn(contractStub(async(method,p)=>{
   if(method==='thread/read')return {thread:codexThread({id:p.threadId})};
   if(method==='thread/turns/list')return {data:[{id:++turns===1?'a':'b',completedAt:1,status:'completed',items:[]}]};
   if(method==='thread/queue/list')return p.cursor?{data:[{id:'other-goal',clientUserMessageId:'other-message',input:[]}]}:{data:[],nextCursor:'next'};
   throw Error(method);
  }))});
  assert.equal(facts.queue.length,1);assert.equal(facts.stable,false);assert.equal(continuationEligibility(facts),'queued');
 }finally{if(old===undefined)delete process.env.CHILL_AGENT_DATA_DIR;else process.env.CHILL_AGENT_DATA_DIR=old;await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});

test('adapter treats interrupted without an end timestamp as running',async()=>{
 const old=process.env.CHILL_AGENT_DATA_DIR,dir=await mkdtemp(join(tmpdir(),'chill-live-monitor-'));process.env.CHILL_AGENT_DATA_DIR=dir;
 try{
  const root=await createOwnedRoot({title:'root'},{agent:'codex',id:'00000000-0000-0000-0000-000000000002'});
  const facts=await continuationObservation(root.id,null,{connect:fn=>fn(contractStub(async(method,p)=>{
   if(method==='thread/read')return {thread:codexThread({id:p.threadId})};
   if(method==='thread/turns/list')return {data:[{id:'live',completedAt:null,status:'interrupted',items:[]}]};
   if(method==='thread/queue/list')return {data:[]};
   throw Error(method);
  }))});
  assert.equal(facts.paused,false);assert.equal(continuationEligibility(facts),'running');
 }finally{if(old===undefined)delete process.env.CHILL_AGENT_DATA_DIR;else process.env.CHILL_AGENT_DATA_DIR=old;await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});

test('real store: content revisions stay separate from agent Web events',async()=>{
 const old=process.env.CHILL_AGENT_DATA_DIR,dir=await mkdtemp(join(tmpdir(),'chill-monitor-result-'));process.env.CHILL_AGENT_DATA_DIR=dir;
 const threadId='00000000-0000-0000-0000-000000000003';
 const connect=fn=>fn(contractStub(async(method,p)=>{
  if(method==='thread/read')return {thread:codexThread({id:p.threadId})};
  if(method==='thread/turns/list')return {data:[{id:'ended',status:'completed',completedAt:1,items:[]}]};
  if(method==='thread/queue/list')return {data:[]};throw Error(method);
 }));
 try{
  const root=await createOwnedRoot({title:'root'},{agent:'codex',id:threadId});
  const observe=()=>continuationObservation(root.id,null,{connect});
  let facts=await observe();const original=facts.revision;
  await updateGoal(root.id,{started:true});assert.equal((await observe()).revision,original);
  await updateGoal(root.id,{state:'done'});facts=await observe();
  assert.notEqual(facts.revision,original);assert.equal(continuationEligibility(facts),'idle');
  await writeFile(join(dir,'workspace/goals',root.id,'deliverable.md'),'New brief');
  await updateBrief(root.id);const briefRevision=(await observe()).revision;
  assert.notEqual(briefRevision,facts.revision);await updateBrief(root.id);assert.equal((await observe()).revision,briefRevision);
  const {appendAgentComment}=await import('../lib/goal-store.mjs');
  await appendAgentComment({goalId:root.id,type:'comment',text:'Done'});
  const before=(await observe()).progress;
  await appendAgentComment({goalId:root.id,type:'letter',title:'Question',text:'Which?'});
  assert.equal((await observe()).revision,briefRevision);assert.notEqual((await observe()).progress,before,'agent Web events are progress, not a revision');
  assert.equal(continuationEligibility(await observe()),'idle');
  await appendFeedback({goalId:root.id,text:'New user input'});
  const revision=(await observe()).revision;assert.notEqual(revision,briefRevision);
  // Actual state persistence and shared thread lock; two monitors race.
  // A Done Root asks for nothing; reopened at Auto Continue, it does.
  await setRootAutonomy(root.id,2);
  assert.equal(await codexTurnPlan(threadId),null);await updateGoal(root.id,{state:'idle'});let sends=0;
  const run=createMonitorRunner({plan:()=>codexTurnPlan(threadId),observe:async()=>({...idle(),rootId:root.id,threadId,revision:(await observe()).revision}),
   send:async()=>{sends++;return {queuedSubmission:{id:'queue'}};}});
  await Promise.all([run(root.id),run(root.id)]);assert.equal(sends,1);
  const events=await readFeedback();
  assert.deepEqual(await readFeedback(),events);assert.notEqual((await observe()).revision,revision,'the Autonomy change is a revision');
  assert.equal((await run(root.id)).status,'awaiting-run');assert.equal(sends,1);
  await setRootAutonomy(root.id,1);assert.equal((await run(root.id)).status,'off');
  assert.equal((await readMonitor(root.id)).attempts.length,1);
 }finally{if(old===undefined)delete process.env.CHILL_AGENT_DATA_DIR;else process.env.CHILL_AGENT_DATA_DIR=old;await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});

test('the request names open Letters without counters, report dumps or commands',async t=>{
 await installedSkill(t);
 const f={...idle(),context:{goals:{total:3,unfinished:2,waiting:0},latestReport:'長い過去の報告',letters:[{goalId:'27',title:'対象を選んでください'}]}};
 const text=continuationMessage(f);
 assert.match(text,/Goal #27: “対象を選んでください”/);
 assert.match(text,/write a Letter/);
 assert.match(text,/Letters awaiting the user/);
 assert.doesNotMatch(text,/Waiting for your user’s answer/);
 assert.doesNotMatch(text,/1\/2|2\/2|配送照合|<!--|長い過去の報告|回答待ち：1件|```|chill goal|monitor result/);
});

test('combined continuation template is English while saved Letter titles retain their wording',()=>{
 assert.doesNotMatch(continuationMessage(idle()),/[\u3040-\u30ff\u3400-\u9fff]/);
});

test('both harnesses get one light request; only a conversation that can wake itself hears about wake',()=>{
 const codex=continuationMessage(idle()),claude=continuationMessage({...idle(),wake:true});
 for(const text of [codex,claude]){
  assert.match(text,/ask yourself once/);assert.match(text,/Run no commands and write no turn summary; chill records this check by itself/);
  assert.doesNotMatch(text,/```|monitor result|--attempt|goal review|goal tree|goal show/);
 }
 assert.doesNotMatch(codex,/agent wake/);assert.match(claude,/agent wake --in <minutes>/);
 assert.equal(claude.replace(/^Waiting on CI.*\n/m,''),codex,'the wake line is the only difference');
});

test('the request points to the guide recorded by setup',async t=>{
 await installedSkill(t);
 const text=continuationMessage(idle());
 const path=JSON.parse(text.match(/^When you carry work on, (".*?") says/m)[1]);
 assert.ok(path.endsWith(join('references','auto-mode','continue.md')));
 const guide=await readFile(path,'utf8');
 assert.ok(guide.length>0);
 assert.match(text,/ask yourself once/);
});

test('nudge describes unfinished Goals, pending Letters, and a settled tree without confusing them',()=>{
 const message=(goals,letters=[])=>continuationMessage({...idle(),context:{goals,letters}});
 const unfinished=message({total:5,unfinished:2,waiting:1});
 assert.match(unfinished,/2 unfinished Goals, including 1 Waiting/);
 assert.doesNotMatch(unfinished,/Every Goal is marked Done/);
 const pending=message({total:5,unfinished:0,waiting:0},[{goalId:'4',title:'Approve the result?'}]);
 assert.match(pending,/Every Goal is marked Done, with Letters still open/);assert.match(pending,/Approve the result/);
 const done=message({total:5,unfinished:0,waiting:0});
 assert.match(done,/Every Goal is marked Done, and no Letters/);assert.match(done,/leave the project at rest/);
 for(const text of [unfinished,pending,done])assert.doesNotMatch(text,/read every Goal|whole tree|1\/2|2\/2|latestReport/);
});

test('chill records the result when the run ends: worked when the agent left something on the Web, otherwise no-work',async()=>{
 for(const [progress,outcome] of [['p1','no-work'],['p2','worked']]){
  const x=fixture();await x.run();assert.equal(x.state.attempts[0].progress,'p1','the mark is saved with the request');
  x.f.progress=progress;x.advance();assert.equal((await x.run()).status,'awaiting-run');
  assert.equal(x.state.attempts[0].result,undefined,'a run not seen to end has no result');
  x.complete();x.advance();assert.equal((await x.run()).status,'exhausted');
  const {result,phase}=x.state.attempts[0];assert.equal(result.outcome,outcome);assert.equal(result.observed,true);assert.equal(phase,'completed');
  x.f.progress='later';x.advance();await x.run();assert.equal(x.state.attempts[0].result.outcome,outcome,'a recorded result is kept');
 }
});

test('continuation anchors to the highest-level Goal and preserves the observed run when archived',async()=>{
 const x=fixture(),at=(id,title)=>{x.deps.planned={...planFor(x.f),goalId:id,goalTitle:title,goals:[{id,title,level:2,rootId:'1'}]};};
 at('7','Current outcome');
 await x.run();assert.equal(x.state.attempts[0].goalId,'7');
 assert.equal(x.state.attempts[0].goalTitle,'Current outcome');
 x.complete();x.f.revision='r2';at('8','Next outcome');
 x.f.pendingWork.turnId='auto-run';x.f.pendingWork.messages=[{text:'Public update'}];
 await x.run();
 assert.equal(x.state.history[0].goalId,'7');assert.equal(x.state.history[0].turnId,'auto-run');
 assert.deepEqual(x.state.history[0].work.messages,[{text:'Public update'}]);
 assert.equal(x.state.attempts[0].goalId,'8');
});
