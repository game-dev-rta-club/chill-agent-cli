import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {captureClaudeEntry} from '../lib/claude-entry.mjs';
import {requestClaudeAction,confirmClaudeAction,inspectClaudeRequest,handleClaudeToolHook} from '../lib/claude-actions.mjs';
import {initializeStore,createGoal,listGoals,appendFeedback,readGoal,updateGoal} from '../lib/goal-store.mjs';
import {createClaudeRoot} from '../lib/claude-roots.mjs';
import {assignGoal} from '../lib/goal-execution.mjs';
import {deliverFeedback,readDeliveryState,updateDelivery} from '../lib/delivery.mjs';
import {readAgentStatus} from '../lib/agent-status.mjs';
import {needsWorkRefresh} from '../lib/work-output.mjs';
import {agentMarkup} from '../public/agent-menu.js';
import {fileURLToPath} from 'node:url';

async function fixture(t) {
  const dir=await mkdtemp(join(tmpdir(),'chill-claude-actions-'));
  const previous={data:process.env.CHILL_AGENT_DATA_DIR,codex:process.env.CHILL_AGENT_CODEX_PATH};
  process.env.CHILL_AGENT_DATA_DIR=join(dir,'data');process.env.CHILL_AGENT_CODEX_PATH='/never/call/codex';
  t.after(async()=>{for(const [key,value] of [['CHILL_AGENT_DATA_DIR',previous.data],['CHILL_AGENT_CODEX_PATH',previous.codex]]){if(value===undefined)delete process.env[key];else process.env[key]=value;}await rm(dir,{recursive:true,force:true});});
  const cwd=join(dir,'project');await mkdir(cwd);
  async function start(sessionId='native/session',source='startup') {
    const envFile=join(dir,randomUUID());await writeFile(envFile,'');
    const record=await captureClaudeEntry({hook_event_name:'SessionStart',session_id:sessionId,source,cwd}, {cwd,env:{CLAUDE_ENV_FILE:envFile}});
    const env={CHILL_AGENT_HARNESS:record.harnessId,CHILL_AGENT_SESSION_ID:sessionId,CHILL_AGENT_CONNECTION_GENERATION:record.generation};
    const request=(action,payload)=>requestClaudeAction(action,payload,{env});
    const hook=(r,patch={})=>({hook_event_name:'PostToolUse',session_id:sessionId,cwd,tool_use_id:randomUUID(),tool_name:'Bash',tool_response:{stdout:r.marker,interrupted:false},...patch});
    const confirm=input=>confirmClaudeAction(input,{cwd});
    const act=async(action,payload)=>{const r=await request(action,payload);return confirm(hook(r));};
    return {record,env,envFile,request,hook,confirm,act};
  }
  return {dir,cwd,start};
}
const goalInput={title:'A useful outcome',scope:'Fixture only',criteria:'Roundtrip confirmed'};
async function root(s) {await s.act('create-goal',goalInput);return (await listGoals()).at(-1);}
const context=output=>output?.hookSpecificOutput?.additionalContext;

test('optional connection actions require the main hook and replay a completed request silently',async t=>{
  const f=await fixture(t),s=await f.start();let calls=0;
  const payload={extension:'sample',operation:'configure',input:{enabled:true}},request=await s.request('extension',payload);
  const extensions=async()=>({sample:{confirmAction:async input=>{calls++;assert.equal(input.requestId,request.requestId);assert.equal(input.connection.sessionId,s.record.sessionId);return {result:{enabled:true},context:'Applied in this conversation.'};}}});
  const h=s.hook(request,{prompt_id:randomUUID()});
  assert.equal(await confirmClaudeAction({...h,agent_id:'child'},{cwd:f.cwd,extensions}),null);assert.equal(calls,0);
  assert.match(context(await confirmClaudeAction(h,{cwd:f.cwd,extensions})),/Applied/);
  assert.equal(await confirmClaudeAction(h,{cwd:f.cwd,extensions}),null);assert.equal(calls,1);
  assert.deepEqual((await inspectClaudeRequest(request.requestId,{env:s.env})).result,{enabled:true});
  const unavailable=await s.request('extension',payload);
  await assert.rejects(confirmClaudeAction(s.hook(unavailable),{cwd:f.cwd,extensions:async()=>({})}),/unavailable/);
  await assert.rejects(s.request('extension',{...payload,input:[]}),/Invalid connection extension/);
  await assert.rejects(s.request('extension',{...payload,input:{large:'x'.repeat(10001)}}),/Invalid connection extension/);
});

