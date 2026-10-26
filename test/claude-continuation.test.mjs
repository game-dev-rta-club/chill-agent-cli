import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {captureClaudeEntry} from '../lib/claude-entry.mjs';
import {runClaudeAction,handleClaudeToolHook} from '../lib/claude-actions.mjs';
import {listGoals,createGoal,appendFeedback,appendAgentComment,updateGoal,readGoal,readFeedback,setGoalAutonomy} from '../lib/goal-store.mjs';
import {transferClaudeRoot} from '../lib/claude-roots.mjs';
import {onStop} from '../lib/claude-continuation.mjs';
import {recordClaudeWork} from '../lib/claude-agent-work.mjs';
import {storage} from '../lib/extension-api.mjs';
import {readMonitor} from '../lib/continuation-monitor.mjs';
import {hookFor} from './claude-fixtures.mjs';

async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'claude-auto-')),cwd=join(dir,'project');await mkdir(cwd);
 const old=process.env.CHILL_AGENT_DATA_DIR;process.env.CHILL_AGENT_DATA_DIR=join(dir,'data');
 t.after(async()=>{if(old===undefined)delete process.env.CHILL_AGENT_DATA_DIR;else process.env.CHILL_AGENT_DATA_DIR=old;await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
 const envFile=join(dir,'env');await writeFile(envFile,'');
 const sessionId=randomUUID();let promptId=randomUUID(),env;
 const event=hookFor({session_id:sessionId,prompt_id:promptId,cwd});
 async function start(source='startup'){const r=await captureClaudeEntry(event('SessionStart',{source}),{cwd,env:{CLAUDE_ENV_FILE:envFile}});env={CHILL_AGENT_HARNESS:'claude-code',CHILL_AGENT_SESSION_ID:sessionId};}
 async function action(action,payload){const r=await runClaudeAction(action,payload,{env});return {hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:r.text}};}
 await start();await action('create-goal',{title:'Native Autonomy',scope:'One verified continuation',criteria:'No duplicate or lost input'});const root=(await listGoals())[0];
 // The Web's Autonomy slider on the Root.
 const configure=(level=2)=>setGoalAutonomy(root.id,level);
 return {dir,cwd,root,event,action,start,configure,sessionId,read:()=>readMonitor(root.id),stop:(patch={})=>handleClaudeToolHook(event('Stop',patch),{cwd}),newPrompt:async()=>{promptId=randomUUID();await handleClaudeToolHook(event('UserPromptSubmit'),{cwd});}};
}

