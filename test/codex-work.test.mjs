// A Codex chat's hand-off by the shared rules (lib/agents/codex-work.mjs), against the fake Codex app.
// The user-visible flows are in test/harness-scenarios.test.mjs; this file covers what only Codex does.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {appendAgentComment,appendFeedback,createGoal,listGoals,readFeedback} from '../lib/goal-store.mjs';
import {agentExecutions,assignGoal} from '../lib/agents/index.mjs';
import {deliverFeedback,sendFeedbackNow} from '../lib/delivery.mjs';
import {codexFeedbackText,codexSnapshot,codexStop,codexToolHook,handIdleCodex,pauseCodex,readCodexWork,resumeCodex} from '../lib/agents/codex-work.mjs';
import {invalidateAgentObservation} from '../lib/agents/codex-observation.mjs';
import {hookOutput} from '../bin/chill-hook.mjs';
import {expectHidden} from './hidden-failures.mjs';
import {desktopChat} from './fake-codex-desktop.mjs';

const fake=fileURLToPath(new URL('./fake-codex.mjs',import.meta.url));
const test=(name,run)=>nodeTest(name,{skip:process.platform==='win32'&&'Codex Desktop harness is macOS-only; fake-codex.mjs runs as an executable'},run);
const ids=text=>[...text.matchAll(/"eventId":(\d+),"goalId"/g)].map(m=>Number(m[1]));
async function fixture(t) {
  const dir=await mkdtemp(join(tmpdir(),'chill-codex-work-')),previous={};
  for(const [key,value] of Object.entries({CHILL_AGENT_DATA_DIR:dir,CHILL_AGENT_CODEX_PATH:fake})){previous[key]=process.env[key];process.env[key]=value;}
  t.after(async()=>{for(const [key,value] of Object.entries(previous))value===undefined?delete process.env[key]:process.env[key]=value;await rm(dir,{recursive:true,force:true});});
  const thread=randomUUID(),chat=await desktopChat(dir,thread,()=>invalidateAgentObservation(thread),{codexHome:process.env.CODEX_HOME});
  t.after(chat.close);
  const root=await createGoal({title:'Outcome'});await assignGoal(root.id,thread);
  return {dir,thread,root,...chat,
    // Chill knows a turn works from its tool hooks: Codex shows a second process no live turn as running.
    async tool(){const turn=(await chat.running()).id;await hookOutput({hook_event_name:'PostToolUse',session_id:thread,turn_id:turn},thread);return turn;},
    async work(){await chat.startTurn();return this.tool();},
    save:async text=>{const event=await appendFeedback({goalId:root.id,text});await deliverFeedback(event.changeId);return event.changeId;}};
}

test('an idle chat is sent waiting comments as one message, quoting the user as data with the commands to answer',async t=>{
  const f=await fixture(t),child=await createGoal({title:'Child',parentId:f.root.id});
  const first=await f.save('Please start');
  const [text]=await f.sent();
  assert.deepEqual(ids(text),[first]);
  assert.deepEqual(await f.queue(),[],'Codex runs it as a turn at once');
  assert.match(text,/"text":"Please start"/);assert.match(text,new RegExp(`show --id ${f.root.id} --since ${first-1} --format text`));
  assert.match(text,/comment --id <goalId> --text/);assert.doesNotMatch(text,/activity --event|--state/);
  await f.endTurn();
  const letter=await appendAgentComment({goalId:child.id,type:'letter',title:'Which one?',text:'A or B?'});
  await appendAgentComment({goalId:child.id,type:'letter',title:'Still open?',text:'And this?'});
  const second=await appendFeedback({goalId:child.id,text:'And the child',annotations:[{kind:'letter',source:{kind:'comment',eventId:letter.changeId},text:'A'}]});await deliverFeedback(second.changeId);
  const sent=await f.sent();
  assert.equal(JSON.parse(sent[1].split('\n')[2])[0].notes[0].source.eventId,letter.changeId,'notes keep their source');
  assert.match(sent[1],/Open Letters[\s\S]*Letter \d+ \(\d+\) "Still open\?"/);
  assert.deepEqual(sent.map(ids),[[first],[second.changeId]]);
  await f.endTurn();
  assert.equal((await handIdleCodex(f.thread)).length,0,'nothing is sent twice');
});

