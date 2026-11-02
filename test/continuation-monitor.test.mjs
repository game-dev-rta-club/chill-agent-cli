import test from 'node:test';
import assert from 'node:assert/strict';
import {createMonitorRunner,continuationMessage,settle} from '../lib/continuation-monitor.mjs';
import {readTurnCheck,seedTurnCheck} from '../lib/turn-checks.mjs';
import {createContinuationExtension} from '../lib/continuation-extension.mjs';
import {codexTurnPlan} from '../lib/agents/codex-continuation.mjs';
import {continuationObservation} from '../lib/agents/codex-continuation-observation.mjs';
import {continuationEligibility} from '../lib/continuation-eligibility.mjs';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {appendAgentComment,createGoal,createOwnedRoot,updateGoal,updateBrief,appendFeedback,readFeedback} from '../lib/goal-store.mjs';
import {setRootAutonomy} from '../lib/root-autonomy.mjs';
import {goalRule} from '../lib/goal-rule.mjs';
import {mkdir} from 'node:fs/promises';
import {codexThread,contractStub} from './codex-contract.mjs';

import {expectHidden} from './hidden-failures.mjs';
// A project set up by an earlier version recorded the skill's guide beside its version file.
async function installedSkill(t){
 const dir=await mkdtemp(join(tmpdir(),'chill-guide-')),skill=join(dir,'skill'),old=process.env.CHILL_AGENT_DATA_DIR;
 await mkdir(join(skill,'references/auto-mode'),{recursive:true});await mkdir(join(dir,'data','runtime'),{recursive:true});
 await writeFile(join(skill,'SKILL.md'),'# Guide\n');await writeFile(join(skill,'references/auto-mode/continue.md'),'# Continue\n');
 await writeFile(join(skill,'chill-agent.json'),JSON.stringify({package:'example'}));
 process.env.CHILL_AGENT_DATA_DIR=join(dir,'data');
 await writeFile(join(dir,'data','runtime','version-source.json'),JSON.stringify({version:1,versionFile:join(skill,'chill-agent.json'),agentGuide:join(skill,'SKILL.md')}));
 t.after(async()=>{if(old===undefined)delete process.env.CHILL_AGENT_DATA_DIR;else process.env.CHILL_AGENT_DATA_DIR=old;await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
}
const idle=()=>({rootId:'1',threadId:'t',observedAt:'2026-01-01T00:00:00Z',rootState:'idle',revision:'r1',progress:'p1',candidates:[{id:'2',title:'Work'}],lastUserEvent:1,paused:false,pendingFeedback:[],queue:[],stable:true,harnessState:'notLoaded',heartbeatFresh:false,turn:{id:'turn',status:'completed',completedAt:1}});
// The chat's Autonomy plan: its Root at Auto Continue, its revision following the facts'.
const planFor=f=>({rootId:'1',threadId:'t',owner:{agent:'codex',id:'t'},level:2,goalId:'1',goalTitle:'Root',revision:f.revision,roots:[{id:'1',title:'Root',level:2}]});
function fixture(){
 // Each chat's check record, by its ID; `state` is the one written last.
 let saved=null,time=1000,f=idle(),sent=[],failure=false,observations=0,mutate=()=>{};const records=new Map();
 const deps={plan:async()=>deps.planned===undefined?planFor(f):deps.planned,read:async owner=>structuredClone(records.get(owner.id))??{owner,attempts:[],history:[]},write:async(owner,s)=>{saved=structuredClone(s);records.set(owner.id,saved);},observe:async()=>{mutate(++observations);return structuredClone(f);},lock:async(_id,fn)=>fn(),now:()=>time,send:async(_f,text,id)=>{sent.push({text,id});if(failure)throw Error('timeout');return {queuedSubmission:{id:'q'}};}};
 return {run:()=>createMonitorRunner(deps)(),get state(){return saved;},records,get sent(){return sent;},f,advance:(n=101)=>{time+=n;},fail:()=>{failure=true;},mutate:fn=>{mutate=fn;},complete:()=>{f.pendingWork={endedAt:new Date(time).toISOString()};f.turn={id:'next'+sent.length,status:'completed',completedAt:time/1000};},deps};
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
test('nothing is checked while no Root asks for it; the chat\'s check observes the Root its plan names',async()=>{
 const x=fixture();x.deps.planned=null;assert.equal((await x.run()).status,'off');assert.equal(x.sent.length,0);
 const observed=[],observe=x.deps.observe;x.deps.observe=async(id,pending)=>{observed.push(id);return observe(id,pending);};
 x.deps.planned=undefined;await x.run();assert.equal(x.sent.length,1);assert.deepEqual([...new Set(observed)],['1']);
 assert.match(x.sent[0].text,/- Root Goal #1 “Root”, Auto Continue: After each turn, keep carrying out what you and the user clearly see the same way, in any Goal under Root Goal #1/);
});
test('a level change is a new revision',async()=>{
 const x=fixture();await x.run();x.complete();assert.equal((await x.run()).status,'exhausted');
 x.deps.planned={...planFor(x.f),level:3,revision:'level-3',roots:[{id:'1',title:'Root',level:3,open:[{id:'2',title:'Work'}],taken:[]}]};
 await x.run();assert.equal(x.sent.length,2);assert.match(x.sent[1].text,/Root Goal #1 “Root”, Ultra Continue: Root Goal #1 is delegated to you/);
 assert.match(x.sent[1].text,/Unfinished in that tree: #2 “Work”\./);
});
test('a chat that takes over a Root gets its own check; the earlier chat\'s request stays in its record, never resent',async t=>{
 expectHidden(t,'continuation-monitor.send');
 const x=fixture();x.fail();await x.run();
 x.deps.planned={...planFor(x.f),threadId:'u',owner:{agent:'codex',id:'u'}};x.f.threadId='u';
 await x.run();assert.equal(x.sent.length,2,'one check for the new chat');assert.notEqual(x.sent[1].id,x.sent[0].id);
 assert.equal(x.records.get('t').attempts[0].phase,'uncertain','the earlier request is left as it was');
 assert.deepEqual(x.records.get('u').owner,{agent:'codex',id:'u'});assert.equal(x.records.get('u').attempts.length,1);
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
  const root=await createOwnedRoot({title:'root'},{agent:'codex',id:threadId});await setRootAutonomy(root.id,2);
  const observe=()=>continuationObservation(root.id,null,{connect});
  let facts=await observe();const original=facts.revision;
  await updateGoal(root.id,{started:true});assert.equal((await observe()).revision,original);
  await updateGoal(root.id,{scope:'Changed'});facts=await observe();
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
  await updateGoal(root.id,{state:'done'});
  assert.equal(await codexTurnPlan(threadId),null);await updateGoal(root.id,{state:'idle'});let sends=0;
  const run=createMonitorRunner({plan:()=>codexTurnPlan(threadId),observe:async()=>({...idle(),rootId:root.id,threadId,revision:(await observe()).revision}),
   send:async()=>{sends++;return {queuedSubmission:{id:'queue'}};}});
  await Promise.all([run(),run()]);assert.equal(sends,1);
  const events=await readFeedback();
  assert.deepEqual(await readFeedback(),events);
  assert.equal((await run()).status,'awaiting-run');assert.equal(sends,1);
  await setRootAutonomy(root.id,1);assert.equal((await run()).status,'off');
  assert.equal((await readTurnCheck({agent:'codex',id:threadId})).attempts.length,1);
 }finally{if(old===undefined)delete process.env.CHILL_AGENT_DATA_DIR;else process.env.CHILL_AGENT_DATA_DIR=old;await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});

test('the request names open Letters without counters, report dumps or commands',async t=>{
 await installedSkill(t);
 const f={...idle(),context:{goals:{total:3,unfinished:2,waiting:0},latestReport:'長い過去の報告',letters:[{goalId:'27',title:'対象を選んでください'}]}};
 const text=continuationMessage(f);
 assert.match(text,/Goal #27: “対象を選んでください”/);
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

test('the request ends with the Goal rule and names no guide, even one an earlier setup recorded',async t=>{
 await installedSkill(t);
 const text=continuationMessage(idle());
 assert.ok(text.endsWith(goalRule));
 assert.doesNotMatch(text,/SKILL\.md|continue\.md|guide/);
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

test('a chat\'s first check record carries on its latest Root check; the other Roots\' requests go to history, closed',()=>{
 const owner={agent:'codex',id:'t'},at='2026-01-01T00:00:00.000Z';
 assert.deepEqual(seedTurnCheck(owner,[],at),{owner,attempts:[],history:[]});
 const older={rootId:'1',owner,revision:'r1',checkedAt:'2025-12-01T00:00:00.000Z',history:[{id:'old'}],attempts:[{id:'open'}]};
 const newer={rootId:'2',owner,revision:'r2',status:'exhausted',checkedAt:'2025-12-02T00:00:00.000Z',attempts:[{id:'last',completedAt:at}]};
 const seeded=seedTurnCheck(owner,[older,newer],at);
 assert.deepEqual([seeded.revision,seeded.status,seeded.attempts.map(a=>a.id)],['r2','exhausted',['last']],'the latest check carries on, so the update asks no extra check');
 assert.deepEqual(seeded.history.map(a=>[a.id,a.phase??null]),[['old',null],['open','superseded']],'another Root\'s open request is closed, never resent');
});
test('the poller runs a chat\'s check once, however many of its Roots it lists',async()=>{
 let ticks=0;const chat={live:true,key:'codex:t',tick:async()=>{ticks++;},prepare:async()=>{}};
 const extension=createContinuationExtension({roots:async()=>[{id:'1'},{id:'2'}],continuation:()=>chat});
 await extension.tick();assert.equal(ticks,1);
});
test('a settled request records worked when the Web changed since it, otherwise no-work',()=>{
 const at='2026-01-01T00:00:00.000Z',worked={progress:'p1'},idle={progress:'p1'},old={};
 settle(worked,{progress:'p2',at});settle(idle,{progress:'p1',at});settle(old,{progress:'p2',at});
 assert.deepEqual([worked.result.outcome,worked.phase,idle.result.outcome,old.result,old.phase],['worked','completed','no-work',undefined,'ended']);
});
test('a chat\'s observation counts every Root its Autonomy continues, and work in any of them changes its progress',async()=>{
 const old=process.env.CHILL_AGENT_DATA_DIR,dir=await mkdtemp(join(tmpdir(),'chill-monitor-roots-'));process.env.CHILL_AGENT_DATA_DIR=dir;
 const threadId='00000000-0000-0000-0000-000000000004';
 const connect=fn=>fn(contractStub(async(method,p)=>{
  if(method==='thread/read')return {thread:codexThread({id:p.threadId})};
  if(method==='thread/turns/list')return {data:[{id:'ended',status:'completed',completedAt:1,items:[]}]};
  if(method==='thread/queue/list')return {data:[]};throw Error(method);
 }));
 try{
  const first=await createOwnedRoot({title:'First'},{agent:'codex',id:threadId}),second=await createOwnedRoot({title:'Second'},{agent:'codex',id:threadId});
  await createGoal({title:'Open step',parentId:second.id});
  const normal=await createOwnedRoot({title:'Normal'},{agent:'codex',id:threadId});await createGoal({title:'Not continued',parentId:normal.id});
  await setRootAutonomy(first.id,2);await setRootAutonomy(second.id,3);
  const before=await continuationObservation(first.id,null,{connect});
  assert.equal(before.context.goals.unfinished,3,'both continued Roots and the second Root\'s open step, not the Normal Root\'s');
  await appendFeedback({goalId:normal.id,text:'Only for the Normal Root'});
  assert.equal((await continuationObservation(first.id,null,{connect})).revision,before.revision,'a Normal Root starts no check');
  await appendAgentComment({goalId:second.id,type:'comment',text:'Moved the second Root forward.'});
  assert.notEqual((await continuationObservation(first.id,null,{connect})).progress,before.progress);
 }finally{if(old===undefined)delete process.env.CHILL_AGENT_DATA_DIR;else process.env.CHILL_AGENT_DATA_DIR=old;await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
});
