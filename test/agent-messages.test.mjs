// The last message of each response is posted to its conversation's current Goal (lib/agent-messages.mjs),
// here through Claude's hooks and transcript. Codex is covered in test/codex-work.test.mjs and both in
// test/harness-scenarios.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {appendFile,mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {captureClaudeEntry,claudeEntryPaths} from '../lib/claude-entry.mjs';
import {runClaudeAction,handleClaudeToolHook,postClaudeHookMessages} from '../lib/claude-actions.mjs';
import {appendAgentComment,appendFeedback,appendPostedMessage,createGoal,listGoals,readFeedback,updateGoal} from '../lib/goal-store.mjs';
import {continuationWorkspace} from '../lib/continuation-workspace.mjs';
import {readMonitor} from '../lib/continuation-monitor.mjs';
import {awaitingGoals,rootConversation} from '../lib/hand-off.mjs';
import {currentAfterHandOff,keepGoingHeading,lastMessageNotice} from '../lib/agent-messages.mjs';
import {claudeMessageItems} from '../lib/claude-transcript.mjs';
import {reportClaudeHook} from '../lib/claude-agent-work.mjs';
import {dataDirectory} from '../lib/data-directory.mjs';
import {readJson,writeJsonAtomically} from '../lib/storage.mjs';
import {claudeEntry,claudeLine,hookFor,recordedText} from './claude-fixtures.mjs';

// The sentence every hook that names the current Goal shows, as a pattern.
const notice=goalId=>lastMessageNotice(goalId).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');

async function fixture(t){
 const dir=await mkdtemp(join(tmpdir(),'chill-agent-messages-')),cwd=join(dir,'project');await mkdir(cwd);
 const old=process.env.CHILL_AGENT_DATA_DIR;process.env.CHILL_AGENT_DATA_DIR=join(dir,'data');
 t.after(async()=>{if(old===undefined)delete process.env.CHILL_AGENT_DATA_DIR;else process.env.CHILL_AGENT_DATA_DIR=old;await rm(dir,{recursive:true,force:true});});
 const envFile=join(dir,'env'),transcript=join(dir,'session.jsonl');await writeFile(envFile,'');await writeFile(transcript,'');
 const sessionId=randomUUID(),event=hookFor({session_id:sessionId,prompt_id:randomUUID(),cwd,transcript_path:transcript});
 await captureClaudeEntry(event('SessionStart',{source:'startup'}),{cwd,env:{CLAUDE_ENV_FILE:envFile}});
 const env={CHILL_AGENT_HARNESS:'claude-code',CHILL_AGENT_SESSION_ID:sessionId};
 const action=(name,payload)=>runClaudeAction(name,payload,{env});
 await action('create-goal',{title:'Outcome',scope:'',criteria:''});const root=(await listGoals())[0];
 const write=(...entries)=>appendFile(transcript,entries.map(claudeLine).join(''));
 const f={root,action,event,transcript,env,write,
  // As bin/chill-connection runs each main hook: the work is reported, then the hook is handled.
  async hook(name,patch={}){
   const input=event(name,patch);await reportClaudeHook(input);
   return ['PreToolUse','PermissionRequest'].includes(name)?postClaudeHookMessages(input):handleClaudeToolHook(input,{cwd});
  },
  prompt:()=>f.hook('UserPromptSubmit',{prompt:'Check CI',source:'user'}),
  // The agent writes `text` and its Stop hook runs, as Claude Code does.
  async say(text,patch={}){await write(claudeEntry.text(randomUUID(),text));return f.hook('Stop',{last_assistant_message:text,...patch});},
  // A text block and the tool call after it, then the tool's hooks.
  async work(text){await write(claudeEntry.text(randomUUID(),text),claudeEntry.tool(randomUUID(),'Bash',{command:'true'}));await f.hook('PreToolUse');return f.hook('PostToolUse',{tool_name:'Bash',tool_use_id:randomUUID(),tool_response:{stdout:''}});},
  posted:async()=>(await readFeedback()).filter(e=>e.autoPosted).map(e=>[e.goalId,e.text]),
  replies:async()=>(await readFeedback()).filter(e=>e.author==='agent').map(e=>[e.goalId,e.text]),
  awaiting:async()=>[...awaitingGoals((await rootConversation(root.id)).events).keys()],
  record:()=>readJson(claudeEntryPaths(dataDirectory(),sessionId).record)};
 // The first hook finds where the transcript ends; what was written before is not posted.
 await f.prompt();
 return f;
}

