// A Codex chat's hand-off by the shared rules (lib/agents/codex-work.mjs), against the fake Codex app.
// The user-visible flows are in test/harness-scenarios.test.mjs; this file covers what only Codex does.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import {appendFile,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {appendAgentComment,appendFeedback,createGoal,listGoals,readFeedback,readGoalContext} from '../lib/goal-store.mjs';
import {agentExecutions,agentReplied,assignGoal} from '../lib/agents/index.mjs';
import {keepGoingHeading} from '../lib/agent-messages.mjs';
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

test('the Stop is held once while Goals handed together await replies, and a reply on each ends that',async t=>{
  const f=await fixture(t),a=await createGoal({title:'A',parentId:f.root.id}),b=await createGoal({title:'B',parentId:f.root.id});
  const turn=await f.work(),stop=()=>hookOutput({hook_event_name:'Stop',session_id:f.thread,turn_id:turn},f.thread);
  const forA=await appendFeedback({goalId:a.id,text:'For A'}),forB=await appendFeedback({goalId:b.id,text:'For B'});
  assert.deepEqual(ids((await stop()).reason),[forA.changeId,forB.changeId],'both are handed when the turn would end');
  const held=await stop();
  assert.equal(held.decision,'block');assert.match(held.reason,new RegExp(`Goal #${a.id}, Goal #${b.id}\\b`));assert.match(held.reason,/comment --id <goalId>/);
  assert.equal(await stop(),null,'the stop right after a hold ends');
  for(const goal of [a,b])await appendAgentComment({goalId:goal.id,type:'comment',text:'Fixed'});
  assert.equal(await stop(),null);
  assert.equal((await codexSnapshot(f.thread)).roots[0].awaiting.size,0);
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

// What the chat writes is posted to its current Goal (lib/agent-messages.mjs), read from the rollout file
// Codex names as transcript_path, as Claude's transcript is (test/agent-messages.test.mjs).
const rollout=(...records)=>records.map(payload=>JSON.stringify({timestamp:new Date().toISOString(),type:'response_item',payload})+'\n').join('');
const said=(text,phase='commentary')=>({type:'message',id:`msg_${randomUUID()}`,role:'assistant',content:[{type:'output_text',text}],phase});
const ran=()=>({type:'function_call',name:'exec_command',arguments:'{"cmd":"true"}',call_id:`call_${randomUUID()}`});
async function chatting(t) {
  const f=await fixture(t),transcript=join(f.dir,'rollout.jsonl');await writeFile(transcript,'');
  const hook=(name,patch={})=>hookOutput({hook_event_name:name,session_id:f.thread,turn_id:f.turn,transcript_path:transcript,...patch},f.thread);
  const posted=async()=>(await readFeedback()).filter(e=>e.autoPosted).map(e=>[e.goalId,e.text]);
  return Object.assign(f,{transcript,hook,posted,write:(...records)=>appendFile(transcript,rollout(...records))});
}

test('every message of the turn, mid-turn ones too, is posted in order to the current Goal, once',async t=>{
  const f=await chatting(t),event=await f.save('Fix it');f.turn=(await f.running()).id;
  await f.hook('PostToolUse');
  await f.write(said('Looking at it.'),ran());
  await f.hook('PostToolUse');await f.hook('PostToolUse');
  assert.deepEqual(await f.posted(),[[f.root.id,'Looking at it.']],'posted at the tool hook, once');
  await f.write(said('Fixed it.','final_answer'));
  assert.equal(await f.hook('Stop',{last_assistant_message:'Fixed it.'}),null,'answered, so the stop is not held');
  assert.equal(await f.hook('Stop',{last_assistant_message:'Fixed it.'}),null);
  assert.deepEqual(await f.posted(),[[f.root.id,'Looking at it.'],[f.root.id,'Fixed it.']]);
  assert.ok((await readFeedback()).filter(e=>e.autoPosted).every(e=>e.answers===event));
  await f.endTurn();
  f.turn=await f.work();await f.write(said('Also checked the docs.','final_answer'));
  await f.hook('Stop',{last_assistant_message:'Also checked the docs.'});
  assert.equal((await f.posted()).at(-1)[1],'Also checked the docs.','a later turn without feedback still reaches the Goal');
});

test('without a transcript only the Stop\'s last message is posted, once per turn',async t=>{
  const f=await fixture(t);await f.save('Fix it');const turn=(await f.running()).id;
  const stop=text=>hookOutput({hook_event_name:'Stop',session_id:f.thread,turn_id:turn,last_assistant_message:text,transcript_path:null},f.thread);
  assert.equal(await stop('Fixed it.'),null);assert.equal(await stop('Fixed it.'),null);
  assert.deepEqual((await readFeedback()).filter(e=>e.autoPosted).map(e=>e.text),['Fixed it.']);
});

test('the current Goal follows a one-Goal hand-off and the chat\'s own goal comment; two Goals at once leave none',async t=>{
  const f=await chatting(t),a=await createGoal({title:'A',parentId:f.root.id}),b=await createGoal({title:'B',parentId:f.root.id});
  f.turn=await f.work();await f.hook('PostToolUse');
  await f.write(said('Nothing is current yet.'),ran());await f.hook('PostToolUse');
  assert.deepEqual(await f.posted(),[]);
  await appendFeedback({goalId:a.id,text:'For A'});await sendFeedbackNow((await readFeedback()).at(-1).changeId);
  assert.match((await f.hook('PostToolUse')).hookSpecificOutput.additionalContext,new RegExp(`Your messages in this conversation are posted to Goal #${a.id}\\.`));
  assert.equal((await readCodexWork(f.thread)).currentGoal,a.id);
  await f.write(said('On A.'),ran());await f.hook('PostToolUse');
  // bin/chill-agent's comment command, from another chat and then from this one.
  const {root}=await readGoalContext(b.id);
  await agentReplied(root,b.id,{CODEX_THREAD_ID:randomUUID()});
  assert.equal((await readCodexWork(f.thread)).currentGoal,a.id,'another chat\'s comment changes nothing');
  await agentReplied(root,b.id,{CODEX_THREAD_ID:f.thread});
  await f.write(said('On B.'),ran());await f.hook('PostToolUse');
  assert.deepEqual(await f.posted(),[[a.id,'On A.'],[b.id,'On B.']]);
  await appendFeedback({goalId:a.id,text:'More A'});await appendFeedback({goalId:b.id,text:'More B'});
  const text=(await f.hook('Stop',{last_assistant_message:null})).reason;
  assert.match(text,/waits for a reply on each Goal\. Reply on each Goal:/);
  assert.equal((await readCodexWork(f.thread)).currentGoal,null);
  await f.write(said('Both noted.','final_answer'));
  assert.match((await f.hook('Stop',{last_assistant_message:'Both noted.'})).reason,new RegExp(`Goal #${a.id}, Goal #${b.id}\\b`));
  assert.deepEqual((await f.posted()).length,2,'nothing is posted while no Goal is current');
});

test('a Keep going answer without a tool call is not posted; one that runs a tool is',async t=>{
  const f=await chatting(t);await f.save('Check the build');f.turn=(await f.running()).id;
  await f.hook('PostToolUse');
  await f.write(said('The build is green.','final_answer'));await f.hook('Stop',{last_assistant_message:'The build is green.'});
  await f.endTurn();
  const nudge={type:'message',role:'user',content:[{type:'input_text',text:`${keepGoingHeading}\n\nAuto mode is On.`}]};
  f.turn=randomUUID();
  await f.write(nudge,said('Nothing left to move forward.','final_answer'));
  assert.equal(await f.hook('Stop',{last_assistant_message:'Nothing left to move forward.'}),null);
  f.turn=randomUUID();
  await f.write(nudge,said('Updating the docs.'),ran());await f.hook('PostToolUse');
  await f.write(said('The docs are updated.','final_answer'));await f.hook('Stop',{last_assistant_message:'The docs are updated.'});
  assert.deepEqual((await f.posted()).map(([,text])=>text),['The build is green.','Updating the docs.','The docs are updated.']);
});

test('nothing is posted from a subagent or without text',async t=>{
  const f=await fixture(t);await f.save('Fix it');
  const turn=(await f.running()).id,stop=(text,patch={})=>hookOutput({hook_event_name:'Stop',session_id:f.thread,turn_id:turn,last_assistant_message:text,...patch},f.thread);
  assert.equal(await stop('Subagent result',{agent_id:'child'}),null);
  assert.equal(await hookOutput({hook_event_name:'SubagentStop',session_id:f.thread,turn_id:turn,agent_id:'child',last_assistant_message:'Subagent result'},f.thread),null);
  for(const text of [null,'',' \n'])assert.equal(await stop(text),null,'the current Goal is not held for');
  assert.deepEqual((await readFeedback()).filter(e=>e.author==='agent'),[]);
});