test('a dozen waiting comments go to an idle chat in one message, none dropped',async t=>{
  const f=await fixture(t),saved=[];await f.work();
  for(let n=1;n<=12;n++)saved.push(await f.save(`Comment ${n}`));
  await f.endTurn();
  assert.deepEqual((await handIdleCodex(f.thread)).map(e=>e.id),saved);
  assert.deepEqual((await f.sent()).map(ids),[saved]);
});

test('a chat Codex cannot read keeps the comment saved, and a later hand-off sends it',async t=>{
  const f=await fixture(t),history=await readFile(join(f.dir,'fake-history.json'),'utf8');
  await writeFile(join(f.dir,'fake-history.json'),JSON.stringify({fail:true}));invalidateAgentObservation(f.thread);
  expectHidden(t,'codex-work.observe');
  const event=await appendFeedback({goalId:f.root.id,text:'Later'});
  assert.equal((await deliverFeedback(event.changeId)).mark,'saved');
  assert.deepEqual(await f.queue(),[]);
  await writeFile(join(f.dir,'fake-history.json'),history);
  assert.deepEqual((await handIdleCodex(f.thread)).map(e=>e.id),[event.changeId]);
});

test('a lost answer to an accepted message is checked against the turns and the Codex Queue, never sent twice',async t=>{
  const f=await fixture(t);
  t.after(()=>{delete process.env.CHILL_TEST_DROP_AFTER_ADD;});
  const lose=async text=>{process.env.CHILL_TEST_DROP_AFTER_ADD='1';const event=await appendFeedback({goalId:f.root.id,text});await deliverFeedback(event.changeId);delete process.env.CHILL_TEST_DROP_AFTER_ADD;return event.changeId;};
  const ran=await lose('Runs at once');
  assert.deepEqual((await f.sent()).map(ids),[[ran]]);assert.deepEqual(await f.queue(),[]);
  await f.endTurn();
  assert.deepEqual(await handIdleCodex(f.thread),[],'handed already, though it runs as a turn');
  // A turn the user started in Desktop, before its first tool: chill cannot tell it works, and Codex queues the message.
  await f.startTurn();
  const waits=await lose('Waits in the queue');
  assert.equal((await f.queue()).length,1);
  assert.deepEqual(await handIdleCodex(f.thread),[],'handed already, though it waits in the queue');
  assert.deepEqual((await f.sent()).map(ids),[[ran],[waits]]);
});

test('while the chat works, comments wait for its Stop; Send now hands them at the next tool hook, once',async t=>{
  const f=await fixture(t),turn=await f.work();
  const event=await f.save('After this');
  assert.deepEqual(await f.queue(),[],'never left in the Codex Queue');
  assert.equal(await codexToolHook({threadId:f.thread,turnId:turn}),null,'the running turn is not interrupted');
  await sendFeedbackNow(event);
  const hooks=await Promise.all([codexToolHook({threadId:f.thread,turnId:turn}),codexToolHook({threadId:f.thread,turnId:turn})]);
  assert.deepEqual(hooks.filter(Boolean).map(ids),[[event]],'parallel hooks hand it once');
  const later=await f.save('One more');
  const stop=await codexStop({threadId:f.thread,turnId:turn});
  assert.deepEqual(ids(stop.feedback),[later],'the Stop hands what waited and the turn goes on');
  assert.deepEqual((await readCodexWork(f.thread)).goals,[f.root.id]);
});

test('one turn handed comments on two Goals runs both, and a reply drops that Goal out',async t=>{
  const f=await fixture(t),a=await createGoal({title:'A',parentId:f.root.id}),b=await createGoal({title:'B',parentId:f.root.id});
  const turn=await f.work();
  await appendFeedback({goalId:a.id,text:'For A'});await appendFeedback({goalId:b.id,text:'For B'});
  await codexStop({threadId:f.thread,turnId:turn});
  const running=async()=>[...(await agentExecutions(await listGoals())).entries()].filter(([,e])=>e.status==='working').map(([id])=>id).sort();
  assert.deepEqual(await running(),[a.id,b.id]);
  await appendAgentComment({goalId:a.id,type:'comment',text:'A is done'});
  assert.deepEqual(await running(),[b.id]);
});

