import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {captureClaudeEntry} from '../lib/claude-entry.mjs';
import {requestClaudeAction,handleClaudeToolHook,collectClaudeHookFeedback,handleClaudeStopExtensions} from '../lib/claude-actions.mjs';
import {listGoals,createGoal,appendFeedback,updateGoal} from '../lib/goal-store.mjs';
import {readDeliveryState} from '../lib/delivery.mjs';
import {readMonitor} from '../lib/continuation-monitor.mjs';

async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'claude-auto-')),cwd=join(dir,'project');await mkdir(cwd);
 const old=process.env.CHILL_AGENT_DATA_DIR;process.env.CHILL_AGENT_DATA_DIR=join(dir,'data');
 t.after(async()=>{if(old===undefined)delete process.env.CHILL_AGENT_DATA_DIR;else process.env.CHILL_AGENT_DATA_DIR=old;await rm(dir,{recursive:true,force:true});});
 const envFile=join(dir,'env');await writeFile(envFile,'');
 const sessionId=randomUUID();let promptId=randomUUID(),env;
 const event=(name,patch={})=>({hook_event_name:name,session_id:sessionId,prompt_id:promptId,cwd,...patch});
 async function start(source='startup'){const r=await captureClaudeEntry(event('SessionStart',{source}),{cwd,env:{CLAUDE_ENV_FILE:envFile}});env={CHILL_AGENT_HARNESS:'claude-code',CHILL_AGENT_SESSION_ID:sessionId,CHILL_AGENT_CONNECTION_GENERATION:r.generation};}
 async function action(action,payload,patch={}){const r=await requestClaudeAction(action,payload,{env});return handleClaudeToolHook(event('PostToolUse',{tool_name:'Bash',tool_use_id:randomUUID(),tool_response:{stdout:r.marker},...patch}),{cwd});}
 await start();await action('create-goal',{title:'Native Auto mode',scope:'One verified continuation',criteria:'No duplicate or lost input'});const root=(await listGoals())[0];
 const configure=(enabled=true)=>action('extension',{extension:'continuation',operation:'configure',input:{rootId:root.id,enabled}});
 const pause=paused=>action('extension',{extension:'continuation',operation:'pause',input:{rootId:root.id,paused}});
 const result=(attemptId,outcome='no-work',patch={})=>action('extension',{extension:'continuation',operation:'result',input:{rootId:root.id,attemptId,outcome}},patch);
 return {dir,cwd,root,event,action,start,configure,pause,result,read:()=>readMonitor(root.id),stop:(patch={})=>handleClaudeToolHook(event('Stop',patch),{cwd}),newPrompt:async()=>{promptId=randomUUID();await handleClaudeToolHook(event('UserPromptSubmit'),{cwd});}};
}

