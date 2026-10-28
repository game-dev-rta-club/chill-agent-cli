import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {captureClaudeEntry} from '../lib/claude-entry.mjs';
import {recordClaudeWork,reportClaudeHook} from '../lib/claude-agent-work.mjs';
import {runClaudeAction,handleClaudeToolHook,claimClaudeFeedbackForWatcher} from '../lib/claude-actions.mjs';
import {createGoal,listGoals,appendFeedback,readGoal,updateGoal} from '../lib/goal-store.mjs';
import {createClaudeRoot} from '../lib/claude-roots.mjs';
import {assignGoal} from '../lib/agents/codex-execution.mjs';
import {deliverFeedback,sendFeedbackNow} from '../lib/delivery.mjs';
import {readAgentStatus} from '../lib/agent-status.mjs';
import {goalCommentMarks} from '../lib/agents/index.mjs';
import {agentMarkup} from '../public/agent-menu.js';
import {fileURLToPath} from 'node:url';
import {claudeHook,hookFor} from './claude-fixtures.mjs';

async function fixture(t) {
  const dir=await mkdtemp(join(tmpdir(),'chill-claude-actions-'));
  const previous={data:process.env.CHILL_AGENT_DATA_DIR,codex:process.env.CHILL_AGENT_CODEX_PATH};
  process.env.CHILL_AGENT_DATA_DIR=join(dir,'data');process.env.CHILL_AGENT_CODEX_PATH='/never/call/codex';
  t.after(async()=>{for(const [key,value] of [['CHILL_AGENT_DATA_DIR',previous.data],['CHILL_AGENT_CODEX_PATH',previous.codex]]){if(value===undefined)delete process.env[key];else process.env[key]=value;}await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  const cwd=join(dir,'project');await mkdir(cwd);
  async function start(sessionId='native/session',source='startup') {
    const envFile=join(dir,randomUUID());await writeFile(envFile,'');
    const record=await captureClaudeEntry(claudeHook('SessionStart',{session_id:sessionId,source,cwd}), {cwd,env:{CLAUDE_ENV_FILE:envFile}});
    const env={CHILL_AGENT_HARNESS:record.harnessId,CHILL_AGENT_SESSION_ID:sessionId,CLAUDE_CODE_SESSION_ID:sessionId};
    const act=async(action,payload,options={})=>(await runClaudeAction(action,payload,{env,...options})).text;
    const event=hookFor({session_id:sessionId,cwd}),hook=patch=>event('PostToolUse',patch);
    return {record,env,envFile,act,event,hook};
  }
  return {dir,cwd,start};
}
const goalInput={title:'A useful outcome',scope:'Fixture only',criteria:'Roundtrip confirmed'};
async function root(s) {await s.act('create-goal',goalInput);return (await listGoals()).at(-1);}
const context=output=>output?.hookSpecificOutput?.additionalContext;

test('connection extension actions run at once in the calling conversation',async t=>{
  const f=await fixture(t),s=await f.start();let calls=0;
  const payload={extension:'sample',operation:'configure',input:{enabled:true}};
  const extensions=async()=>({sample:{confirmAction:async input=>{calls++;assert.equal(input.connection.sessionId,s.record.sessionId);return {result:{enabled:true},context:'Applied in this conversation.'};}}});
  assert.match(await s.act('extension',payload,{extensions}),/Applied/);assert.equal(calls,1);
  await assert.rejects(s.act('extension',payload,{extensions:async()=>({})}),/unavailable/);
  await assert.rejects(s.act('extension',{...payload,input:[]}),/Invalid connection extension/);
  // A large payload is the extension's own business.
  assert.match(await s.act('extension',{...payload,input:{large:'x'.repeat(100000)}},{extensions}),/Applied/);
});

test('create-goal binds a Root to the calling conversation at once',async t=>{
  const f=await fixture(t),s=await f.start();
  assert.match(await s.act('create-goal',goalInput),/Created Goal #1/);
  const g=(await listGoals())[0];assert.equal(g.threadId,null);assert.deepEqual(g.connection,{harnessId:'claude-code',sessionId:s.record.sessionId,contextId:s.record.contextId});
  const status=await readAgentStatus(g.id);assert.equal(status.connected,true);assert.equal(status.agent.name,'Claude Code');
  assert.deepEqual(status.capabilities,{settings:false,stop:false,resume:false});
  assert.match(agentMarkup(status),/Claude Code/);assert.doesNotMatch(agentMarkup(status),/Codex account|data-agent-settings/);
  await assert.rejects(s.act('create-goal',{...goalInput,title:' '}),/Invalid title/);
});

test('a command acts for the current context: clear starts a context that owns nothing',async t=>{
  const f=await fixture(t),first=await f.start();await first.act('create-goal',goalInput);
  const resumed=await f.start(first.record.sessionId,'resume');assert.equal(resumed.record.contextId,first.record.contextId);
  const cleared=await f.start(first.record.sessionId,'clear');assert.notEqual(cleared.record.contextId,first.record.contextId);
  await first.act('create-goal',goalInput);
  const [a,b]=await listGoals();
  assert.equal(a.connection.contextId,first.record.contextId);assert.equal(b.connection.contextId,cleared.record.contextId);
  await assert.rejects(runClaudeAction('inbox',{},{env:{CHILL_AGENT_HARNESS:'claude-code',CHILL_AGENT_SESSION_ID:'never-started'}}),/not connected/);
});

test('Root creation stays single when retried with the same ID',async t=>{
  const f=await fixture(t),s=await f.start(),id=randomUUID();
  const connection={harnessId:'claude-code',sessionId:s.record.sessionId,contextId:s.record.contextId};
  const first=await createClaudeRoot(goalInput,connection,id);
  await rm(join(process.env.CHILL_AGENT_DATA_DIR,'workspace/goals',first.id,'deliverable.html'));
  await createClaudeRoot(goalInput,connection,id);
  assert.equal((await listGoals()).length,1);assert.equal(await readFile(join(process.env.CHILL_AGENT_DATA_DIR,'workspace/goals/1/deliverable.html'),'utf8'),'');
  await assert.rejects(createClaudeRoot({...goalInput,title:'changed'},connection,id),/changed/);
  await assert.rejects(updateGoal(first.id,{threadId:randomUUID()}),/reassigned/);
  await assert.rejects(assignGoal(first.id,null),/Reassignment/);
  const other=await createGoal({title:'Other'}),child=await createGoal({title:'Child',parentId:first.id});
  await updateGoal(child.id,{parentId:other.id});
  await updateGoal(first.id,{parentId:other.id});
  assert.equal((await readGoal(first.id)).connection,undefined,'a Root moved under another Goal follows that Root');
});

test('two Roots and a child hand their comments to the same conversation, and only a reply answers them',async t=>{
  const f=await fixture(t),s=await f.start(),g=await root(s),g2=await root(s),child=await createGoal({title:'Child',parentId:g.id});
  const e1=await appendFeedback({goalId:child.id,text:'first'}),e2=await appendFeedback({goalId:g2.id,text:'second'});
  assert.deepEqual(e1.connection,g.connection);
  assert.equal((await deliverFeedback(e1.changeId)).mark,'saved');
  const output=await s.act('inbox');
  assert.match(output,/first/);assert.match(output,/second/);
  assert.equal((await deliverFeedback(e1.changeId)).mark,'handed');
  const listedAgain=await s.act('inbox');
  assert.match(listedAgain,/Handed to you earlier and still awaiting your reply:\n[^]*first/,'what still awaits a reply is listed again, apart from new feedback');
  assert.match(await s.act('reply',{goalId:child.id,text:'Done'}),/Replied on Goal/);
  const again=await s.act('inbox');
  assert.doesNotMatch(again,/"text":"first"/);assert.match(again,/second/);
  assert.equal((await deliverFeedback(e1.changeId)).mark,null);
  assert.equal((await readGoal(g.id)).state,'idle');
  await assert.rejects(s.act('reply',{goalId:g.id,text:' '}),/Invalid reply/);
  await assert.rejects(s.act('reply',{text:'no Goal'}),/--goal/);
});

test('separate, resumed and cleared contexts cannot take or answer another conversation\'s comments',async t=>{
  const f=await fixture(t),s=await f.start(),g=await root(s),other=await f.start('other');
  await appendFeedback({goalId:g.id,text:'private fixture'});
  assert.doesNotMatch(await other.act('inbox'),/private fixture/);
  await assert.rejects(other.act('reply',{goalId:g.id,text:'Not mine'}),/another conversation/);
  const resumed=await f.start(s.record.sessionId,'resume');assert.match(await resumed.act('inbox'),/private fixture/);
  const clear=await f.start(s.record.sessionId,'clear');assert.doesNotMatch(await clear.act('inbox'),/private fixture/);
  await assert.rejects(clear.act('reply',{goalId:g.id,text:'Not mine'}),/another conversation/);
});

test('the connection CLI acts at once and prints its result; piping the output changes nothing',{skip:process.platform==='win32'&&'runs through POSIX /bin/sh'},async t=>{
  const f=await fixture(t),s=await f.start();
  const execute=promisify(execFile),entry=fileURLToPath(new URL('../bin/chill-connection.mjs',import.meta.url));
  const {stdout,stderr}=await execute('/bin/sh',['-c','"$1" "$2" create-goal --title "CLI outcome" | head -1','probe',process.execPath,entry],{cwd:f.cwd,env:{...process.env,...s.env}});
  assert.equal(stderr,'');assert.match(stdout,/^Created Goal #1/);assert.equal((await listGoals()).length,1);
  // Sent now, so the running work's tool hook hands it over.
  const event=await appendFeedback({goalId:'1',text:'CLI feedback'});await sendFeedbackNow(event.changeId);
  const path=join(f.dir,'hook.json');await writeFile(path,JSON.stringify(s.hook({agent_id:'child'})));
  const run=()=>execute('/bin/sh',['-c','exec "$1" "$2" claude-hook < "$3"','probe',process.execPath,entry,path],{cwd:f.cwd,env:process.env});
  assert.equal((await run()).stdout,'','a subagent hook never receives Web input');
  // A hook input of any size is read; a large tool result never stops delivery.
  await writeFile(path,JSON.stringify(s.hook({tool_name:'mcp__screenshot',tool_response:{image:'x'.repeat(2_000_000)}})));
  assert.match(context(JSON.parse((await run()).stdout)),/CLI feedback/);
  const reply=await execute('/bin/sh',['-c','"$1" "$2" reply --goal 1 --text done | grep -c Replied','probe',process.execPath,entry],{cwd:f.cwd,env:{...process.env,...s.env}});
  assert.equal(reply.stdout.trim(),'1');assert.equal((await deliverFeedback(event.changeId)).mark,null);
});

async function automaticFixture(t) {
  const f=await fixture(t),s=await f.start();
  const handle=input=>handleClaudeToolHook(input);
  await s.act('create-goal',goalInput);
  return {...f,s,handle,call:patch=>s.hook(patch),goal:(await listGoals())[0]};
}

test('a tool hook hands what the user sent now, from every owned Goal, once; the rest waits for the stop',async t=>{
  const f=await automaticFixture(t),child=await createGoal({title:'Child',parentId:f.goal.id});
  await f.s.act('create-goal',goalInput);
  const second=(await listGoals()).at(-1);
  await reportClaudeHook(f.s.event('UserPromptSubmit'));await delay(5);
  const first=await appendFeedback({goalId:child.id,text:'child feedback'}),other=await appendFeedback({goalId:second.id,text:'other root feedback'});
  assert.equal(await f.handle(f.call()),null,'the running work is not interrupted');
  for(const event of [first,other])await sendFeedbackNow(event.changeId);
  const results=await Promise.all([f.handle(f.call({tool_name:'Read'})),f.handle(f.call())]);
  assert.equal(results.filter(Boolean).length,1);
  const text=context(results.find(Boolean));assert.match(text,/child feedback/);assert.match(text,/other root feedback/);
  assert.equal(await f.handle(f.call()),null,'a handed comment is never handed again automatically');
  await appendFeedback({goalId:f.goal.id,text:'arrived later'});
  assert.equal(await f.handle(f.call()),null);
  assert.match((await f.handle(f.s.event('Stop'))).reason,/arrived later/,'the end of the work hands what waited for it');
});

test('Send now hands the comments up to the one sent; a comment written after it waits for the stop',async t=>{
  const f=await automaticFixture(t);
  await reportClaudeHook(f.s.event('UserPromptSubmit'));await delay(5);
  const [a,b,c]=[await appendFeedback({goalId:f.goal.id,text:'before'}),await appendFeedback({goalId:f.goal.id,text:'sent now'}),await appendFeedback({goalId:f.goal.id,text:'after'})];
  const mark=await sendFeedbackNow(b.changeId);assert.deepEqual([mark.mark,mark.sendNow],['saved',true]);
  const marks=Object.fromEntries((await goalCommentMarks(f.goal.id)).map(m=>[m.eventId,m.mark]));
  assert.deepEqual([a,b,c].map(e=>marks[e.changeId]),['saved','saved','waiting']);
  const text=context(await f.handle(f.call()));
  assert.match(text,/before/);assert.match(text,/sent now/);assert.doesNotMatch(text,/"after"/);
  assert.match((await f.handle(f.s.event('Stop'))).reason,/"after"/);
});

test('a running parent Goal points to the Split Goal the work is in, without its Think or Pause',async t=>{
  const f=await automaticFixture(t),child=await createGoal({title:'Child work',parentId:f.goal.id});
  const {readGoalActivity}=await import('../lib/agent-status.mjs');
  await reportClaudeHook(f.s.event('UserPromptSubmit'));
  await appendFeedback({goalId:child.id,text:'work on the child'});await f.handle(f.s.event('Stop'));
  const [parent,own]=[await readGoalActivity(f.goal.id),await readGoalActivity(child.id)];
  assert.deepEqual([parent.status,parent.in,parent.work,parent.capabilities.stop],['running',child.id,null,false]);
  assert.deepEqual([own.status,own.in,own.capabilities.stop],['running',undefined,true]);
});

test('a comment saved before the work started is handed at its first tool hook, never shown Waiting',async t=>{
  const f=await automaticFixture(t),woke=await appendFeedback({goalId:f.goal.id,text:'wake up'});await delay(5);
  await reportClaudeHook(f.s.event('UserPromptSubmit'));await delay(5);
  const later=await appendFeedback({goalId:f.goal.id,text:'written while it works'});
  const marks=Object.fromEntries((await goalCommentMarks(f.goal.id)).map(m=>[m.eventId,m.mark]));
  assert.deepEqual([marks[woke.changeId],marks[later.changeId]],['saved','waiting']);
  const text=context(await f.handle(f.call()));assert.match(text,/wake up/);assert.doesNotMatch(text,/written while it works/);
});

test('automatic hand-offs skip subagents and interrupted tools, and never reach another owner\'s comments',async t=>{
  const f=await automaticFixture(t),e=await appendFeedback({goalId:f.goal.id,text:'pending native feedback'});
  const other=await f.start('different-session'),g=await root(other);await appendFeedback({goalId:g.id,text:'another owner'});
  await sendFeedbackNow(e.changeId);
  for(const input of [f.call({agent_id:'child'}),f.s.event('PreToolUse'),f.call({tool_response:{stdout:'',stderr:'',interrupted:true}})])assert.equal(await f.handle(input),null);
  const text=context(await f.handle(f.call({prompt_id:undefined})));assert.match(text,/pending native feedback/);assert.doesNotMatch(text,/another owner/);
});

test('compact keeps its Goals; clear starts a context that owns nothing',async t=>{
  const f=await automaticFixture(t);
  const {claimClaudeFeedbackForWatcher}=await import('../lib/claude-actions.mjs');
  await f.handle(f.s.event('Stop'));
  await appendFeedback({goalId:f.goal.id,text:'after stop'});
  assert.match(await claimClaudeFeedbackForWatcher(f.s.record.sessionId),/after stop/);
  await f.start(f.s.record.sessionId,'compact');
  await appendFeedback({goalId:f.goal.id,text:'after compact'});
  assert.match(await claimClaudeFeedbackForWatcher(f.s.record.sessionId),/after compact/);
  await f.start(f.s.record.sessionId,'clear');
  await appendFeedback({goalId:f.goal.id,text:'after clear'});
  assert.equal(await claimClaudeFeedbackForWatcher(f.s.record.sessionId),'');
});

test('Pause on a Claude Goal holds the conversation until Resume or a new comment',async t=>{
  const f=await fixture(t),s=await f.start(),goal=await root(s);
  const {readGoalActivity,controlAgent}=await import('../lib/agent-status.mjs');
  const {goalCommentMarks}=await import('../lib/agents/index.mjs');
  await reportClaudeHook(s.event('UserPromptSubmit'));
  const event=await appendFeedback({goalId:goal.id,text:'Later'});await deliverFeedback(event.changeId);
  assert.equal((await handleClaudeToolHook(s.event('Stop'))).decision,'block','the Stop hands it and the work goes on');
  const running=await readGoalActivity(goal.id);
  assert.equal(running.status,'running');assert.deepEqual(running.capabilities,{stop:true,resume:false});
  await assert.rejects(controlAgent(goal.id,{action:'stop',token:'other'}),/Agent changed/);
  await controlAgent(goal.id,{action:'stop',token:running.token});
  const paused=await readGoalActivity(goal.id);
  assert.equal(paused.status,'paused');assert.deepEqual(paused.capabilities,{stop:false,resume:true});
  assert.deepEqual((await goalCommentMarks(goal.id)).map(m=>m.mark),['paused']);
  assert.equal(await handleClaudeToolHook(s.event('Stop',{stop_hook_active:true})),null,'nothing continues it while paused');
  await controlAgent(goal.id,{action:'resume',token:running.token});
  assert.notEqual((await readGoalActivity(goal.id))?.status,'paused');
  assert.match(await claimClaudeFeedbackForWatcher(s.record.sessionId),/Resume/);
  // A comment written after Pause resumes the conversation and is handed, without Resume.
  await controlAgent(goal.id,{action:'stop',token:running.token});
  assert.equal((await readGoalActivity(goal.id)).status,'paused');
  const next=await appendFeedback({goalId:goal.id,text:'Go on with this'});await deliverFeedback(next.changeId);
  assert.notEqual((await readGoalActivity(goal.id))?.status,'paused');
  assert.match(await claimClaudeFeedbackForWatcher(s.record.sessionId),/Go on with this/);
});

test('goal work from a Claude conversation marks its Goal Running for the current response',async t=>{
  const f=await fixture(t),s=await f.start(),goal=await root(s);
  const {selectAgentWork,agentFor}=await import('../lib/agents/index.mjs');
  const {createGoal}=await import('../lib/goal-store.mjs');
  const child=await createGoal({title:'Child work',parentId:goal.id});
  await reportClaudeHook(s.event('UserPromptSubmit'));
  await assert.rejects(selectAgentWork(child.id,{env:{}}),/handshake|assigned chat/);
  const work=await selectAgentWork(child.id,{env:s.env});
  assert.equal(work.goalId,child.id);
  const presence=await agentFor((await listGoals()).find(g=>g.id===goal.id)).presence();
  assert.equal(presence.status,'working');assert.equal(presence.goalId,child.id);
  assert.equal((await readGoal(child.id)).started,true);
  await selectAgentWork(child.id,{stop:true,env:s.env});
  assert.equal((await agentFor((await listGoals()).find(g=>g.id===goal.id)).presence()).goalId,null);
  // The selection ends with the work that made it.
  await selectAgentWork(child.id,{env:s.env});
  assert.equal(await handleClaudeToolHook(s.event('Stop')),null);
  assert.equal((await agentFor((await listGoals()).find(g=>g.id===goal.id)).presence()).goalId,null);
  await reportClaudeHook(s.event('UserPromptSubmit'));
  assert.equal((await agentFor((await listGoals()).find(g=>g.id===goal.id)).presence()).goalId,null,'the next work does not inherit it');
});

test('a Claude reply that leaves a subagent working answers the Goal, which stays Running until the subagent ends',async t=>{
  const f=await fixture(t),s=await f.start(),goal=await root(s);
  const {agentFor,goalCommentMarks}=await import('../lib/agents/index.mjs');
  const presence=async()=>agentFor((await listGoals()).find(g=>g.id===goal.id)).presence();
  const event=await appendFeedback({goalId:goal.id,text:'Run the long test'});
  await reportClaudeHook(s.event('UserPromptSubmit'));
  await s.act('inbox',{});
  await s.act('reply',{goalId:goal.id,text:'Started the test; I will report the result.'});
  // Claude Code lists the background agent when the response stops.
  await handleClaudeToolHook(s.event('Stop',{background_tasks:[{id:'a1b2c3',type:'subagent',status:'running',agent_type:'general-purpose'},{id:'b1',type:'shell',status:'running',command:'npm run dev'}]}));
  assert.equal((await presence()).status,'working');assert.equal((await presence()).goalId,goal.id);
  const {readGoalActivity}=await import('../lib/agent-status.mjs');
  assert.deepEqual((await readGoalActivity(goal.id)).background?.map(task=>[task.type,task.name]),[['subagent','general-purpose']],'the Goal shows which task still runs');
  assert.equal((await goalCommentMarks(goal.id)).find(d=>d.eventId===event.changeId).mark,null,'the reply answered it');
  // It reports back: a new response that stops with nothing left in the background.
  await reportClaudeHook(s.event('UserPromptSubmit'));
  await handleClaudeToolHook(s.event('Stop',{background_tasks:[{id:'b1',type:'shell',status:'running',command:'npm run dev'}]}));
  assert.equal((await presence()).status,'idle','a background shell such as a dev server is not counted');
});

test('Claude feedback saved while a response runs waits for its end unless the user sends it now',async t=>{
  const f=await fixture(t),s=await f.start(),goal=await root(s);
  const {goalCommentMarks}=await import('../lib/agents/index.mjs');
  const shown=async id=>(await goalCommentMarks(goal.id)).find(d=>d.eventId===id)?.mark;
  await reportClaudeHook(s.event('UserPromptSubmit'));
  const first=await appendFeedback({goalId:goal.id,text:'One more thing'});await deliverFeedback(first.changeId);
  assert.equal(await shown(first.changeId),'waiting');
  assert.equal(await handleClaudeToolHook(s.hook()),null,'a running response is not interrupted');
  // The response ends: Stop hands the waiting feedback over as the next message.
  const stop=await handleClaudeToolHook(s.event('Stop'));
  assert.equal(stop.decision,'block');assert.match(stop.reason,/One more thing/);
  assert.equal(await shown(first.changeId),'handed','handed to the work Stop continues');
  // Send now hands the next one to the running response.
  const second=await appendFeedback({goalId:goal.id,text:'Urgent fix'});await deliverFeedback(second.changeId);
  assert.equal(await handleClaudeToolHook(s.hook()),null);
  await sendFeedbackNow(second.changeId);
  assert.match(context(await handleClaudeToolHook(s.hook())),/Urgent fix/);
  // Feedback saved while idle is handed at once.
  await recordClaudeWork(s.record.sessionId,[{type:'finished'}]);
  const idle=await appendFeedback({goalId:goal.id,text:'While idle'});
  assert.equal(await shown(idle.changeId),'saved');
});

test('two Claude conversations in one project, each with its own Root, never receive or control each other',async t=>{
  const f=await fixture(t),a=await f.start('session-a'),b=await f.start('session-b');
  const rootA=await root(a),rootB=await root(b);
  assert.notEqual(rootA.id,rootB.id);
  const {readAgentStatus,controlAgent}=await import('../lib/agent-status.mjs');
  const {agentFor,callerOwns,selectAgentWork}=await import('../lib/agents/index.mjs');
  const {hasSavedClaudeFeedback}=await import('../lib/claude-actions.mjs');
  const {claudePermissionDecision}=await import('../lib/claude-permissions.mjs');
  const connection=s=>({harnessId:'claude-code',sessionId:s.record.sessionId,contextId:s.record.contextId});
  const forA=await appendFeedback({goalId:rootA.id,text:'For A'}),forB=await appendFeedback({goalId:rootB.id,text:'For B'});
  for(const event of [forA,forB])await deliverFeedback(event.changeId);
  // Each conversation's watcher and inbox see only its own Root's feedback.
  assert.equal(await hasSavedClaudeFeedback(connection(a)),true);assert.equal(await hasSavedClaudeFeedback(connection(b)),true);
  const inboxA=await a.act('inbox',{});
  assert.match(inboxA,/For A/);assert.doesNotMatch(inboxA,/For B/);
  assert.equal(await hasSavedClaudeFeedback(connection(b)),true,'A reading its inbox leaves B\'s feedback waiting');
  const inboxB=await b.act('inbox',{});
  assert.match(inboxB,/For B/);assert.doesNotMatch(inboxB,/For A/);
  // A cannot answer B's Goal.
  await assert.rejects(a.act('reply',{goalId:rootB.id,text:'Not mine'}),/another conversation/);
  assert.notEqual((await deliverFeedback(forB.changeId)).mark,null);
  // Agent menu and caller identity are per Root.
  const [statusA,statusB]=await Promise.all([readAgentStatus(rootA.id),readAgentStatus(rootB.id)]);
  assert.notEqual(statusA.token,statusB.token);
  const rootOf=async id=>(await listGoals()).find(g=>g.id===id);
  assert.equal(await callerOwns(await rootOf(rootA.id),a.env),true);assert.equal(await callerOwns(await rootOf(rootA.id),b.env),false);
  assert.equal(await agentFor(await rootOf(rootB.id)).isCaller(a.env),false);
  // goal work from B on A's Goal is refused.
  await assert.rejects(selectAgentWork(rootA.id,{env:b.env}),/assigned chat/);
  // Pause and Autonomy on A leave B alone.
  const second=await appendFeedback({goalId:rootA.id,text:'A again'});await deliverFeedback(second.changeId);
  await reportClaudeHook(a.event('UserPromptSubmit'));
  await controlAgent(rootA.id,{action:'stop',token:statusA.token});
  assert.equal((await readAgentStatus(rootA.id)).capabilities.resume,true);
  assert.equal((await readAgentStatus(rootB.id)).capabilities.resume,false);
  const {setRootAutonomy}=await import('../lib/root-autonomy.mjs');
  await setRootAutonomy(rootA.id,3);
  const ask=s=>claudePermissionDecision(s.event('PermissionRequest'));
  assert.equal(await ask(b),null,'B still asks for its own permissions');
});

test('one reply answers the Goal, whichever of its comments it answers',async t=>{
  const f=await fixture(t),s=await f.start(),goal=await root(s);
  const first=await appendFeedback({goalId:goal.id,text:'Please flip it'}),second=await appendFeedback({goalId:goal.id,text:'Actually also the data'});
  await s.act('inbox',{});
  const output=await s.act('reply',{goalId:goal.id,text:'Done both'});
  for(const event of [first,second])assert.equal((await deliverFeedback(event.changeId)).mark,null);
  const {readEvent}=await import('../lib/goal-store.mjs');
  const commentId=Number(/comment (\d+)/.exec(output)[1]);
  assert.equal((await readEvent(commentId)).text,'Done both');assert.equal(await readEvent(commentId+1),null,'the reply is posted once');
});

test('a reply with --ask is a Letter: it answers the Goal\'s comments, also works with none, and the user\'s next comment closes it',async t=>{
  const f=await fixture(t),s=await f.start(),goal=await root(s);
  const {readEvent,readOpenLetters}=await import('../lib/goal-store.mjs');
  const comment=await appendFeedback({goalId:goal.id,text:'Should we drop the old export?'});
  await s.act('inbox',{});
  const output=await s.act('reply',{goalId:goal.id,ask:'Drop the old export?',text:'The new one covers it. Shall I remove the old one?'});
  assert.match(output,/^Replied on Goal #\d+ with a Letter \(comment \d+\)/);
  const letterId=Number(/comment (\d+)/.exec(output)[1]),letter=await readEvent(letterId);
  assert.equal(letter.type,'letter');assert.equal(letter.title,'Drop the old export?');assert.equal(letter.author,'agent');
  assert.equal((await deliverFeedback(comment.changeId)).mark,null,'the Letter is the reply to the arrived comment');
  assert.deepEqual((await readOpenLetters(goal.id)).map(l=>l.id),[letterId]);
  const unprompted=await s.act('reply',{goalId:goal.id,ask:'Rename the command?',text:'While here: shall I rename it?'});
  const second=Number(/comment (\d+)/.exec(unprompted)[1]);
  assert.deepEqual((await readOpenLetters(goal.id)).map(l=>l.id),[letterId,second],'a question found while working needs no comment');
  const answer=await appendFeedback({goalId:goal.id,text:'Yes to both.'});
  assert.deepEqual(await readOpenLetters(goal.id),[],'the user\'s comment closes the Goal\'s open Letters');
  assert.equal((await readEvent(letterId)).answeredBy,answer.changeId);
  await assert.rejects(s.act('reply',{goalId:goal.id,ask:' ',text:'x'}),/--ask/);
  await assert.rejects(s.act('reply',{goalId:goal.id,ask:'Two\nlines',text:'x'}),/one line/);
  const plain=await s.act('reply',{goalId:goal.id,text:'Removed it.'});
  assert.match(plain,/^Replied on Goal #\d+ \(comment \d+\)/);
  assert.equal((await readEvent(Number(/comment (\d+)/.exec(plain)[1]))).type,'comment','without --ask the reply is a Comment');
});

test('the Goal the agent writes on stays its work Goal, also across compaction, so the Web does not fall back to the Root',async t=>{
  const f=await fixture(t),s=await f.start(),g=await root(s);
  const asked=await createGoal({title:'Asked',parentId:g.id}),other=await createGoal({title:'Other',parentId:g.id}),letter=await createGoal({title:'Letter',parentId:g.id});
  const {claudeEntryPaths}=await import('../lib/claude-entry.mjs'),{readJson}=await import('../lib/storage.mjs'),{noteAgentComment}=await import('../lib/agents/index.mjs');
  const work=async()=>(await readJson(claudeEntryPaths(process.env.CHILL_AGENT_DATA_DIR,s.record.sessionId).record)).agentWork;
  await appendFeedback({goalId:asked.id,text:'Please look'});
  await s.act('inbox',{});
  assert.equal((await work()).lastGoal,asked.id);
  await s.act('reply',{goalId:other.id,text:'Answered here'});
  assert.equal((await work()).lastGoal,other.id,'a reply marks its Goal');
  await noteAgentComment(await readGoal(g.id),letter.id,s.env);
  assert.equal((await work()).lastGoal,letter.id,'a Letter or progress Comment marks its Goal');
  await noteAgentComment(await readGoal(g.id),asked.id,{CLAUDE_CODE_SESSION_ID:'someone-else'}).catch(()=>{});
  assert.equal((await work()).lastGoal,letter.id,'another conversation does not move it');
  await f.start(s.record.sessionId,'compact');
  const kept=await work();
  assert.equal(kept.lastGoal,letter.id,'compaction keeps it');assert.equal(kept.phase,'idle');
});