test('shell request alone cannot bind a Root; native main hook commits once across concurrent replays',async t=>{
  const f=await fixture(t),s=await f.start(),r=await s.request('create-goal',goalInput),h=s.hook(r);
  assert.equal((await listGoals()).length,0);
  for(const patch of [{agent_id:'child'},{agent_id:''},{hook_event_name:'Stop'},{tool_name:'Read'},{tool_response:{stdout:r.marker,interrupted:true}},{tool_response:{stdout:'prefix '+r.marker}}])assert.equal(await s.confirm({...h,...patch}),null);
  assert.equal((await listGoals()).length,0);
  const outcomes=await Promise.all([s.confirm(h),s.confirm(h)]);
  assert.equal(outcomes.filter(Boolean).length,1);
  const g=(await listGoals())[0];assert.equal(g.threadId,null);assert.deepEqual(g.connection,{harnessId:'claude-code',sessionId:s.record.sessionId,contextId:s.record.contextId});
  assert.match(context(outcomes.find(Boolean)),/Created Goal #1/);
  await s.confirm(s.hook(r));assert.equal((await listGoals()).length,1);
  const status=await readAgentStatus(g.id);assert.equal(status.connected,true);assert.equal(status.agent.name,'Claude Code');
  assert.deepEqual(status.capabilities,{settings:false,stop:false,resume:false,approveAll:true});
  assert.match(agentMarkup(status),/Claude Code/);assert.doesNotMatch(agentMarkup(status),/Codex account|data-agent-settings/);
});

test('stale generations, another session and clear cannot confirm an inherited action',async t=>{
  const f=await fixture(t),first=await f.start(),r=await first.request('create-goal',goalInput),second=await f.start('other');
  await assert.rejects(second.confirm(second.hook(r)),/stale or different/);
  const resumed=await f.start(first.record.sessionId,'resume');assert.equal(resumed.record.contextId,first.record.contextId);
  await assert.rejects(first.confirm(first.hook(r)),/stale/);
  const compact=await f.start(first.record.sessionId,'compact');assert.equal(compact.record.contextId,first.record.contextId);
  const pending=await compact.request('create-goal',goalInput);
  const cleared=await f.start(first.record.sessionId,'clear');assert.notEqual(cleared.record.contextId,first.record.contextId);
  await assert.rejects(cleared.confirm(cleared.hook(pending)),/stale/);
  assert.equal((await listGoals()).length,0);
});

test('binding recovers a crash between Root and request completion without duplicate Goals',async t=>{
  const f=await fixture(t),s=await f.start(),r=await s.request('create-goal',goalInput);
  const connection={harnessId:'claude-code',sessionId:s.record.sessionId,contextId:s.record.contextId};
  const first=await createClaudeRoot(goalInput,connection,r.requestId);
  await rm(join(process.env.CHILL_AGENT_DATA_DIR,'workspace/goals',first.id,'deliverable.html'));
  assert.match(context(await s.confirm(s.hook(r))),/Created Goal #1/);
  assert.equal((await listGoals()).length,1);assert.equal(await readFile(join(process.env.CHILL_AGENT_DATA_DIR,'workspace/goals/1/deliverable.html'),'utf8'),'');
  await assert.rejects(createClaudeRoot({...goalInput,title:'changed'},connection,r.requestId),/changed/);
  await assert.rejects(updateGoal(first.id,{threadId:randomUUID()}),/reassigned/);
  await assert.rejects(assignGoal(first.id,null),/Reassignment/);
  const other=await createGoal({title:'Other'}),child=await createGoal({title:'Child',parentId:first.id});
  await assert.rejects(updateGoal(first.id,{parentId:other.id}),/reassigned/);
  await assert.rejects(updateGoal(child.id,{parentId:other.id}),/between native/);
});

test('saved requests can be inspected and deliberately recovered after resume, never after clear',async t=>{
  const f=await fixture(t),s=await f.start(),r=await s.request('create-goal',goalInput);
  assert.equal((await inspectClaudeRequest(r.requestId,{env:s.env})).status,'pending');
  const resumed=await f.start(s.record.sessionId,'resume');
  const retry=await inspectClaudeRequest(r.requestId,{env:resumed.env,retry:true});
  assert.equal(retry.marker,r.marker);
  assert.match(context(await resumed.confirm(resumed.hook(retry))),/Created Goal #1/);
  const done=await inspectClaudeRequest(r.requestId,{env:resumed.env,retry:true});
  assert.equal(done.marker,undefined);assert.equal(done.result.goalId,'1');assert.equal(done.status,'completed');
  assert.equal((await listGoals()).length,1);
  const clear=await f.start(s.record.sessionId,'clear');
  await assert.rejects(inspectClaudeRequest(r.requestId,{env:clear.env,retry:true}),/another conversation context/);
  await assert.rejects(inspectClaudeRequest(r.requestId,{env:s.env}),/another conversation context/);
});

test('two Roots and a child return feedback to the same main conversation with durable receipts',async t=>{
  const f=await fixture(t),s=await f.start(),g=await root(s),g2=await root(s),child=await createGoal({title:'Child',parentId:g.id});
  const e1=await appendFeedback({goalId:child.id,text:'first'}),e2=await appendFeedback({goalId:g2.id,text:'second'});
  assert.deepEqual(e1.connection,g.connection);
  assert.equal((await deliverFeedback(e1.changeId)).status,'saved');
  const pending=await s.request('inbox');assert.equal((await readDeliveryState(e1.changeId)).status,'saved');
  const h=s.hook(pending),output=await s.confirm(h);
  assert.match(context(output),/first/);assert.match(context(output),/second/);
  assert.equal(await s.confirm(h),null);
  const offered=await readDeliveryState(e1.changeId);assert.equal(offered.status,'unknown');assert.equal(offered.mayHaveSent,true);assert.equal(needsWorkRefresh(offered),false);
  // Explicit recovery keeps the offer ID rather than sending via another route.
  assert.match(context(await s.act('inbox')),/first/);
  assert.equal((await readDeliveryState(e1.changeId)).nativeOfferId,offered.nativeOfferId);
  assert.equal((await deliverFeedback(e1.changeId)).status,'unknown');
  await s.act('activity',{eventId:e1.changeId,state:'working'});
  await s.act('activity',{eventId:e1.changeId,state:'completed'});
  await s.act('activity',{eventId:e1.changeId,state:'completed'});
  await assert.rejects(s.act('activity',{eventId:e1.changeId,state:'working'}),/terminal/);
  assert.doesNotMatch(context(await s.act('inbox')),/"text":"first"/);
  assert.equal((await readGoal(g.id)).state,'idle');assert.equal((await readDeliveryState(e2.changeId)).status,'unknown');
});

test('separate, resumed and cleared contexts cannot steal feedback; no receipt before inbox',async t=>{
  const f=await fixture(t),s=await f.start(),g=await root(s),e=await appendFeedback({goalId:g.id,text:'private fixture'}),other=await f.start('other');
  await assert.rejects(s.act('activity',{eventId:e.changeId,state:'completed'}),/inbox first/);
  assert.doesNotMatch(context(await other.act('inbox')),/private fixture/);
  await assert.rejects(other.act('activity',{eventId:e.changeId,state:'working'}),/another conversation/);
  const resumed=await f.start(s.record.sessionId,'resume');assert.match(context(await resumed.act('inbox')),/private fixture/);
  const clear=await f.start(s.record.sessionId,'clear');assert.doesNotMatch(context(await clear.act('inbox')),/private fixture/);
  await assert.rejects(clear.act('activity',{eventId:e.changeId,state:'working'}),/another conversation/);
});

test('manual held deliveries and Root holds stay untouched',async t=>{
  const f=await fixture(t),s=await f.start(),g=await root(s),e=await appendFeedback({goalId:g.id,text:'held fixture'});
  await deliverFeedback(e.changeId);await updateDelivery(e.changeId,{heldBy:'manual'});
  assert.doesNotMatch(context(await s.act('inbox')),/held fixture/);
  await assert.rejects(s.act('activity',{eventId:e.changeId,state:'working'}),/held/);
  await updateDelivery(e.changeId,{heldBy:null});
  const holds=join(process.env.CHILL_AGENT_DATA_DIR,'workspace/feedback-holds');await mkdir(holds);
  await writeFile(join(holds,`${g.id}.json`),JSON.stringify({goalId:g.id,phase:'paused'}));
  assert.doesNotMatch(context(await s.act('inbox')),/held fixture/);
  assert.equal((await readDeliveryState(e.changeId)).status,'saved');
});

test('actual connection CLI prints an intent, hook JSON confirms, and subagent output stays silent',{skip:process.platform==='win32'&&'runs through POSIX /bin/sh'},async t=>{
  const f=await fixture(t),s=await f.start();
  const execute=promisify(execFile),entry=fileURLToPath(new URL('../bin/chill-connection.mjs',import.meta.url));
  const {stdout}=await execute(process.execPath,[entry,'create-goal','--title','CLI outcome'],{cwd:f.cwd,env:{...process.env,...s.env}});
  assert.equal((await listGoals()).length,0);
  const input=s.hook({marker:stdout});
  const path=join(f.dir,'hook.json');await writeFile(path,JSON.stringify({...input,agent_id:'child'}));
  const run=()=>execute('/bin/sh',['-c','exec "$1" "$2" claude-hook < "$3"','probe',process.execPath,entry,path],{cwd:f.cwd,env:process.env});
  assert.equal((await run()).stdout,'');
  await writeFile(path,JSON.stringify(input));
  const output=JSON.parse((await run()).stdout);assert.match(context(output),/Created Goal #1/);
  assert.equal((await run()).stdout,'');
  const files=await readdir(join(process.env.CHILL_AGENT_DATA_DIR,'workspace/connections/claude-code/requests'));assert.equal(files.length,1);
});

async function automaticFixture(t) {
  const f=await fixture(t),s=await f.start(),promptId=randomUUID();
  const handle=input=>handleClaudeToolHook(input,{cwd:f.cwd});
  const call=(patch={})=>s.hook({marker:'ordinary work output'},{prompt_id:promptId,...patch});
  const request=await s.request('create-goal',goalInput);
  await handle(s.hook(request,{prompt_id:promptId}));
  return {...f,s,promptId,handle,call,goal:(await listGoals())[0]};
}

test('ordinary main tool hooks offer all assigned Goals once without a selected work Goal or inbox call',async t=>{
  const f=await automaticFixture(t),child=await createGoal({title:'Child',parentId:f.goal.id});
  const request=await f.s.request('create-goal',goalInput);await f.handle(f.s.hook(request,{prompt_id:f.promptId}));
  const second=(await listGoals()).at(-1);
  const first=await appendFeedback({goalId:child.id,text:'child feedback'});
  await appendFeedback({goalId:second.id,text:'other root feedback'});
  const hook=f.call({tool_name:'Read'});
  const results=await Promise.all([f.handle(hook),f.handle(f.call())]);
  assert.equal(results.filter(Boolean).length,1);
  const text=context(results.find(Boolean));assert.match(text,/child feedback/);assert.match(text,/other root feedback/);
  assert.equal((await readDeliveryState(first.id)).status,'unknown');
  assert.equal(await f.handle(f.call()),null,'unconfirmed input is never automatically reoffered');
  await appendFeedback({goalId:f.goal.id,text:'arrived later'});
  assert.equal(await f.handle(hook),null,'a repeated hook cannot offer later input');
  assert.match(context(await f.handle(f.call())),/arrived later/);
});

test('automatic offers require the verified main prompt, and respect holds and other owners',async t=>{
  const f=await automaticFixture(t),e=await appendFeedback({goalId:f.goal.id,text:'pending native feedback'});
  const other=await f.start('different-session'),g=await root(other);await appendFeedback({goalId:g.id,text:'another owner'});
  for(const patch of [{agent_id:'child'},{prompt_id:randomUUID()},{prompt_id:null},{prompt_id:'not-a-native-prompt'},{tool_use_id:null},{hook_event_name:'PreToolUse'},{tool_response:{interrupted:true}}])assert.equal(await f.handle(f.call(patch)),null);
  await deliverFeedback(e.id);await updateDelivery(e.id,{heldBy:'manual'});
  assert.equal(await f.handle(f.call()),null);
  await updateDelivery(e.id,{heldBy:null});
  const text=context(await f.handle(f.call()));assert.match(text,/pending native feedback/);assert.doesNotMatch(text,/another owner/);
});

test('Stop, clear and generation changes disarm automatic offers; a fresh main action reestablishes the prompt',async t=>{
  const f=await automaticFixture(t);
  await f.handle(f.call({hook_event_name:'Stop'}));
  await appendFeedback({goalId:f.goal.id,text:'after stop'});
  assert.equal(await f.handle(f.call()),null);
  const nextPrompt=randomUUID(),r=await f.s.request('inbox');
  await f.handle(f.s.hook(r,{prompt_id:nextPrompt}));
  await appendFeedback({goalId:f.goal.id,text:'new prompt feedback'});
  assert.equal(await f.handle(f.call()),null);
  assert.match(context(await f.handle(f.call({prompt_id:nextPrompt}))),/new prompt feedback/);
  await f.start(f.s.record.sessionId,'compact');
  await appendFeedback({goalId:f.goal.id,text:'after compact'});
  assert.equal(await f.handle(f.call({prompt_id:nextPrompt})),null);
  await f.start(f.s.record.sessionId,'clear');
  assert.equal(await f.handle(f.call({prompt_id:nextPrompt})),null);
});

test('explicit recovery retains the offer ID, but processing retries never reveal held feedback',async t=>{
  const f=await automaticFixture(t),e=await appendFeedback({goalId:f.goal.id,text:'recoverable feedback'});
  await f.handle(f.call());const first=await readDeliveryState(e.id);
  const r=await f.s.request('inbox');await f.handle(f.s.hook(r,{prompt_id:f.promptId}));
  assert.equal((await readDeliveryState(e.id)).nativeOfferId,first.nativeOfferId);
  const p=join(process.env.CHILL_AGENT_DATA_DIR,'workspace/connections/claude-code/requests',`${r.requestId}.json`);
  const saved=JSON.parse(await readFile(p,'utf8'));await writeFile(p,JSON.stringify({...saved,status:'processing'}));
  await updateDelivery(e.id,{heldBy:'manual'});
  const retried=await f.handle(f.s.hook(r,{prompt_id:f.promptId}));
  assert.doesNotMatch(context(retried),/recoverable feedback/);
  assert.equal((await readDeliveryState(e.id)).heldBy,'manual');
});

test('an automatic inbox failure does not hide an already confirmed action',async t=>{
  const f=await fixture(t),s=await f.start(),r=await s.request('create-goal',goalInput);
  await initializeStore();const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(join(process.env.CHILL_AGENT_DATA_DIR,'workspace/workspace.sqlite'));db.exec('DROP TABLE events');db.close();
  const result=await handleClaudeToolHook(s.hook(r,{prompt_id:randomUUID()}),{cwd:f.cwd});
  assert.match(context(result),/Created Goal #1/);assert.match(context(result),/Automatic feedback could not be checked/);
  assert.equal((await listGoals()).length,1);
});

test('one Bash output confirms every chill request it carries',async t=>{
  const f=await fixture(t),s=await f.start(),goal=await root(s);
  const first=await appendFeedback({goalId:goal.id,text:'First'}),second=await appendFeedback({goalId:goal.id,text:'Second'});
  for(const event of [first,second])await deliverFeedback(event.changeId);
  await s.act('inbox',{});
  const a=await s.request('activity',{eventId:first.changeId,state:'working'}),b=await s.request('activity',{eventId:second.changeId,state:'completed'});
  const output=context(await s.confirm(s.hook(a,{tool_response:{stdout:`${a.marker}\nnoise\n${b.marker}\n${a.marker}`,interrupted:false}})));
  assert.match(output,new RegExp(`Feedback #${first.changeId}: working`));
  assert.match(output,new RegExp(`Feedback #${second.changeId}: completed`));
  assert.equal((await readDeliveryState(first.changeId)).status,'working');
  assert.equal((await readDeliveryState(second.changeId)).status,'completed');
});

test('goal activity from a Claude conversation becomes a hook-confirmed receipt',async t=>{
  const f=await fixture(t),s=await f.start(),goal=await root(s);
  const event=await appendFeedback({goalId:goal.id,text:'Longer work'});await deliverFeedback(event.changeId);
  await s.act('inbox',{});
  const {recordActivity}=await import('../lib/delivery.mjs');
  await assert.rejects(recordActivity(event.changeId,'deferred',s.env),/native Queue/);
  const pending=await recordActivity(event.changeId,'working',s.env);
  assert.match(pending.pending,/^\[chill-claude-request:[0-9a-f-]{36}\]$/);
  assert.notEqual((await readDeliveryState(event.changeId)).status,'working');
  assert.match(context(await s.confirm(s.hook({marker:pending.pending}))),/working/);
  assert.equal((await readDeliveryState(event.changeId)).status,'working');
});

test('the Activity row under a Claude message pauses and resumes its conversation',async t=>{
  const f=await fixture(t),s=await f.start(),goal=await root(s);
  const {readAgentActivityRow,controlAgent}=await import('../lib/agent-status.mjs');
  const event=await appendFeedback({goalId:goal.id,text:'Later'});await deliverFeedback(event.changeId);
  const saved=await readAgentActivityRow(goal.id);
  assert.equal(saved.eventId,event.changeId);assert.equal(saved.status,'saved');assert.deepEqual(saved.capabilities,{stop:true,resume:false});
  await assert.rejects(controlAgent(goal.id,{action:'stop',token:'other',eventId:event.changeId}),/Agent changed/);
  const paused=await controlAgent(goal.id,{action:'stop',token:saved.token,eventId:event.changeId});
  assert.equal(paused.status,'paused');assert.deepEqual(paused.capabilities,{stop:false,resume:true});
  assert.equal(paused.eventId,event.changeId,'the row stays on the paused message');
  const resumed=await controlAgent(goal.id,{action:'resume',token:saved.token,eventId:event.changeId});
  assert.equal(resumed.status,'saved');
});

test('goal work from a Claude conversation marks its Goal Running for the current response',async t=>{
  const f=await fixture(t),s=await f.start(),goal=await root(s);
  const {claudeEntryPaths}=await import('../lib/claude-entry.mjs');
  const {selectAgentWork,agentFor}=await import('../lib/agents/index.mjs');
  const {createGoal}=await import('../lib/goal-store.mjs');
  const child=await createGoal({title:'Child work',parentId:goal.id});
  const location=claudeEntryPaths(process.env.CHILL_AGENT_DATA_DIR,s.record.sessionId),transcript=join(f.dir,'session.jsonl');
  await writeFile(location.record,JSON.stringify({...JSON.parse(await readFile(location.record,'utf8')),transcriptPath:transcript}));
  await writeFile(transcript,JSON.stringify({type:'user',uuid:'p1',message:{role:'user',content:'Do the work'}})+'\n');
  await assert.rejects(selectAgentWork(child.id,{env:{}}),/handshake|assigned chat/);
  const work=await selectAgentWork(child.id,{env:s.env});
  assert.equal(work.goalId,child.id);
  const presence=await agentFor((await listGoals()).find(g=>g.id===goal.id)).presence();
  assert.equal(presence.status,'working');assert.equal(presence.goalId,child.id);
  assert.equal((await readGoal(child.id)).started,true);
  await selectAgentWork(child.id,{stop:true,env:s.env});
  assert.equal((await agentFor((await listGoals()).find(g=>g.id===goal.id)).presence()).goalId,null);
  // The selection ends with the response that made it.
  await selectAgentWork(child.id,{env:s.env});
  await writeFile(transcript,JSON.stringify({type:'system',subtype:'stop_hook_summary',uuid:'s1'})+'\n',{flag:'a'});
  assert.equal((await agentFor((await listGoals()).find(g=>g.id===goal.id)).presence()).goalId,null);
});

test('a request the main hook cannot confirm tells the agent why',async t=>{
  const f=await fixture(t),s=await f.start(),goal=await root(s);
  const event=await appendFeedback({goalId:goal.id,text:'Done already'});await deliverFeedback(event.changeId);
  await s.act('inbox',{});
  await s.act('activity',{eventId:event.changeId,state:'completed'});
  const r=await s.request('reply',{eventId:event.changeId,text:'Late reply'});
  const output=context(await handleClaudeToolHook(s.hook(r),{cwd:f.cwd}));
  assert.match(output,/not confirmed: Feedback already has a terminal receipt/);
});

test('two Claude conversations in one project, each with its own Root, never receive or control each other',async t=>{
  const f=await fixture(t),a=await f.start('session-a'),b=await f.start('session-b');
  const rootA=await root(a),rootB=await root(b);
  assert.notEqual(rootA.id,rootB.id);
  const {readAgentStatus,controlAgent,readAgentActivityRow}=await import('../lib/agent-status.mjs');
  const {agentFor,callerOwns,selectAgentWork}=await import('../lib/agents/index.mjs');
  const {hasSavedClaudeFeedback}=await import('../lib/claude-actions.mjs');
  const {claudePermissionDecision}=await import('../lib/claude-permissions.mjs');
  const connection=s=>({harnessId:'claude-code',sessionId:s.record.sessionId,contextId:s.record.contextId});
  const forA=await appendFeedback({goalId:rootA.id,text:'For A'}),forB=await appendFeedback({goalId:rootB.id,text:'For B'});
  for(const event of [forA,forB])await deliverFeedback(event.changeId);
  // Each conversation's waiter and inbox see only its own Root's feedback.
  assert.equal(await hasSavedClaudeFeedback(connection(a)),true);assert.equal(await hasSavedClaudeFeedback(connection(b)),true);
  const inboxA=context(await a.act('inbox',{}));
  assert.match(inboxA,/For A/);assert.doesNotMatch(inboxA,/For B/);
  assert.equal(await hasSavedClaudeFeedback(connection(b)),true,'A reading its inbox leaves B\'s feedback waiting');
  const inboxB=context(await b.act('inbox',{}));
  assert.match(inboxB,/For B/);assert.doesNotMatch(inboxB,/For A/);
  // A cannot record a receipt for B's feedback.
  await assert.rejects(a.act('activity',{eventId:forB.changeId,state:'completed'}),/another conversation/);
  assert.notEqual((await readDeliveryState(forB.changeId)).status,'completed');
  // Agent menu and caller identity are per Root.
  const [statusA,statusB]=await Promise.all([readAgentStatus(rootA.id),readAgentStatus(rootB.id)]);
  assert.notEqual(statusA.token,statusB.token);
  const rootOf=async id=>(await listGoals()).find(g=>g.id===id);
  assert.equal(await callerOwns(await rootOf(rootA.id),a.env),true);assert.equal(await callerOwns(await rootOf(rootA.id),b.env),false);
  assert.equal(await agentFor(await rootOf(rootB.id)).isCaller(a.env),false);
  // goal work from B on A's Goal is refused.
  await assert.rejects(selectAgentWork(rootA.id,{env:b.env}),/assigned chat/);
  // Pause and Approve all on A leave B alone.
  const second=await appendFeedback({goalId:rootA.id,text:'A again'});await deliverFeedback(second.changeId);
  const row=await readAgentActivityRow(rootA.id);
  await controlAgent(rootA.id,{action:'stop',token:row.token,eventId:row.eventId});
  assert.equal((await readAgentStatus(rootA.id)).capabilities.resume,true);
  assert.equal((await readAgentStatus(rootB.id)).capabilities.resume,false);
  await controlAgent(rootA.id,{scope:'permissions',token:statusA.token,approveAll:true});
  const ask=s=>claudePermissionDecision({hook_event_name:'PermissionRequest',session_id:s.record.sessionId,tool_name:'Bash',tool_input:{command:'ls'}});
  assert.equal(await ask(b),null,'B still asks for its own permissions');
  assert.equal((await readAgentStatus(rootB.id)).approveAll,false);
});