test('confirmed Stop reserves once; receipt and the matching Stop consume the revision',async t=>{
 const f=await fixture(t);await f.configure();
 const [a,b]=await Promise.all([f.stop(),f.stop()]);const response=a||b;assert.equal([a,b].filter(Boolean).length,1);
 assert.equal(response.decision,'block');assert.match(response.reason,/Auto mode is On/);assert.match(response.reason,/native main response has ended/);assert.doesNotMatch(response.reason,/no pending delivery, queued message/);
 let state=await f.read();assert.equal(state.attempts.length,1);const attempt=state.attempts[0];assert.equal(attempt.message,response.reason);assert.equal(attempt.phase,'uncertain');
 await f.newPrompt();await f.result(attempt.id);assert.equal((await f.read()).attempts[0].completedAt,undefined,'a receipt is not native completion');
 assert.equal(await f.stop({prompt_id:randomUUID()}),null);
 assert.equal(await f.stop(),null);state=await f.read();assert.equal(state.status,'exhausted');assert.equal(state.attempts[0].phase,'completed');
 await f.configure(false);await f.configure(true);assert.equal(await f.stop(),null,'toggling does not reset the allowance');
 await updateGoal(f.root.id,{scope:'A new agreed outcome'});await f.newPrompt();await f.configure();assert.equal((await f.stop()).decision,'block');assert.equal((await f.read()).history.length,1);
});
test('unknown return never retries after a content revision or another native prompt',async t=>{
 const f=await fixture(t);await f.configure();await f.stop();const original=(await f.read()).attempts[0].id;
 await updateGoal(f.root.id,{title:'Changed while unconfirmed'});await f.newPrompt();await f.configure();assert.equal(await f.stop(),null);assert.equal((await f.read()).status,'awaiting-receipt');assert.equal((await f.read()).attempts[0].id,original);
});
test('the continued native prompt still receives Web input on its next ordinary tool',async t=>{
 const f=await fixture(t);await f.configure();assert.equal((await f.stop()).decision,'block');
 assert.equal(await f.stop(),null,'a repeated Stop is not another native turn');
 const reply=await appendFeedback({goalId:f.root.id,text:'Correction while Auto mode is working'});
 const hook=f.event('PostToolUse',{tool_name:'Read',tool_use_id:randomUUID(),tool_response:{text:'ordinary work'}});
 const received=await handleClaudeToolHook(hook,{cwd:f.cwd});assert.match(received.hookSpecificOutput.additionalContext,/Correction while Auto mode is working/);
 assert.equal((await readDeliveryState(reply.changeId)).status,'unknown');
 assert.equal(await handleClaudeToolHook(hook,{cwd:f.cwd}),null,'tool delivery is not duplicated');
 assert.equal(await f.stop(),null,'the unresolved Auto request is not resent');
});
test('Off and explicit continuation Pause preserve the attempt history',async t=>{
 const f=await fixture(t);await f.configure(false);assert.equal(await f.stop(),null);
 await f.newPrompt();await f.configure();await f.pause(true);assert.equal(await f.stop(),null);assert.equal((await f.read()).attempts.length,0);
 await f.configure(false);await f.configure();assert.equal(await f.stop(),null,'On does not release a manual continuation pause');
 await f.pause(false);assert.equal((await f.stop()).decision,'block');
});
test('a child hold and pending input in another assigned Root suppress continuation',async t=>{
 const f=await fixture(t),child=await createGoal({title:'Held child',parentId:f.root.id});await f.configure();
 const holds=join(process.env.CHILL_AGENT_DATA_DIR,'workspace/feedback-holds');await mkdir(holds,{recursive:true});await writeFile(join(holds,`${child.id}.json`),JSON.stringify({phase:'paused'}));
 assert.equal(await f.stop(),null);assert.equal((await f.read()).status,'paused');
 await writeFile(join(holds,`${child.id}.json`),JSON.stringify({phase:'sent'}));
 await f.action('create-goal',{title:'Other Root',scope:'',criteria:''});const other=(await listGoals()).at(-1);const reply=await appendFeedback({goalId:other.id,text:'Wait for my correction'});
 assert.equal(await f.stop(),null);assert.equal((await f.read()).status,'feedback-pending');assert.equal(await readDeliveryState(reply.changeId),null,'policy does not claim input');
});
test('working or uncertain Web receipts are not proof that feedback is complete',async t=>{
 const f=await fixture(t);await f.configure();const reply=await appendFeedback({goalId:f.root.id,text:'New input'});await f.action('inbox',{});
 assert.equal(await f.stop(),null);await f.action('activity',{eventId:reply.changeId,state:'working'});assert.equal(await f.stop(),null);
 await f.action('activity',{eventId:reply.changeId,state:'completed'});assert.equal((await f.stop()).decision,'block');
});
test('subagents and stale or missing native prompt identities cannot enable or continue',async t=>{
 const f=await fixture(t);
 await f.action('extension',{extension:'continuation',operation:'configure',input:{rootId:f.root.id,enabled:true}},{agent_id:'child'});assert.equal(await f.read(),null);
 await assert.rejects(f.action('extension',{extension:'continuation',operation:'configure',input:{rootId:f.root.id,enabled:true}},{prompt_id:null}),/prompt identity/);
 await f.configure();assert.equal(await f.stop({agent_id:'child'}),null);assert.equal(await f.stop({prompt_id:null}),null);
 await f.start('clear');assert.equal(await f.stop(),null);await assert.rejects(f.configure(),/Root conversation/);
});
test('an uncertain attempt in one Root does not create a second continuation in another Root',async t=>{
 const f=await fixture(t);await f.configure();await f.action('create-goal',{title:'Second Auto Root',scope:'',criteria:''});const other=(await listGoals()).at(-1);
 await f.action('extension',{extension:'continuation',operation:'configure',input:{rootId:other.id,enabled:true}});await f.stop();await f.newPrompt();await f.configure();
 assert.equal(await f.stop(),null);assert.equal((await readMonitor(other.id)).attempts.length,0);
});
test('saved Web feedback and Auto mode cannot both claim the same Stop',async t=>{
 // The reply waiter only detects saved feedback; a pending delivery makes Auto mode abstain.
 await t.test('feedback first',async t=>{
  const f=await fixture(t);await f.configure();
  await appendFeedback({goalId:f.root.id,text:'Saved before the response ended'});
  assert.equal(await f.stop(),null);assert.equal((await f.read()).attempts.length,0);
 });
 await t.test('continuation first',async t=>{
  const f=await fixture(t);await f.configure();
  assert.equal((await f.stop()).decision,'block');
  const reply=await appendFeedback({goalId:f.root.id,text:'Input after continuation won'});
  assert.equal(await readDeliveryState(reply.changeId),null,'the reply stays saved for the inbox');
 });
});