test('a hook text that is too long names the comments instead of quoting them',async t=>{
  const f=await fixture(t);
  const event=await appendFeedback({goalId:f.root.id,text:'x'.repeat(3000)});
  const [stored]=(await readFeedback()).filter(e=>e.id===event.changeId);
  const text=await codexFeedbackText([stored],{limit:2000});
  assert.deepEqual(ids(text),[event.changeId]);assert.doesNotMatch(text,/x{100}/);
});

test('hooks of a subagent or another chat hand nothing and leave the comments waiting',async t=>{
  const f=await fixture(t),turn=await f.work(),event=await f.save('Mine');await sendFeedbackNow(event);
  assert.equal(await hookOutput({hook_event_name:'PostToolUse',session_id:f.thread,turn_id:turn,agent_id:'child'},f.thread),null);
  assert.equal(await hookOutput({hook_event_name:'PostToolUse',session_id:f.thread,turn_id:turn},randomUUID()),null);
  assert.equal(await hookOutput({hook_event_name:'PostToolUse',session_id:randomUUID(),turn_id:turn},undefined),null,'another chat owns nothing here');
  const output=await hookOutput({hook_event_name:'PostToolUse',session_id:f.thread,turn_id:turn},f.thread);
  assert.deepEqual(ids(output.hookSpecificOutput.additionalContext),[event]);
});

test('the Stop is held once while a handed Goal awaits a reply, and a reply on it ends that',async t=>{
  const f=await fixture(t),event=await f.save('Fix it');
  const turn=await f.startTurn();
  const held=await hookOutput({hook_event_name:'Stop',session_id:f.thread,turn_id:turn},f.thread);
  assert.equal(held.decision,'block');assert.match(held.reason,new RegExp(`Goal #${f.root.id}\\b`));assert.match(held.reason,/comment --id <goalId>/);
  assert.equal(await hookOutput({hook_event_name:'Stop',session_id:f.thread,turn_id:turn},f.thread),null,'the stop right after a hold ends');
  await appendAgentComment({goalId:f.root.id,type:'comment',text:'Fixed'});
  assert.equal(await hookOutput({hook_event_name:'Stop',session_id:f.thread,turn_id:turn},f.thread),null);
  assert.equal((await codexSnapshot(f.thread)).roots[0].awaiting.size,0,`#${event} is answered`);
});

test('Pause stops the turn and holds comments; Resume sends them, or asks the chat to go on',async t=>{
  const f=await fixture(t),turn=await f.work(),calls=[];
  const interrupt=async(threadId,turnId)=>{calls.push(turnId);await f.endTurn('interrupted');return {ok:true,interruptedTurnId:turnId};};
  await pauseCodex(f.thread,turn,{interrupt});
  assert.deepEqual(calls,[turn]);assert.equal((await codexSnapshot(f.thread,{fresh:true})).status,'paused');
  const event=await f.save('While paused');
  assert.deepEqual(await f.sent(),[],'held until Resume');
  assert.equal(await codexStop({threadId:f.thread,turnId:turn}),null,'a paused chat is handed nothing and not held');
  await resumeCodex(f.thread);
  assert.deepEqual((await f.sent()).map(ids),[[event]]);
  await f.endTurn();
  await f.work();await pauseCodex(f.thread,(await codexSnapshot(f.thread,{fresh:true})).work.id,{interrupt});
  await resumeCodex(f.thread);
  assert.match((await f.running()).items[0].content[0].text,/continue the stopped work/);
  await assert.rejects(resumeCodex(f.thread),/Nothing to resume/);
});

test('a reassigned Root keeps its cursor: the new chat receives only what was never handed',async t=>{
  const f=await fixture(t),handed=await f.save('Handed before');
  await f.tool();const waiting=await f.save('Waits for the turn');await f.endTurn();
  const next=randomUUID();await assignGoal(f.root.id,next);
  invalidateAgentObservation(next);
  assert.deepEqual((await handIdleCodex(next)).map(e=>e.id),[waiting]);
  assert.notEqual(handed,waiting);
});

