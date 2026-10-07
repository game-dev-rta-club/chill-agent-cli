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
import {createGoal,createClaudeRoot,listGoals,appendFeedback,readGoal,updateGoal} from '../lib/goal-store.mjs';
import {assignGoal} from '../lib/goal-execution.mjs';
import {deliverFeedback,readDeliveryState,updateDelivery} from '../lib/delivery.mjs';
import {readAgentStatus} from '../lib/agent-status.mjs';
import {needsWorkRefresh} from '../lib/work-output.mjs';
import {agentMarkup} from '../public/agent-menu.js';

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
  const status=await readAgentStatus(g.id);assert.equal(status.connected,false);assert.equal(status.nativeConnection.stage,'experimental');
  assert(Object.values(status.capabilities).every(v=>v===false));
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
  await rm(join(process.env.CHILL_AGENT_DATA_DIR,'workspace/goals',first.id,'brief.md'));
  assert.match(context(await s.confirm(s.hook(r))),/Created Goal #1/);
  assert.equal((await listGoals()).length,1);assert.equal(await readFile(join(process.env.CHILL_AGENT_DATA_DIR,'workspace/goals/1/brief.md'),'utf8'),'');
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
  await assert.rejects(inspectClaudeRequest(r.requestId,{env:s.env}),/stale/);
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

test('actual connection CLI prints an intent, hook JSON confirms, and subagent output stays silent',async t=>{
  const f=await fixture(t),s=await f.start();
  const execute=promisify(execFile),entry=new URL('../bin/chill-connection.mjs',import.meta.url).pathname;
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
  const events=join(process.env.CHILL_AGENT_DATA_DIR,'workspace/events');await mkdir(events,{recursive:true});await writeFile(join(events,'1.json'),'invalid JSON');
  const result=await handleClaudeToolHook(s.hook(r,{prompt_id:randomUUID()}),{cwd:f.cwd});
  assert.match(context(result),/Created Goal #1/);assert.match(context(result),/Automatic feedback could not be checked/);
  assert.equal((await listGoals()).length,1);
});
