import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {captureClaudeEntry} from '../lib/claude-entry.mjs';
import {recordClaudeWork,reportClaudeHook} from '../lib/claude-agent-work.mjs';
import {runClaudeAction,handleClaudeToolHook} from '../lib/claude-actions.mjs';
import {initializeStore,createGoal,listGoals,appendFeedback,readGoal,updateGoal} from '../lib/goal-store.mjs';
import {createClaudeRoot} from '../lib/claude-roots.mjs';
import {assignGoal} from '../lib/agents/codex-execution.mjs';
import {deliverFeedback,readDeliveryState,sendFeedbackNow} from '../lib/delivery.mjs';
import {readAgentStatus} from '../lib/agent-status.mjs';
import {needsWorkRefresh} from '../lib/agents/codex-work-output.mjs';
import {agentMarkup} from '../public/agent-menu.js';
import {fileURLToPath} from 'node:url';
import {claudeEntry,claudeHook,claudeLine,claudeLines,hookFor} from './claude-fixtures.mjs';

async function fixture(t) {
  const dir=await mkdtemp(join(tmpdir(),'chill-claude-actions-'));
  const previous={data:process.env.CHILL_AGENT_DATA_DIR,codex:process.env.CHILL_AGENT_CODEX_PATH};
  process.env.CHILL_AGENT_DATA_DIR=join(dir,'data');process.env.CHILL_AGENT_CODEX_PATH='/never/call/codex';
  t.after(async()=>{for(const [key,value] of [['CHILL_AGENT_DATA_DIR',previous.data],['CHILL_AGENT_CODEX_PATH',previous.codex]]){if(value===undefined)delete process.env[key];else process.env[key]=value;}await rm(dir,{recursive:true,force:true});});
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
  assert.deepEqual(status.capabilities,{settings:false,stop:false,resume:false,approveAll:true});
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
  await assert.rejects(updateGoal(first.id,{parentId:other.id}),/reassigned/);
  await assert.rejects(updateGoal(child.id,{parentId:other.id}),/between native/);
});