test('only the last message of each response is posted to the current Goal, once',async t=>{
 const f=await fixture(t),comment=await appendFeedback({goalId:f.root.id,text:'Fix the typo'});await f.action('inbox',{});
 await f.write(claudeEntry.assistant(randomUUID(),[{type:'text',text:'Looking at the README.'},{type:'text',text:'Found it on line 3.'}]),claudeEntry.tool(randomUUID(),'Bash',{command:'true'}));
 await f.hook('PreToolUse');
 await f.hook('PostToolUse',{tool_name:'Bash',tool_use_id:randomUUID(),tool_response:{stdout:''}});
 assert.deepEqual(await f.posted(),[],'what the agent writes during the response is not posted');
 assert.equal(await f.say('Fixed the typo.'),null,'the Goal is answered, so the stop is not held');
 assert.equal(await f.hook('Stop',{last_assistant_message:'Fixed the typo.',stop_hook_active:true}),null);
 assert.deepEqual(await f.posted(),[[f.root.id,'Fixed the typo.']],'a repeated Stop posts once');
 assert.ok((await readFeedback()).filter(e=>e.autoPosted).every(e=>e.answers===comment.changeId));
 assert.deepEqual(await f.awaiting(),[]);
 await f.prompt();await f.work('Checking the rest.');await f.say('Anything else is done too.');
 assert.deepEqual((await f.posted()).map(([,text])=>text),['Fixed the typo.','Anything else is done too.'],'a later response with no new feedback still reaches the Goal');
});

test('a Stop seen by two hooks at once, or again after its record was lost, is posted once',async t=>{
 const f=await fixture(t);await appendFeedback({goalId:f.root.id,text:'Go'});await f.action('inbox',{});
 await f.write(claudeEntry.text(randomUUID(),'Started and finished.'));
 const before=(await f.record()).messages,stop=()=>f.hook('Stop',{last_assistant_message:'Started and finished.'});
 await Promise.all([stop(),stop()]);
 // A hook that posted but could not save how far it read: the next one reads the transcript again.
 const record=await f.record();await writeJsonAtomically(claudeEntryPaths(dataDirectory(),record.sessionId).record,{...record,messages:before});
 await stop();
 assert.deepEqual(await f.posted(),[[f.root.id,'Started and finished.']]);
});

test('the Stop\'s message is posted whether or not the transcript shows it; a Stop without one posts nothing',async t=>{
 const f=await fixture(t);await appendFeedback({goalId:f.root.id,text:'Go'});await f.action('inbox',{});
 assert.equal(await f.hook('Stop',{last_assistant_message:'Done before the transcript caught up.'}),null);
 await f.write(claudeEntry.text(randomUUID(),'Done before the transcript caught up.'));
 await f.prompt();await f.write(claudeEntry.text(randomUUID(),'Only in the transcript.'));
 await f.hook('Stop',{last_assistant_message:null});
 await f.prompt();await f.say('Next.');
 assert.deepEqual((await f.posted()).map(([,text])=>text),['Done before the transcript caught up.','Next.']);
});

