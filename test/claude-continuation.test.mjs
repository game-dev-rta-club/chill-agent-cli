import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {captureClaudeEntry} from '../lib/claude-entry.mjs';
import {runClaudeAction,handleClaudeToolHook,collectClaudeHookFeedback,handleClaudeStop} from '../lib/claude-actions.mjs';
import {listGoals,createGoal,appendFeedback,appendAgentComment,updateGoal,readGoal} from '../lib/goal-store.mjs';
import {transferClaudeRoot} from '../lib/claude-roots.mjs';
import {readForWeb,configureFromWeb,onStop} from '../lib/claude-continuation.mjs';
import {storage} from '../lib/extension-api.mjs';
import {readMonitor} from '../lib/continuation-monitor.mjs';
import {hookFor} from './claude-fixtures.mjs';

async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'claude-auto-')),cwd=join(dir,'project');await mkdir(cwd);
 const old=process.env.CHILL_AGENT_DATA_DIR;process.env.CHILL_AGENT_DATA_DIR=join(dir,'data');
 t.after(async()=>{if(old===undefined)delete process.env.CHILL_AGENT_DATA_DIR;else process.env.CHILL_AGENT_DATA_DIR=old;await rm(dir,{recursive:true,force:true});});
 const envFile=join(dir,'env');await writeFile(envFile,'');
 const sessionId=randomUUID();let promptId=randomUUID(),env;
 const event=hookFor({session_id:sessionId,prompt_id:promptId,cwd});
 async function start(source='startup'){const r=await captureClaudeEntry(event('SessionStart',{source}),{cwd,env:{CLAUDE_ENV_FILE:envFile}});env={CHILL_AGENT_HARNESS:'claude-code',CHILL_AGENT_SESSION_ID:sessionId};}
 async function action(action,payload){const r=await runClaudeAction(action,payload,{env});return {hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:r.text}};}
 await start();await action('create-goal',{title:'Native Auto mode',scope:'One verified continuation',criteria:'No duplicate or lost input'});const root=(await listGoals())[0];
 const configure=(enabled=true)=>action('extension',{extension:'continuation',operation:'configure',input:{rootId:root.id,enabled}});
 const pause=paused=>action('extension',{extension:'continuation',operation:'pause',input:{rootId:root.id,paused}});
 const result=(attemptId,outcome='no-work',patch={})=>action('extension',{extension:'continuation',operation:'result',input:{rootId:root.id,attemptId,outcome}},patch);
 return {dir,cwd,root,event,action,start,configure,pause,result,read:()=>readMonitor(root.id),stop:(patch={})=>handleClaudeToolHook(event('Stop',patch),{cwd}),newPrompt:async()=>{promptId=randomUUID();await handleClaudeToolHook(event('UserPromptSubmit'),{cwd});}};
}

