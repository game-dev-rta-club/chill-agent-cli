// The final reply of a turn answers the one Goal awaiting a reply (hand-off postFinalReply), here through
// Claude's Stop hook. Codex's Stop is covered in test/codex-work.test.mjs and both in test/harness-scenarios.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appendFile,mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {captureClaudeEntry} from '../lib/claude-entry.mjs';
import {runClaudeAction,handleClaudeToolHook} from '../lib/claude-actions.mjs';
import {appendAgentComment,appendFeedback,appendFinalReply,createGoal,listGoals,readFeedback} from '../lib/goal-store.mjs';
import {continuationWorkspace} from '../lib/continuation-workspace.mjs';
import {readMonitor} from '../lib/continuation-monitor.mjs';
import {awaitingGoals,rootConversation} from '../lib/hand-off.mjs';
import {reportClaudeHook} from '../lib/claude-agent-work.mjs';
import {claudeEntry,claudeLine,hookFor} from './claude-fixtures.mjs';

async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'chill-final-reply-')),cwd=join(dir,'project');await mkdir(cwd);
 const old=process.env.CHILL_AGENT_DATA_DIR;process.env.CHILL_AGENT_DATA_DIR=join(dir,'data');
 t.after(async()=>{if(old===undefined)delete process.env.CHILL_AGENT_DATA_DIR;else process.env.CHILL_AGENT_DATA_DIR=old;await rm(dir,{recursive:true,force:true});});
 const envFile=join(dir,'env'),transcript=join(dir,'session.jsonl');await writeFile(envFile,'');await writeFile(transcript,'');
 const sessionId=randomUUID(),event=hookFor({session_id:sessionId,prompt_id:randomUUID(),cwd,transcript_path:transcript});
 await captureClaudeEntry(event('SessionStart',{source:'startup'}),{cwd,env:{CLAUDE_ENV_FILE:envFile}});
 const env={CHILL_AGENT_HARNESS:'claude-code',CHILL_AGENT_SESSION_ID:sessionId};
 const action=(name,payload)=>runClaudeAction(name,payload,{env});
 await action('create-goal',{title:'Outcome',scope:'',criteria:''});const root=(await listGoals())[0];
 return {root,action,event,
  // A new prompt starts new work, as bin/chill-connection reports it first.
  prompt:()=>reportClaudeHook(event('UserPromptSubmit',{prompt:'Check CI',source:'user'})),
  esc:()=>appendFile(transcript,claudeLine(claudeEntry.interrupt(randomUUID(),{timestamp:new Date().toISOString()}))),
  stop:(text,patch={})=>handleClaudeToolHook(event('Stop',{last_assistant_message:text,...patch}),{cwd}),
  replies:async()=>(await readFeedback()).filter(e=>e.author==='agent'),
  awaiting:async()=>[...awaitingGoals((await rootConversation(root.id)).events).keys()]};
}

test('Claude: the final reply answers the one Goal awaiting a reply, once, and the stop is not held',async t=>{
 const f=await fixture(t),comment=await appendFeedback({goalId:f.root.id,text:'Fix the typo'});await f.action('inbox',{});
 assert.equal(await f.stop('Fixed the typo in the README.'),null);
 const [reply]=await f.replies();
 assert.equal(reply.text,'Fixed the typo in the README.');assert.equal(reply.goalId,f.root.id);
 assert.equal(reply.autoPosted,true);assert.equal(reply.answers,comment.changeId);
 assert.deepEqual(await f.awaiting(),[]);
 assert.equal(await f.stop('Fixed the typo in the README.'),null);assert.equal(await f.stop('Anything else.'),null);
 assert.equal((await f.replies()).length,1,'a repeated Stop posts nothing more, and nothing awaits a reply');
});

test('Claude: a comment saved during the work is handed after the final reply and still awaits its own',async t=>{
 const f=await fixture(t),first=await appendFeedback({goalId:f.root.id,text:'First'});await f.action('inbox',{});
 const later=await appendFeedback({goalId:f.root.id,text:'Also this'});
 assert.match((await f.stop('First is done.')).reason,/Also this/);
 assert.deepEqual((await f.replies()).map(e=>[e.text,e.answers]),[['First is done.',first.changeId]]);
 assert.deepEqual(await f.awaiting(),[f.root.id],'the later comment was not answered by it');
 assert.equal(await f.stop('Also done.'),null);
 assert.deepEqual((await f.replies()).map(e=>[e.text,e.answers]),[['First is done.',first.changeId],['Also done.',later.changeId]]);
});

test('Claude: with two Goals awaiting a reply nothing is posted and the hold asks per Goal',async t=>{
 const f=await fixture(t),a=await createGoal({title:'A',parentId:f.root.id}),b=await createGoal({title:'B',parentId:f.root.id});
 await appendFeedback({goalId:a.id,text:'For A'});await appendFeedback({goalId:b.id,text:'For B'});await f.action('inbox',{});
 const held=await f.stop('Both are done.');
 assert.equal(held.decision,'block');assert.match(held.reason,new RegExp(`Goal #${a.id}, Goal #${b.id}\\b`));assert.match(held.reason,/connection reply --goal <goalId>/);
 assert.deepEqual(await f.replies(),[]);
 await f.action('reply',{goalId:a.id,text:'A is done'});
 assert.equal(await f.stop('B is done.',{stop_hook_active:true}),null,'one left: the final reply answers it');
 assert.deepEqual((await f.replies()).map(e=>[e.goalId,e.text]),[[a.id,'A is done'],[b.id,'B is done.']]);
});