test('the current Goal: set by a hand-off from one Goal, by connection reply, and unchanged by an empty hand-off',async t=>{
 const f=await fixture(t),a=await createGoal({title:'A',parentId:f.root.id}),b=await createGoal({title:'B',parentId:f.root.id});
 assert.equal(currentAfterHandOff('7',[]),'7');assert.equal(currentAfterHandOff(null,[{goalId:'3'},{goalId:'3'}]),'3');assert.equal(currentAfterHandOff('7',[{goalId:'3'},{goalId:'4'}]),null);
 await f.say('Nothing is current yet.');
 assert.deepEqual(await f.posted(),[],'no current Goal: nothing is posted');
 await f.prompt();await appendFeedback({goalId:a.id,text:'For A'});await f.action('inbox',{});
 assert.equal((await f.record()).currentGoal,a.id);
 await f.work('Working on A.');
 await f.say('A is done.');
 assert.deepEqual(await f.posted(),[[a.id,'A is done.']]);
 // A reply in the middle of a response makes its Goal current for that response's last message and every later one.
 await f.prompt();await f.work('Looking at B.');
 await f.action('reply',{goalId:b.id,text:'B: a separate note.'});
 assert.equal((await f.record()).currentGoal,b.id);
 await f.work('Still on B.');
 await f.say('This goes to B now.');
 await f.prompt();await f.say('A later response goes to B too.');
 assert.deepEqual(await f.posted(),[[a.id,'A is done.'],[b.id,'This goes to B now.'],[b.id,'A later response goes to B too.']]);
 assert.equal((await f.record()).currentGoal,b.id);
});

test('a compacted or resumed conversation keeps its current Goal and posts on from where it read',async t=>{
 const f=await fixture(t);await appendFeedback({goalId:f.root.id,text:'Go'});await f.action('inbox',{});
 await f.say('Before compacting.');
 await captureClaudeEntry(f.event('SessionStart',{source:'compact'}),{cwd:join(f.transcript,'..','project'),env:{CLAUDE_ENV_FILE:join(f.transcript,'..','env')}});
 assert.equal((await f.record()).currentGoal,f.root.id);
 await f.prompt();
 assert.equal(await f.say('After compacting.'),null);
 assert.deepEqual((await f.posted()).map(([,text])=>text),['Before compacting.','After compacting.']);
 await captureClaudeEntry(f.event('SessionStart',{source:'clear'}),{cwd:join(f.transcript,'..','project'),env:{CLAUDE_ENV_FILE:join(f.transcript,'..','env')}});
 assert.equal((await f.record()).currentGoal,undefined,'a cleared context starts without one');
});

test('#78: an interim reply, then the result written in a later response that no feedback started, reaches the Goal',async t=>{
 const f=await fixture(t);await appendFeedback({goalId:f.root.id,text:'Why does CI fail?'});await f.action('inbox',{});
 await f.action('reply',{goalId:f.root.id,text:'Researching; I will answer here.'});
 assert.equal(await f.say('A subagent is checking the logs.'),null);
 // The subagent's completion notice starts the next response; no prompt hook, no feedback.
 await f.work('The subagent reported back.');
 assert.equal(await f.say('CI fails because the cache key changed.'),null);
 assert.deepEqual(await f.replies(),[[f.root.id,'Researching; I will answer here.'],[f.root.id,'A subagent is checking the logs.'],[f.root.id,'CI fails because the cache key changed.']]);
});

test('feedback from two Goals at once: nothing is posted, the stop asks for a reply on each, and a reply makes that Goal current',async t=>{
 const f=await fixture(t),a=await createGoal({title:'A',parentId:f.root.id}),b=await createGoal({title:'B',parentId:f.root.id});
 await appendFeedback({goalId:a.id,text:'For A'});await appendFeedback({goalId:b.id,text:'For B'});
 const {text}=await f.action('inbox',{});
 assert.match(text,/The user reads only the Web and waits for a reply on each Goal\. Reply on each Goal: .*connection reply --goal <goalId>/);assert.doesNotMatch(text,/last message of each turn/);
 const held=await f.say('Both are done.');
 assert.equal(held.decision,'block');assert.match(held.reason,new RegExp(`Goal #${a.id}, Goal #${b.id}\\b`));assert.match(held.reason,/connection reply --goal <goalId>/);
 assert.deepEqual(await f.posted(),[]);
 await f.action('reply',{goalId:a.id,text:'A is done.'});
 const left=await f.say('B is still open.',{stop_hook_active:true});
 assert.equal(left,null,'the stop right after a hold ends');
 assert.deepEqual(await f.posted(),[[a.id,'B is still open.']],'messages reach the Goal it replied on');
});