test('Stop reserves once; the next Stop ends the request and consumes the revision',async t=>{
 const f=await fixture(t);await f.configure();
 const response=await f.stop();
 assert.equal(response.decision,'block');assert.match(response.reason,/Auto mode is On/);assert.match(response.reason,/native main response has ended/);assert.doesNotMatch(response.reason,/no pending delivery, queued message/);
 let state=await f.read();assert.equal(state.attempts.length,1);const attempt=state.attempts[0];assert.equal(attempt.message,response.reason);assert.equal(attempt.phase,'uncertain');
 await f.newPrompt();await f.result(attempt.id);assert.equal((await f.read()).attempts[0].completedAt,undefined,'a receipt is not native completion');
 assert.equal(await f.stop({prompt_id:randomUUID()}),null);
 assert.equal(await f.stop(),null);state=await f.read();assert.equal(state.status,'exhausted');assert.equal(state.attempts[0].phase,'completed');
 await f.configure(false);await f.configure(true);assert.equal(await f.stop(),null,'toggling does not reset the allowance');
 await updateGoal(f.root.id,{scope:'A new agreed outcome'});await f.newPrompt();await f.configure();assert.equal((await f.stop()).decision,'block');assert.equal((await f.read()).history.length,1);
});
test('a request left without a result ends at the next Stop instead of stopping Auto mode for good',async t=>{
 // A continued response that forgot to report its result used to keep every
 // later Stop waiting, so Auto mode silently never continued again.
 const f=await fixture(t);await f.configure();await f.stop();const original=(await f.read()).attempts[0].id;
 assert.equal(await f.stop(),null,'the same revision is not continued twice');
 let state=await f.read();assert.equal(state.status,'exhausted');assert.equal(state.attempts[0].phase,'ended');
 await updateGoal(f.root.id,{title:'Changed later'});await f.newPrompt();assert.equal((await f.stop()).decision,'block');
 state=await f.read();assert.equal(state.history.at(-1).id,original);assert.notEqual(state.attempts[0].id,original);
});
test('Web input during an Auto mode run waits for its stop, and is answered before another request',async t=>{
 const f=await fixture(t);await f.configure();assert.equal((await f.stop()).decision,'block');
 const reply=await appendFeedback({goalId:f.root.id,text:'Correction while Auto mode is working'});
 const hook=f.event('PostToolUse',{tool_name:'Read',tool_use_id:randomUUID(),tool_response:{text:'ordinary work'}});
 assert.equal(await handleClaudeToolHook(hook,{cwd:f.cwd}),null,'the running work is not interrupted');
 assert.match((await f.stop()).reason,/Correction while Auto mode is working/,'its stop hands the correction over');
 assert.match((await f.stop()).reason,/where things stand/,'a handed Goal the user heard nothing about is held first');
 assert.match((await f.stop()).reason,new RegExp(`still waits for your reply: #${reply.changeId} `),'new input is a new revision; the request names the open feedback');
 await appendAgentComment({goalId:f.root.id,type:'comment',text:'Working on the correction; next update after the tests.'});
 assert.equal(await f.stop(),null,'the same revision is not continued again, and the user has heard back');
});
test('Off and explicit continuation Pause preserve the attempt history',async t=>{
 const f=await fixture(t);await f.configure(false);assert.equal(await f.stop(),null);
 await f.newPrompt();await f.configure();await f.pause(true);assert.equal(await f.stop(),null);assert.equal((await f.read()).attempts.length,0);
 await f.configure(false);await f.configure();assert.equal(await f.stop(),null,'On does not release a manual continuation pause');
 await f.pause(false);assert.equal((await f.stop()).decision,'block');
});
test('a child hold suppresses continuation, and input in another owned Root is handed before any request',async t=>{
 const f=await fixture(t),child=await createGoal({title:'Held child',parentId:f.root.id});await f.configure();
 const holds=join(process.env.CHILL_AGENT_DATA_DIR,'workspace/feedback-holds');await mkdir(holds,{recursive:true});await writeFile(join(holds,`${child.id}.json`),JSON.stringify({phase:'paused'}));
 assert.equal(await f.stop(),null);assert.equal((await f.read()).status,'paused');
 await writeFile(join(holds,`${child.id}.json`),JSON.stringify({phase:'sent'}));
 await f.action('create-goal',{title:'Other Root',scope:'',criteria:''});const other=(await listGoals()).at(-1);await appendFeedback({goalId:other.id,text:'Wait for my correction'});
 assert.match((await f.stop()).reason,/Wait for my correction/);assert.equal((await f.read()).attempts.length,0);
});
test('a handed Goal still awaiting a reply is named by the request until the agent replies',async t=>{
 const f=await fixture(t);await f.configure();const reply=await appendFeedback({goalId:f.root.id,text:'New input'});await f.action('inbox',{});
 assert.match((await f.stop()).reason,/where things stand/,'the hold comes first');
 const first=await f.stop();assert.equal(first.decision,'block');assert.match(first.reason,new RegExp(`#${reply.changeId} \\(Goal #${f.root.id}\\)`));
 const done=await fixture(t);await done.configure();await appendFeedback({goalId:done.root.id,text:'Quick input'});
 await done.action('inbox',{});await done.action('reply',{goalId:done.root.id,text:'Done'});
 const next=await done.stop();assert.equal(next.decision,'block');assert.doesNotMatch(next.reason,/still waits for your reply/);
});
test('a subagent Stop never continues, and a cleared context cannot control the earlier Root',async t=>{
 const f=await fixture(t);
 await f.configure();assert.equal(await f.stop({agent_id:'child'}),null);assert.equal((await f.read()).attempts.length,0);
 await f.start('clear');assert.equal(await f.stop(),null);await assert.rejects(f.configure(),/Root conversation/);
});
test('one Stop sends at most one request across the Roots of a conversation',async t=>{
 const f=await fixture(t);await f.configure();await f.action('create-goal',{title:'Second Auto Root',scope:'',criteria:''});const other=(await listGoals()).at(-1);
 await f.action('extension',{extension:'continuation',operation:'configure',input:{rootId:other.id,enabled:true}});
 assert.equal((await f.stop()).decision,'block');assert.equal((await f.read()).attempts.length,1);assert.equal((await readMonitor(other.id)).attempts.length,0);
 assert.equal((await f.stop()).decision,'block');assert.equal((await f.read()).attempts[0].phase,'ended');assert.equal((await readMonitor(other.id)).attempts.length,1);
});
test('saved Web feedback and Auto mode cannot both claim the same Stop',async t=>{
 // A Stop hands comments not handed yet before Auto mode may ask for anything.
 await t.test('feedback first',async t=>{
  const f=await fixture(t);await f.configure();
  await appendFeedback({goalId:f.root.id,text:'Saved before the response ended'});
  assert.match((await f.stop()).reason,/Saved before the response ended/);assert.equal((await f.read()).attempts.length,0);
 });
 await t.test('continuation first',async t=>{
  const f=await fixture(t);await f.configure();
  assert.equal((await f.stop()).decision,'block');
  const reply=await appendFeedback({goalId:f.root.id,text:'Input after continuation won'});
  assert.match((await f.stop()).reason,/Input after continuation won/,'the next stop hands it');
 });
});