// Only Goals handed comments during this work take its final reply; one left
// awaiting by earlier work is asked for by the stop hold instead.
test('Claude: a Goal left awaiting by earlier work, ended or stopped with Esc, gets no later final reply',async t=>{
 const f=await fixture(t);await appendFeedback({goalId:f.root.id,text:'Fix the typo'});
 await f.prompt();await f.action('inbox',{});
 assert.match((await f.stop(null)).reason,/where things stand/);
 assert.equal(await f.stop(null,{stop_hook_active:true}),null,'the work ends without a reply');
 await f.prompt();
 const held=await f.stop('CI is green; nothing left.');
 assert.match(held.reason,new RegExp(`Goal #${f.root.id}\\b`));assert.match(held.reason,/connection reply --goal <goalId>/);
 assert.equal(await f.stop('CI is green; nothing left.',{stop_hook_active:true}),null);
 assert.deepEqual(await f.replies(),[]);
 // Esc ends the work without a hook; the next prompt's work is new.
 await f.prompt();await f.action('reply',{goalId:f.root.id,text:'Fixed'});
 await appendFeedback({goalId:f.root.id,text:'And the other one'});await f.action('inbox',{});
 await f.esc();await f.prompt();
 assert.match((await f.stop('Nothing new.')).reason,/where things stand/);
 assert.deepEqual((await f.replies()).map(e=>e.text),['Fixed']);
});

test('Claude: with one Goal handed this work and one left by earlier work, only this work\'s Goal takes the final reply',async t=>{
 const f=await fixture(t),a=await createGoal({title:'A',parentId:f.root.id}),b=await createGoal({title:'B',parentId:f.root.id});
 await f.prompt();await appendFeedback({goalId:a.id,text:'For A'});await f.action('inbox',{});
 await f.stop(null);assert.equal(await f.stop(null,{stop_hook_active:true}),null);
 await f.prompt();await appendFeedback({goalId:b.id,text:'For B'});
 assert.match((await f.stop('Checked CI.')).reason,/For B/,'handed at the stop; the work goes on');
 assert.deepEqual(await f.replies(),[]);
 const held=await f.stop('B is done.',{stop_hook_active:true});
 assert.deepEqual((await f.replies()).map(e=>[e.goalId,e.text]),[[b.id,'B is done.']]);
 assert.match(held.reason,new RegExp(`Goal #${a.id}\\b`));assert.doesNotMatch(held.reason,new RegExp(`Goal #${b.id}\\b`));
});

test('Claude: nothing is posted without an awaiting Goal, without text, or from a subagent',async t=>{
 const f=await fixture(t);
 assert.equal(await f.stop('Nothing was asked.'),null);assert.deepEqual(await f.replies(),[]);
 await appendFeedback({goalId:f.root.id,text:'Fix it'});await f.action('inbox',{});
 assert.equal(await handleClaudeToolHook(f.event('SubagentStop',{agent_id:'child',agent_type:'general-purpose',last_assistant_message:'Subagent result'})),null);
 assert.equal(await f.stop('Subagent result',{agent_id:'child'}),null);
 for(const text of [null,'','  \n']){
  const held=await f.stop(text);assert.match(held?.reason??'',/where things stand/,'the Goal still awaits a reply');
  await f.stop(text,{stop_hook_active:true});
 }
 assert.deepEqual(await f.replies(),[]);
});

test('a final reply posted at a stop is not counted as work by Keep going',async t=>{
 const f=await fixture(t);
 await f.action('extension',{extension:'continuation',operation:'configure',input:{rootId:f.root.id,enabled:true}});
 await appendFeedback({goalId:f.root.id,text:'Check the build'});await f.action('inbox',{});
 assert.match((await f.stop(null)).reason,/where things stand/);
 assert.match((await f.stop(null,{stop_hook_active:true})).reason,/Auto mode is On/);
 assert.equal(await f.stop('Nothing left to move forward.',{stop_hook_active:true}),null);
 assert.equal((await f.replies()).at(-1).text,'Nothing left to move forward.','the Goal awaiting a reply gets it');
 assert.equal((await readMonitor(f.root.id)).attempts[0].result.outcome,'no-work');
 // The progress mark both harnesses compare across a request.
 const before=(await continuationWorkspace(f.root.id)).progress;
 const [{answers}]=await f.replies();await appendFinalReply({goalId:f.root.id,text:'Another final reply',requestId:randomUUID(),answers});
 assert.equal((await continuationWorkspace(f.root.id)).progress,before);
 await appendAgentComment({goalId:f.root.id,type:'comment',text:'A real report'});
 assert.notEqual((await continuationWorkspace(f.root.id)).progress,before);
});