test('a single-Goal hand-off names the Goal the last message goes to, and the language, without another way to reply',async t=>{
 const f=await fixture(t);await appendFeedback({goalId:f.root.id,text:'Go'});
 const {text}=await f.action('inbox',{});
 assert.match(text,new RegExp(`The user reads only the Web\\. ${notice(f.root.id)}\\n`));
 assert.doesNotMatch(text,/To reply on a specific Goal|Your messages in this conversation/);
 assert.doesNotMatch(text,/final reply/);
});

test('a Keep going answer without a tool call is not posted; the last message of one that runs a tool is, and neither counts as work',async t=>{
 const f=await fixture(t);
 await f.action('extension',{extension:'continuation',operation:'configure',input:{rootId:f.root.id,enabled:true}});
 await appendFeedback({goalId:f.root.id,text:'Check the build'});await f.action('inbox',{});
 const nudge=await f.say('The build is green.');
 assert.match(nudge.reason,/Auto mode is On/);assert.match(nudge.reason,new RegExp(notice(f.root.id)));
 assert.doesNotMatch(nudge.reason,/final reply|Your messages in this conversation/);
 // Claude Code writes the Stop hook's reason into the transcript before the model answers it.
 const request=reason=>f.write(claudeEntry.prompt(randomUUID(),`Stop hook feedback:\n${reason}`,{isMeta:true}));
 await request(nudge.reason);
 assert.equal(await f.say('Nothing left to move forward.',{stop_hook_active:true}),null);
 assert.deepEqual((await f.posted()).map(([,text])=>text),['The build is green.'],'the one-line answer is not posted');
 assert.equal((await readMonitor(f.root.id)).attempts[0].result.outcome,'no-work','a posted message is not work');
 // A new revision gets a new request; this time the answer runs a tool.
 await updateGoal(f.root.id,{scope:'Also update the docs'});await f.prompt();
 const second=await f.say('Scope noted.');assert.match(second.reason,/Auto mode is On/);
 await request(second.reason);
 await f.work('Updating the docs now.');
 assert.equal(await f.say('The docs are updated.',{stop_hook_active:true}),null);
 assert.deepEqual((await f.posted()).map(([,text])=>text),['The build is green.','Scope noted.','The docs are updated.']);
 assert.equal((await readMonitor(f.root.id)).attempts.at(-1).result.outcome,'no-work','posted messages leave the progress mark as it was');
 // The progress mark both harnesses compare across a request.
 const before=(await continuationWorkspace(f.root.id)).progress;
 await appendPostedMessage({goalId:f.root.id,text:'Another posted message',requestId:randomUUID(),answers:0});
 assert.equal((await continuationWorkspace(f.root.id)).progress,before);
 await appendAgentComment({goalId:f.root.id,type:'comment',text:'A real report'});
 assert.notEqual((await continuationWorkspace(f.root.id)).progress,before);
});

test('nothing is posted for empty text or from a subagent',async t=>{
 const f=await fixture(t);await appendFeedback({goalId:f.root.id,text:'Fix it'});await f.action('inbox',{});
 await f.write(claudeEntry.assistant(randomUUID(),[{type:'text',text:''},{type:'text',text:'  \n'}]),claudeEntry.tool(randomUUID(),'Bash',{command:'true'}));
 await f.hook('PreToolUse');
 assert.equal(await handleClaudeToolHook(f.event('SubagentStop',{agent_id:'child',agent_type:'general-purpose',last_assistant_message:'Subagent result'})),null);
 assert.equal(await f.hook('Stop',{agent_id:'child',last_assistant_message:'Subagent result'}),null);
 await f.write(claudeEntry.text(randomUUID(),'Subagent text',{isSidechain:true}));
 for(const text of [null,'','  \n']){
  const held=await f.hook('Stop',{last_assistant_message:text});assert.equal(held,null,'the current Goal is not held for');
 }
 assert.deepEqual(await f.posted(),[]);
 assert.deepEqual(await f.awaiting(),[f.root.id],'and it still awaits a reply');
});