test('the Web switch turns Auto mode on and off for the current conversation of the Root without a native prompt',async t=>{
 const f=await fixture(t),connection=(await readGoal(f.root.id)).connection;
 assert.equal(await readForWeb(f.root.id),null);
 await configureFromWeb(f.root.id,true);
 assert.deepEqual((await readForWeb(f.root.id)).connection,connection);
 assert.equal((await f.stop()).decision,'block','the conversation continues at its next Stop');
 await configureFromWeb(f.root.id,false);await updateGoal(f.root.id,{scope:'A new revision'});await f.newPrompt();
 assert.equal(await f.stop(),null,'Off from Web is respected');
 // Like the native command, the Web switch keeps a continuation Pause.
 await f.pause(true);await configureFromWeb(f.root.id,true);await updateGoal(f.root.id,{scope:'Another revision'});await f.newPrompt();
 assert.equal(await f.stop(),null);assert.equal((await readForWeb(f.root.id)).paused,true);
 await assert.rejects(configureFromWeb(f.root.id,'yes'),/boolean/);
 const codex=await createGoal({title:'Codex',threadId:'00000000-0000-0000-0000-0000000000aa'});
 await assert.rejects(configureFromWeb(codex.id,true),/Claude conversation is required/);
});

test('a taken-over Root keeps its setting; an unconfirmed request is closed, never resent',async t=>{
 const f=await fixture(t),earlier=(await readGoal(f.root.id)).connection;
 await configureFromWeb(f.root.id,true);
 const offered=await f.stop();assert.equal(offered.decision,'block');
 const continued={harnessId:'claude-code',sessionId:randomUUID(),contextId:randomUUID()};
 await transferClaudeRoot(f.root.id,earlier,continued,randomUUID());
 const moved=await readForWeb(f.root.id);
 assert.equal(moved.enabled,true);assert.deepEqual(moved.connection,continued);
 assert.equal(moved.attempts[0].phase,'assignment-changed');assert.ok(moved.attempts[0].completedAt);
 const stop=connection=>onStop({connection,promptId:randomUUID(),checkpointId:randomUUID(),generation:randomUUID()});
 assert.equal(await stop(earlier),null,'the earlier conversation no longer owns the setting');
 // The owner is part of the revision: the new conversation gets one check of its own.
 const next=await stop(continued);assert.match(next,/Auto mode is On/);
 const state=await readForWeb(f.root.id);
 assert.equal(state.history[0].id,moved.attempts[0].id,'the closed request is kept as history');
 assert.equal(state.attempts.length,1);assert.notEqual(state.attempts[0].id,moved.attempts[0].id);
 assert.equal(await stop(continued),null,'awaiting this request, not another one');
 // A record from an owner this Root never had reads as Off and is not overwritten.
 const journal=storage('continuation'),foreign={rootId:f.root.id,connection:{harnessId:'claude-code',sessionId:'other',contextId:randomUUID()},enabled:true,attempts:[]};
 await journal.write(f.root.id,foreign);
 assert.equal(await readForWeb(f.root.id),null);
 await assert.rejects(configureFromWeb(f.root.id,false),/assignment changed/);
 assert.deepEqual(await journal.read(f.root.id),foreign);
});

test('a stop is held while a handed Goal awaits a reply and nothing runs; the agent speaking on it lets it end',async t=>{
 const f=await fixture(t);
 await appendFeedback({goalId:f.root.id,text:'Short work'});await f.action('inbox',{});
 const first=await f.stop();
 assert.equal(first?.decision,'block');assert.match(first.reason,new RegExp(`Goal #${f.root.id}\\b`));
 assert.match(first.reason,/connection reply --goal <goalId>/);assert.match(first.reason,/goal comment --id <goalId>/);
 assert.equal(await f.stop({stop_hook_active:true}),null,'the stop right after a hold ends');
 await f.newPrompt();
 assert.equal((await f.stop())?.decision,'block','a later stop with still nothing said is held again');
 await f.stop({stop_hook_active:true});
 await f.newPrompt();
 assert.equal(await f.stop({background_tasks:[{id:'a1',type:'subagent',status:'running',description:'Review'}]}),null,'running background work wakes the conversation later');
 const waiter={id:'b1',type:'shell',status:'running',description:'Reply waiter',command:"'/data/runtime/chill' connection wait"};
 assert.equal((await f.stop({background_tasks:[waiter]}))?.decision,'block','chill\'s own reply waiter is not work');
 await f.stop({stop_hook_active:true});
 await f.newPrompt();await appendAgentComment({goalId:f.root.id,type:'comment',text:'Waiting for CI; I will check in 10 minutes.'});
 assert.equal(await f.stop(),null,'a progress comment answers the Goal');
 await appendFeedback({goalId:f.root.id,text:'Long work'});
 assert.match((await f.stop()).reason,/Long work/,'a new comment is handed at the stop');
 assert.equal((await f.stop())?.decision,'block','and its Goal awaits a reply again');
 await f.action('reply',{goalId:f.root.id,text:'Done'});
 assert.equal(await f.stop(),null,'a reply on the Goal');
});
