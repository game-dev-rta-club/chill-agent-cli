import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,utimes,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {captureClaudeEntry,claudeEntryPaths} from '../lib/claude-entry.mjs';
import {backgroundActivity,backgroundTasks,hookWorkEvent,observedClaudeWork,recordClaudeWork,reportClaudeHook,silentMs} from '../lib/claude-agent-work.mjs';
import {handleClaudeToolHook} from '../lib/claude-actions.mjs';
import {readJson} from '../lib/storage.mjs';
import {agentStatus} from '../lib/agent-rules.mjs';
import {claudeEntry,claudeHook,claudeLine,hookFor,subagentHook} from './claude-fixtures.mjs';

async function conversation(t) {
  const dir=await mkdtemp(join(tmpdir(),'chill-claude-work-')),previous=process.env.CHILL_AGENT_DATA_DIR;
  process.env.CHILL_AGENT_DATA_DIR=join(dir,'data');
  t.after(async()=>{if(previous===undefined)delete process.env.CHILL_AGENT_DATA_DIR;else process.env.CHILL_AGENT_DATA_DIR=previous;await rm(dir,{recursive:true,force:true});});
  const cwd=join(dir,'project'),transcript=join(dir,'session.jsonl'),sessionId='native/session';
  await mkdir(cwd);await writeFile(join(dir,'env'),'');await writeFile(transcript,'');
  const shared={session_id:sessionId,cwd,transcript_path:transcript},event=hookFor(shared);
  await captureClaudeEntry(claudeHook('SessionStart',{...shared,source:'startup'}),{cwd,env:{CLAUDE_ENV_FILE:join(dir,'env')}});
  const record=()=>readJson(claudeEntryPaths(process.env.CHILL_AGENT_DATA_DIR,sessionId).record);
  const observed=async(options)=>observedClaudeWork(await record(),options);
  return {sessionId,transcript,event,record,observed};
}

test('each main hook reports what the conversation is doing; a subagent reports nothing',()=>{
  const cases=[
    ['UserPromptSubmit','started'],['PreToolUse','started'],['PermissionRequest','started'],['PostToolUse','started'],
    ['SessionEnd','ended'],['SessionStart',null],['Stop',null],
  ];
  for(const [name,type] of cases)assert.equal(hookWorkEvent(claudeHook(name))?.type??null,type,name);
  assert.equal(hookWorkEvent(claudeHook('StopFailure')).type,'interrupted','an API error ends the response without Stop');
  assert.equal(hookWorkEvent(subagentHook('PostToolUse')),null);
});

test('background agents count; shells such as a dev server or chill\'s own waiter do not',()=>{
  assert.deepEqual(backgroundTasks([{id:'1',type:'subagent',status:'running',agent_type:'general-purpose',description:'Review'},{id:'2',type:'monitor',status:'running',server:'ci',tool:'watch'},{id:'3',type:'shell',status:'running',command:'npm run dev'},{id:'4',type:'shell',status:'running',command:'chill connection wait'},{id:'5',type:'subagent',status:'completed'}]),
    [{id:'1',type:'subagent',name:'general-purpose',description:'Review'},{id:'2',type:'monitor',name:'ci watch',description:null}]);
  assert.deepEqual(backgroundTasks(undefined),[]);
});

test('a background subagent shows when it last wrote its own transcript; other tasks show none',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'chill-claude-background-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const sessionId='7d1b148a-2700-47c3-9e5f-0a00c1e9c27b',folder=join(dir,sessionId,'subagents'),at=new Date('2026-10-19T10:47:00Z');
  await mkdir(folder,{recursive:true});await writeFile(join(folder,'agent-a1.jsonl'),'');await utimes(join(folder,'agent-a1.jsonl'),at,at);
  const tasks=[{id:'a1',type:'subagent',name:'general-purpose',description:'Review'},{id:'m1',type:'monitor',name:'ci watch',description:null},{id:'a2',type:'subagent',name:null,description:null}];
  assert.deepEqual((await backgroundActivity({sessionId,transcriptPath:join(dir,`${sessionId}.jsonl`)},tasks)).map(task=>task.activeAt),[at.toISOString(),null,null]);
});

test('work runs from the first hook until a Stop that nothing continues',async t=>{
  const c=await conversation(t);
  assert.equal((await c.observed()).work.phase,'idle','a local command such as /reload-skills sends no hook');
  await reportClaudeHook(c.event('UserPromptSubmit'));
  const started=(await c.record()).agentWork;
  assert.equal(started.phase,'working');
  await reportClaudeHook(c.event('PostToolUse'));
  assert.equal((await c.record()).agentWork.id,started.id,'the same work, written once');
  assert.equal(await handleClaudeToolHook(c.event('Stop')),null);
  assert.equal((await c.record()).agentWork.phase,'idle');
  await reportClaudeHook(c.event('UserPromptSubmit'));
  assert.notEqual((await c.record()).agentWork.id,started.id,'the next work is a new one');
});

test('Esc ends the work although no hook reports it; the next prompt starts it again',async t=>{
  const c=await conversation(t);
  await reportClaudeHook(c.event('UserPromptSubmit'));
  await writeFile(c.transcript,claudeLine(claudeEntry.interrupt('i0',{timestamp:'2020-01-01T00:00:00.000Z'})));
  assert.equal((await c.observed()).work.phase,'working','an interrupt before this work does not end it');
  await writeFile(c.transcript,claudeLine(claudeEntry.interrupt('i1',{timestamp:new Date(Date.now()+1000).toISOString()})),{flag:'a'});
  assert.equal((await c.observed()).work.phase,'interrupted');
  assert.equal((await c.record()).agentWork.phase,'working','reading changes nothing');
  await reportClaudeHook(c.event('StopFailure',{error:'rate_limit'}));
  assert.equal((await c.record()).agentWork.phase,'interrupted');
});

test('work that has written nothing for a long time is unknown, not Running or idle',async t=>{
  const c=await conversation(t);
  await reportClaudeHook(c.event('UserPromptSubmit'));
  assert.equal((await c.observed()).known,true);
  const later=Date.now()+silentMs+1000;
  assert.equal((await c.observed({now:()=>later})).known,false);
  const written=new Date(later-1000);await utimes(c.transcript,written,written);
  assert.equal((await c.observed({now:()=>later})).known,true,'a transcript still being written keeps it known');
});

test('a stop ends the work, and the background agents it leaves keep the conversation Running',async t=>{
  const c=await conversation(t);
  await recordClaudeWork(c.sessionId,[{type:'started'}]);
  await handleClaudeToolHook(c.event('Stop',{background_tasks:[{id:'a',type:'subagent',status:'running'}]}));
  const work=(await c.record()).agentWork;
  assert.deepEqual([work.phase,work.background],['idle',[{id:'a',type:'subagent',name:null,description:null}]]);
  assert.equal(agentStatus({work}),'running');
});