test('the reader keeps the tool calls and Keep going requests of the main conversation only',()=>{
 const lines=recordedText('feedback-turn').split('\n').filter(Boolean).map(line=>({at:0,line:Buffer.from(line)}));
 const items=claudeMessageItems(lines,keepGoingHeading);
 assert.ok(items.length&&items.every(i=>i.type==='tool'),'text is not read');
 const meta=claudeEntry.prompt(randomUUID(),`Stop hook feedback:\n${keepGoingHeading}\nAuto mode is On.`,{isMeta:true});
 const read=entry=>claudeMessageItems([{at:0,line:Buffer.from(JSON.stringify(entry))}],keepGoingHeading);
 assert.deepEqual(read(meta),[{type:'nudge'}]);
 assert.deepEqual(read(claudeEntry.prompt(randomUUID(),`${keepGoingHeading} pasted by the user`)),[]);
 assert.deepEqual(read(claudeEntry.tool(randomUUID(),'Bash',{command:'true'},{isSidechain:true})),[]);
 assert.deepEqual(read(claudeEntry.text(randomUUID(),'API Error',{message:{model:'<synthetic>'}})),[]);
});

test('a check scheduled with --goal makes that Goal current when the watcher wakes the conversation',async t=>{
 const {scheduleClaudeWake}=await import('../lib/claude-wake.mjs');
 const {watchClaudeConversation,watcherWakeText}=await import('../lib/claude-wait.mjs');
 const f=await fixture(t),a=await createGoal({title:'A',parentId:f.root.id});
 await appendFeedback({goalId:f.root.id,text:'Ship it'});await f.action('inbox',{});
 await f.action('reply',{goalId:f.root.id,text:'Shipping; CI runs on the release branch (Goal A).'});
 await assert.rejects(scheduleClaudeWake({minutes:10,goal:'x',env:f.env}),/--goal must be a Goal ID/);
 const stranger=await createGoal({title:'Not this conversation\'s'});
 await assert.rejects(scheduleClaudeWake({minutes:10,goal:stranger.id,env:f.env}),/belongs to another conversation/);
 let clock=Date.now();const now=()=>clock;
 const {wake}=await scheduleClaudeWake({minutes:10,reason:'CI of PR #91',goal:a.id,env:f.env,now});
 assert.equal(wake.goalId,a.id);
 assert.equal((await f.record()).currentGoal,f.root.id,'scheduling changes nothing yet');
 // The check waits for the response that scheduled it to end.
 assert.equal(await f.say('Waiting for CI.'),null);
 clock+=600000;
 const controller=new AbortController(),woken=await watchClaudeConversation({sessionId:(await f.record()).sessionId,signal:controller.signal,pollMs:10,now,attached:()=>true});
 assert.deepEqual(woken,{status:'wake',reason:'CI of PR #91',goalId:a.id});
 assert.match(watcherWakeText(woken),new RegExp(`check you scheduled is due \\(CI of PR #91\\)\\. Do it now\\. ${notice(a.id)} [\\s\\S]*--goal ${a.id}`));
 assert.equal((await f.record()).currentGoal,a.id);
 await f.write(claudeEntry.prompt(randomUUID(),'chill-agent watcher'));
 assert.equal(await f.say('CI is green.'),null);
 assert.deepEqual((await f.posted()).at(-1),[a.id,'CI is green.']);
});