// The final reply of a turn answers the one Goal awaiting a reply (hand-off postFinalReply), as Claude's Stop does (test/final-reply.test.mjs).
test('the final reply answers the one Goal awaiting a reply, once; with two, the hold asks per Goal',async t=>{
  const f=await fixture(t),event=await f.save('Fix it'),turn=(await f.running()).id;
  const stop=(text,patch={})=>hookOutput({hook_event_name:'Stop',session_id:f.thread,turn_id:turn,last_assistant_message:text,...patch},f.thread);
  const replies=async()=>(await readFeedback()).filter(e=>e.author==='agent').map(e=>[e.goalId,e.text]);
  assert.equal(await stop('Fixed it.'),null,'answered, so the stop is not held');
  assert.deepEqual(await replies(),[[f.root.id,'Fixed it.']]);
  assert.equal((await readFeedback()).find(e=>e.author==='agent').answers,event);
  assert.equal(await stop('Fixed it.'),null);assert.deepEqual(await replies(),[[f.root.id,'Fixed it.']],'a repeated Stop posts nothing more');
  await f.endTurn();
  const a=await createGoal({title:'A',parentId:f.root.id}),b=await createGoal({title:'B',parentId:f.root.id});
  const next=await f.work();await appendFeedback({goalId:a.id,text:'For A'});await appendFeedback({goalId:b.id,text:'For B'});
  assert.match((await hookOutput({hook_event_name:'Stop',session_id:f.thread,turn_id:next,last_assistant_message:'Done.'},f.thread)).reason,/For A/);
  const held=await hookOutput({hook_event_name:'Stop',session_id:f.thread,turn_id:next,last_assistant_message:'Both done.'},f.thread);
  assert.match(held.reason,new RegExp(`Goal #${a.id}, Goal #${b.id}\\b`));assert.match(held.reason,/comment --id <goalId>/);
  assert.deepEqual(await replies(),[[f.root.id,'Fixed it.']]);
});

// Only Goals handed comments in this turn take its final reply; one left awaiting by an earlier turn is asked for by the hold.
test('with one Goal handed this turn and one left by an earlier turn, only this turn\'s Goal takes the final reply',async t=>{
  const f=await fixture(t),a=await createGoal({title:'A',parentId:f.root.id}),b=await createGoal({title:'B',parentId:f.root.id});
  const stop=(turn,text)=>hookOutput({hook_event_name:'Stop',session_id:f.thread,turn_id:turn,last_assistant_message:text},f.thread);
  const replies=async()=>(await readFeedback()).filter(e=>e.author==='agent').map(e=>[e.goalId,e.text]);
  const first=await f.work();await appendFeedback({goalId:a.id,text:'For A'});
  assert.match((await stop(first,null)).reason,/For A/);
  await f.endTurn('interrupted');
  const second=await f.work();
  assert.match((await stop(second,'Checked CI.')).reason,new RegExp(`Goal #${a.id}\\b`),'the earlier turn\'s Goal is asked for, not answered');
  assert.equal(await stop(second,'Checked CI.'),null);await f.endTurn();
  const third=await f.work();await appendFeedback({goalId:b.id,text:'For B'});
  assert.match((await stop(third,'Working.')).reason,/For B/,'handed at the stop; the turn goes on');
  assert.deepEqual(await replies(),[]);
  const held=await stop(third,'B is done.');
  assert.deepEqual(await replies(),[[b.id,'B is done.']]);
  assert.match(held.reason,new RegExp(`Goal #${a.id}\\b`));assert.doesNotMatch(held.reason,new RegExp(`Goal #${b.id}\\b`));
});

test('nothing is posted from a subagent, without text, or without an awaiting Goal',async t=>{
  const f=await fixture(t),first=await f.work();
  assert.equal(await hookOutput({hook_event_name:'Stop',session_id:f.thread,turn_id:first,last_assistant_message:'Nothing was asked.'},f.thread),null);
  await f.endTurn();await f.save('Fix it');
  const turn=(await f.running()).id,stop=(text,patch={})=>hookOutput({hook_event_name:'Stop',session_id:f.thread,turn_id:turn,last_assistant_message:text,...patch},f.thread);
  assert.equal(await stop('Subagent result',{agent_id:'child'}),null);
  assert.equal(await hookOutput({hook_event_name:'SubagentStop',session_id:f.thread,turn_id:turn,agent_id:'child',last_assistant_message:'Subagent result'},f.thread),null);
  for(const text of [null,'',' \n']){assert.match((await stop(text))?.reason??'',/where things stand/);await stop(text);}
  assert.deepEqual((await readFeedback()).filter(e=>e.author==='agent'),[]);
});