test('two Roots and a child hand their comments to the same conversation, and only a reply answers them',async t=>{
  const f=await fixture(t),s=await f.start(),g=await root(s),g2=await root(s),child=await createGoal({title:'Child',parentId:g.id});
  const e1=await appendFeedback({goalId:child.id,text:'first'}),e2=await appendFeedback({goalId:g2.id,text:'second'});
  assert.deepEqual(e1.connection,g.connection);
  assert.equal((await deliverFeedback(e1.changeId)).status,'saved');
  assert.equal(await readDeliveryState(e1.changeId),null,'no per-comment record is kept');
  const output=await s.act('inbox');
  assert.match(output,/first/);assert.match(output,/second/);
  assert.equal((await deliverFeedback(e1.changeId)).status,'received');
  assert.match(await s.act('inbox'),/first/,'what still awaits a reply is listed again');
  assert.match(await s.act('reply',{goalId:child.id,text:'Done'}),/Replied on Goal/);
  const again=await s.act('inbox');
  assert.doesNotMatch(again,/"text":"first"/);assert.match(again,/second/);
  assert.equal((await deliverFeedback(e1.changeId)).status,'completed');
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

test('a hold on the Goal path keeps comments from being handed until it is lifted',async t=>{
  const f=await fixture(t),s=await f.start(),g=await root(s);
  await appendFeedback({goalId:g.id,text:'held fixture'});
  const holds=join(process.env.CHILL_AGENT_DATA_DIR,'workspace/feedback-holds');await mkdir(holds);
  await writeFile(join(holds,`${g.id}.json`),JSON.stringify({goalId:g.id,phase:'paused'}));
  assert.doesNotMatch(await s.act('inbox'),/held fixture/);
  await rm(join(holds,`${g.id}.json`));
  assert.match(await s.act('inbox'),/held fixture/);
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
  assert.equal(reply.stdout.trim(),'1');assert.equal((await deliverFeedback(event.changeId)).status,'completed');
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
  const first=await appendFeedback({goalId:child.id,text:'child feedback'}),other=await appendFeedback({goalId:second.id,text:'other root feedback'});
  await reportClaudeHook(f.s.event('UserPromptSubmit'));
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

test('a Claude conversation keeps no receipts; its reply answers the Goal',async t=>{
  const f=await fixture(t),s=await f.start(),goal=await root(s);
  const event=await appendFeedback({goalId:goal.id,text:'Longer work'});
  const {recordActivity}=await import('../lib/delivery.mjs');
  await assert.rejects(recordActivity(event.changeId,'working',s.env),/keeps no receipts/);
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
  const {agentFor,deliveriesWithWork}=await import('../lib/agents/index.mjs');
  const presence=async()=>agentFor((await listGoals()).find(g=>g.id===goal.id)).presence();
  const event=await appendFeedback({goalId:goal.id,text:'Run the long test'});
  await reportClaudeHook(s.event('UserPromptSubmit'));
  await s.act('inbox',{});
  await s.act('reply',{goalId:goal.id,text:'Started the test; I will report the result.'});
  // Claude Code lists the background agent when the response stops.
  await handleClaudeToolHook(s.event('Stop',{background_tasks:[{id:'a1b2c3',type:'subagent',status:'running',agent_type:'general-purpose'},{id:'b1',type:'shell',status:'running',command:'npm run dev'}]}));
  assert.equal((await presence()).status,'working');assert.equal((await presence()).goalId,goal.id);
  assert.equal((await deliveriesWithWork(goal.id)).find(d=>d.eventId===event.changeId).status,'completed','the reply answered it');
  // It reports back: a new response that stops with nothing left in the background.
  await reportClaudeHook(s.event('UserPromptSubmit'));
  await handleClaudeToolHook(s.event('Stop',{background_tasks:[{id:'b1',type:'shell',status:'running',command:'npm run dev'}]}));
  assert.equal((await presence()).status,'idle','a background shell such as a dev server is not counted');
});

test('Claude feedback saved while a response runs waits for its end unless the user sends it now',async t=>{
  const f=await fixture(t),s=await f.start(),goal=await root(s);
  const {deliveriesWithWork}=await import('../lib/agents/index.mjs');
  const shown=async id=>(await deliveriesWithWork(goal.id)).find(d=>d.eventId===id)?.status;
  await reportClaudeHook(s.event('UserPromptSubmit'));
  const first=await appendFeedback({goalId:goal.id,text:'One more thing'});await deliverFeedback(first.changeId);
  assert.equal(await shown(first.changeId),'waiting');
  assert.equal(await handleClaudeToolHook(s.hook()),null,'a running response is not interrupted');
  // The response ends: Stop hands the waiting feedback over as the next message.
  const stop=await handleClaudeToolHook(s.event('Stop'));
  assert.equal(stop.decision,'block');assert.match(stop.reason,/One more thing/);
  assert.equal(await shown(first.changeId),'working','handed to the work Stop continues');
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
  const {readAgentStatus,controlAgent,readAgentActivityRow}=await import('../lib/agent-status.mjs');
  const {agentFor,callerOwns,selectAgentWork}=await import('../lib/agents/index.mjs');
  const {hasSavedClaudeFeedback}=await import('../lib/claude-actions.mjs');
  const {claudePermissionDecision}=await import('../lib/claude-permissions.mjs');
  const connection=s=>({harnessId:'claude-code',sessionId:s.record.sessionId,contextId:s.record.contextId});
  const forA=await appendFeedback({goalId:rootA.id,text:'For A'}),forB=await appendFeedback({goalId:rootB.id,text:'For B'});
  for(const event of [forA,forB])await deliverFeedback(event.changeId);
  // Each conversation's waiter and inbox see only its own Root's feedback.
  assert.equal(await hasSavedClaudeFeedback(connection(a)),true);assert.equal(await hasSavedClaudeFeedback(connection(b)),true);
  const inboxA=await a.act('inbox',{});
  assert.match(inboxA,/For A/);assert.doesNotMatch(inboxA,/For B/);
  assert.equal(await hasSavedClaudeFeedback(connection(b)),true,'A reading its inbox leaves B\'s feedback waiting');
  const inboxB=await b.act('inbox',{});
  assert.match(inboxB,/For B/);assert.doesNotMatch(inboxB,/For A/);
  // A cannot answer B's Goal.
  await assert.rejects(a.act('reply',{goalId:rootB.id,text:'Not mine'}),/another conversation/);
  assert.notEqual((await deliverFeedback(forB.changeId)).status,'completed');
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
  const ask=s=>claudePermissionDecision(s.event('PermissionRequest'));
  assert.equal(await ask(b),null,'B still asks for its own permissions');
  assert.equal((await readAgentStatus(rootB.id)).approveAll,false);
});

test('one reply answers the Goal, whichever of its comments it answers',async t=>{
  const f=await fixture(t),s=await f.start(),goal=await root(s);
  const first=await appendFeedback({goalId:goal.id,text:'Please flip it'}),second=await appendFeedback({goalId:goal.id,text:'Actually also the data'});
  await s.act('inbox',{});
  const output=await s.act('reply',{goalId:goal.id,text:'Done both'});
  for(const event of [first,second])assert.equal((await deliverFeedback(event.changeId)).status,'completed');
  const {readEvent}=await import('../lib/goal-store.mjs');
  const commentId=Number(/comment #(\d+)/.exec(output)[1]);
  assert.equal((await readEvent(commentId)).text,'Done both');assert.equal(await readEvent(commentId+1),null,'the reply is posted once');
});