test('Stop reserves once; the next Stop ends the request and consumes the revision',async t=>{
 const f=await fixture(t);await f.configure();
 const response=await f.stop();
 assert.equal(response.decision,'block');assert.match(response.reason,/Goal #1 “Native Autonomy”, Lv 2 Continue: After each turn, keep working on what was agreed for this Goal/);assert.match(response.reason,/connection wake --in/);
 let state=await f.read();assert.equal(state.attempts.length,1);const attempt=state.attempts[0];assert.equal(attempt.message,response.reason);assert.equal(attempt.phase,'uncertain');
 await f.newPrompt();assert.equal((await f.read()).attempts[0].completedAt,undefined,'a new prompt is not native completion');
 assert.equal(await f.stop({prompt_id:randomUUID()}),null);
 assert.equal(await f.stop(),null);state=await f.read();assert.equal(state.status,'exhausted');assert.equal(state.attempts[0].phase,'completed');
 await f.configure(1);assert.equal(await f.stop(),null,'Normal asks for nothing');
 await f.configure(2);assert.equal(await f.stop(),null,'returning to the same level does not reset the allowance');
 await f.configure(3);await f.newPrompt();const drive=await f.stop();
 assert.equal(drive.decision,'block','a level change is a new revision');assert.equal((await f.read()).history.length,1);
 assert.match(drive.reason,/Lv 3 Drive: Drive the whole project under Root #1/);
 await f.stop();
 await updateGoal(f.root.id,{scope:'A new agreed outcome'});await f.newPrompt();assert.equal((await f.stop()).decision,'block','so is a content change');
});
test('a request left without a result ends at the next Stop instead of stopping the checks for good',async t=>{
 // A continued response that forgot to report its result used to keep every
 // later Stop waiting, so the checks silently never continued again.
 const f=await fixture(t);await f.configure();await f.stop();const original=(await f.read()).attempts[0].id;
 assert.equal(await f.stop(),null,'the same revision is not continued twice');
 let state=await f.read();assert.equal(state.status,'exhausted');assert.equal(state.attempts[0].phase,'completed');assert.equal(state.attempts[0].result.outcome,'no-work');
 await updateGoal(f.root.id,{title:'Changed later'});await f.newPrompt();assert.equal((await f.stop()).decision,'block');
 state=await f.read();assert.equal(state.history.at(-1).id,original);assert.notEqual(state.attempts[0].id,original);
});
test('Web input during a continued run waits for its stop, and is answered before another request',async t=>{
 const f=await fixture(t);await f.configure();assert.equal((await f.stop()).decision,'block');
 const reply=await appendFeedback({goalId:f.root.id,text:'Correction while the agent continues'});
 const hook=f.event('PostToolUse',{tool_name:'Read',tool_use_id:randomUUID(),tool_response:{text:'ordinary work'}});
 assert.equal(await handleClaudeToolHook(hook,{cwd:f.cwd}),null,'the running work is not interrupted');
 assert.match((await f.stop()).reason,/Correction while the agent continues/,'its stop hands the correction over');
 assert.match((await f.stop()).reason,/where things stand/,'a handed Goal the user heard nothing about is held first');
 assert.match((await f.stop()).reason,new RegExp(`still waits for your reply: comment ${reply.changeId} on Goal #1`),'new input is a new revision; the request names the open feedback');
 await appendAgentComment({goalId:f.root.id,type:'comment',text:'Working on the correction; next update after the tests.'});
 assert.equal(await f.stop(),null,'the same revision is not continued again, and the user has heard back');
});
test('a new Root starts at Normal: no check, no journal',async t=>{
 const f=await fixture(t);assert.equal((await readGoal(f.root.id)).autonomy,1);
 assert.equal(await f.stop(),null);assert.equal(await f.read(),null);
 await f.newPrompt();await f.configure();assert.equal((await f.stop()).decision,'block');
 await f.configure(1);await f.newPrompt();assert.equal(await f.stop(),null);assert.equal((await f.read()).attempts.length,1,'the history stays');
});
test('input in another owned Root is handed before any request',async t=>{
 const f=await fixture(t);await f.configure();
 await f.action('create-goal',{title:'Other Root',scope:'',criteria:''});const other=(await listGoals()).at(-1);await appendFeedback({goalId:other.id,text:'Wait for my correction'});
 assert.match((await f.stop()).reason,/Wait for my correction/);assert.equal((await f.read())?.attempts.length??0,0);
});
test('a handed Goal still awaiting a reply is named by the request until the agent replies',async t=>{
 const f=await fixture(t);await f.configure();const reply=await appendFeedback({goalId:f.root.id,text:'New input'});await f.action('inbox',{});
 assert.match((await f.stop()).reason,/where things stand/,'the hold comes first');
 const first=await f.stop();assert.equal(first.decision,'block');assert.match(first.reason,new RegExp(`comment ${reply.changeId} on Goal #${f.root.id}`));
 const done=await fixture(t);await done.configure();await appendFeedback({goalId:done.root.id,text:'Quick input'});
 await done.action('inbox',{});await done.action('reply',{goalId:done.root.id,text:'Done'});
 const next=await done.stop();assert.equal(next.decision,'block');assert.doesNotMatch(next.reason,/still waits for your reply/);
});
test('a subagent Stop never continues, and a cleared context does not continue the earlier Root',async t=>{
 const f=await fixture(t);
 await f.configure();assert.equal(await f.stop({agent_id:'child'}),null);assert.equal(await f.read(),null);
 await f.start('clear');assert.equal(await f.stop(),null);assert.equal(await f.read(),null);
});
test('one message per conversation, from the Root of its highest-level Goal, listing each Goal with its level',async t=>{
 const f=await fixture(t);await f.configure(2);await f.action('create-goal',{title:'Second Root',scope:'',criteria:''});const other=(await listGoals()).at(-1);
 await setGoalAutonomy(other.id,3);
 const {reason}=await f.stop();
 assert.match(reason,new RegExp(`Goal #${f.root.id} “Native Autonomy”, Lv 2 Continue`));assert.match(reason,new RegExp(`Goal #${other.id} “Second Root”, Lv 3 Drive: Drive the whole project under Root #${other.id}`));
 assert.equal(await f.read(),null);assert.equal((await readMonitor(other.id)).attempts.length,1,'the highest level\'s Root keeps the attempt');
 assert.equal(await f.stop(),null,'once per revision');assert.equal((await readMonitor(other.id)).attempts[0].phase,'completed');
});
test('the conversation\'s Goals are the ones its work was handed or last worked in; others in the Root do not count',async t=>{
 const f=await fixture(t);const side=await createGoal({title:'Side',parentId:f.root.id}),work=await createGoal({title:'Work',parentId:f.root.id});
 await setGoalAutonomy(side.id,2);
 assert.equal(await f.stop(),null,'the Root itself is the focus, and it is at 1');
 await recordClaudeWork(f.sessionId,[{type:'started'},{type:'commented',goalId:work.id}]);
 assert.equal(await f.stop(),null,'the Goal it last worked in is at 1');
 await setGoalAutonomy(work.id,2);await f.newPrompt();await recordClaudeWork(f.sessionId,[{type:'commented',goalId:work.id}]);
 const {reason}=await f.stop();assert.match(reason,new RegExp(`Goal #${work.id} “Work”, Lv 2 Continue`));assert.doesNotMatch(reason,new RegExp(`Goal #${side.id} `));
});
test('Drive covers the whole Root tree and leaves out Goals another live conversation works on',async t=>{
 const f=await fixture(t);const a=await createGoal({title:'Part A',parentId:f.root.id}),b=await createGoal({title:'Part B',parentId:f.root.id}),done=await createGoal({title:'Shipped',parentId:f.root.id});
 await updateGoal(done.id,{state:'done'});await f.configure(3);
 // Another conversation in the project is working on Part B right now.
 const otherSession=randomUUID(),other=hookFor({session_id:otherSession,prompt_id:randomUUID(),cwd:f.cwd});
 await captureClaudeEntry(other('SessionStart',{source:'startup'}),{cwd:f.cwd,env:{CLAUDE_ENV_FILE:join(f.dir,'env')}});
 await recordClaudeWork(otherSession,[{type:'started'},{type:'handed',goals:[b.id]}]);
 const {reason}=await f.stop();
 assert.match(reason,new RegExp(`Unfinished in that tree: #${f.root.id} “Native Autonomy”, #${a.id} “Part A”\\.`));
 assert.match(reason,new RegExp(`Taken by other live conversations, so leave them: #${b.id} “Part B”`));
 assert.doesNotMatch(reason,/Shipped/);assert.match(reason,/Ask the user's decisions as Letters \(goal letter\)/);
});
test('feedback text adds nothing for Autonomy at any level',async t=>{
 const f=await fixture(t);
 for(const level of [1,2,3]){
  await f.configure(level);await appendFeedback({goalId:f.root.id,text:`Request at ${level}`});
  const text=(await f.action('inbox',{})).hookSpecificOutput.additionalContext;
  assert.match(text,new RegExp(`Request at ${level}`));assert.doesNotMatch(text,/Autonomy|Think in the user's place/);
 }
});
test('saved Web feedback and the end-of-turn check cannot both claim the same Stop',async t=>{
 // A Stop hands comments not handed yet before the check may ask for anything.
 await t.test('feedback first',async t=>{
  const f=await fixture(t);await f.configure();
  await appendFeedback({goalId:f.root.id,text:'Saved before the response ended'});
  assert.match((await f.stop()).reason,/Saved before the response ended/);assert.equal((await f.read())?.attempts.length??0,0);
 });
 await t.test('continuation first',async t=>{
  const f=await fixture(t);await f.configure();
  assert.equal((await f.stop()).decision,'block');
  const reply=await appendFeedback({goalId:f.root.id,text:'Input after continuation won'});
  assert.match((await f.stop()).reason,/Input after continuation won/,'the next stop hands it');
 });
});

test('a taken-over Root keeps its Autonomy; an unconfirmed request is closed, never resent',async t=>{
 const f=await fixture(t),earlier=(await readGoal(f.root.id)).connection;
 await f.configure();
 const offered=await f.stop();assert.equal(offered.decision,'block');const first=(await f.read()).attempts[0];
 const continued={harnessId:'claude-code',sessionId:randomUUID(),contextId:randomUUID()};
 await transferClaudeRoot(f.root.id,earlier,continued,randomUUID());
 const stop=connection=>onStop({connection,promptId:randomUUID(),checkpointId:randomUUID(),generation:randomUUID()});
 assert.equal(await stop(earlier),null,'the earlier conversation owns nothing now');
 // The owner is part of the revision: the new conversation gets one check of its own.
 const next=await stop(continued);assert.match(next,/Lv 2 Continue/);
 const state=await f.read();assert.deepEqual(state.connection,continued);
 assert.equal(state.history[0].id,first.id,'the closed request is kept as history');assert.equal(state.history[0].phase,'assignment-changed');
 assert.equal(state.attempts.length,1);assert.notEqual(state.attempts[0].id,first.id);
 assert.equal(await stop(continued),null,'awaiting this request, not another one');
 // A record from an owner this Root never had starts over and keeps its history.
 const journal=storage('continuation');
 await journal.write(f.root.id,{rootId:f.root.id,connection:{harnessId:'claude-code',sessionId:'other',contextId:randomUUID()},attempts:[{id:'foreign',at:new Date().toISOString()}]});
 await updateGoal(f.root.id,{scope:'Changed'});
 assert.match(await stop(continued),/Keep going/);
 const after=await journal.read(f.root.id);assert.deepEqual(after.connection,continued);assert.equal(after.history.at(-1).id,'foreign');
});

test('a stop is held while a handed Goal awaits a reply and nothing runs; the agent speaking on it lets it end',async t=>{
 const f=await fixture(t);
 await appendFeedback({goalId:f.root.id,text:'Short work'});
 const handed=(await f.action('inbox',{})).hookSpecificOutput.additionalContext;
 assert.match(handed,/Reply on the Goal \(this answers it\): .* connection reply --goal <goalId> --text '<reply>'/);
 // What the agent wrote is never posted for it: only a reply or Comment answers the Goal.
 const transcript=join(f.dir,'transcript.jsonl');
 await writeFile(transcript,JSON.stringify({type:'assistant',uuid:randomUUID(),message:{model:'claude',content:[{type:'text',text:'Done with the short work.'}]}})+'\n');
 const first=await f.stop({transcript_path:transcript,last_assistant_message:'Done with the short work.'});
 assert.deepEqual((await readFeedback()).filter(e=>e.author==='agent'),[],'nothing is posted at Stop');
 assert.equal(first?.decision,'block');assert.match(first.reason,new RegExp(`Goal #${f.root.id}\\b`));
 assert.match(first.reason,/connection reply --goal <goalId>/);assert.match(first.reason,/goal comment --id <goalId>/);
 assert.equal(await f.stop({stop_hook_active:true}),null,'the stop right after a hold ends');
 await f.newPrompt();
 assert.equal((await f.stop())?.decision,'block','a later stop with still nothing said is held again');
 await f.stop({stop_hook_active:true});
 await f.newPrompt();
 assert.equal(await f.stop({background_tasks:[{id:'a1',type:'subagent',status:'running',description:'Review'}]}),null,'running background work wakes the conversation later');
 const waiter={id:'b1',type:'shell',status:'running',description:'Desktop hold',command:"'/data/runtime/chill' connection wait"};
 assert.equal((await f.stop({background_tasks:[waiter]}))?.decision,'block','chill\'s own hold task is not work');
 await f.stop({stop_hook_active:true});
 await f.newPrompt();await appendAgentComment({goalId:f.root.id,type:'comment',text:'Waiting for CI; I will check in 10 minutes.'});
 assert.equal(await f.stop(),null,'a progress comment answers the Goal');
 await appendFeedback({goalId:f.root.id,text:'Long work'});
 assert.match((await f.stop()).reason,/Long work/,'a new comment is handed at the stop');
 assert.equal((await f.stop())?.decision,'block','and its Goal awaits a reply again');
 await f.action('reply',{goalId:f.root.id,text:'Done'});
 assert.equal(await f.stop(),null,'a reply on the Goal');
});
test('the request asks for one look back and names no command, so a turn with nothing left ends in one response',async t=>{
 const f=await fixture(t);await f.configure();
 const {reason}=await f.stop();
 assert.match(reason,/do once what each level asks/);assert.match(reason,/Run no commands and write no turn summary/);
 assert.match(reason,/carry it out now and report the results in a Comment on its Goal\./);
 assert.doesNotMatch(reason,/monitor result|goal review|goal tree|goal show|```/);
 assert.match(reason,/There (is|are) \d+ unfinished Goals?|Every Goal is marked Done/);
});
test('chill records the result at the next Stop: worked when the agent left something on the Web, otherwise no-work',async t=>{
 const quiet=await fixture(t);await quiet.configure();await quiet.stop();
 assert.equal(await quiet.stop(),null);
 const quietResult=(await quiet.read()).attempts[0].result;assert.equal(quietResult.outcome,'no-work');assert.equal(quietResult.observed,true);
 const busy=await fixture(t);await busy.configure();await busy.stop();
 await busy.newPrompt();await appendAgentComment({goalId:busy.root.id,type:'comment',text:'Finished the remaining step; tests pass.'});
 assert.equal(await busy.stop(),null);
 const attempt=(await busy.read()).attempts[0];assert.equal(attempt.result.outcome,'worked');assert.equal(attempt.phase,'completed');
 await assert.rejects(busy.action('extension',{extension:'continuation',operation:'result',input:{rootId:busy.root.id,attemptId:attempt.id,outcome:'no-work'}}),/unavailable/,'there is nothing to report');
});
