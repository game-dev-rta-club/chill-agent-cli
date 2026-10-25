import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,utimes,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {captureClaudeEntry,claudeEntryPaths} from '../lib/claude-entry.mjs';
import {backgroundTasks,hookWorkEvent,observedClaudeWork,recordClaudeWork,reportClaudeHook,silentMs} from '../lib/claude-agent-work.mjs';
import {handleClaudeToolHook} from '../lib/claude-actions.mjs';
import {readJson} from '../lib/storage.mjs';
import {agentStatus} from '../lib/agent-rules.mjs';
import {claudeEntry,claudeHook,claudeLine,hookFor,subagentHook} from './claude-fixtures.mjs';

async function conversation(t) {
  const dir=await mkdtemp(join(tmpdir(),'chill-claude-work-')),previous=process.env.CHILL_AGENT_DATA_DIR;
  process.env.CHILL_AGENT_DATA_DIR=join(dir,'data');
  t.after(async()=>{if(previous===undefined)delete process.env.CHILL_AGENT_DATA_DIR;else process.env.CHILL_AGENT_DATA_DIR=previous;await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
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
  assert.deepEqual(hookWorkEvent(subagentHook('PostToolUse',{agent_id:'a1'}),new Date('2026-10-19T10:00:00Z')),{type:'subagent',task:{id:'a1',type:'subagent',name:'general-purpose',description:null},at:'2026-10-19T10:00:00.000Z'},'a subagent\'s tool shows it is active');
  assert.deepEqual(hookWorkEvent(subagentHook('SubagentStop',{agent_id:'a1'})),{type:'subagent-stopped',id:'a1'});
  assert.equal(hookWorkEvent(subagentHook('Stop')),null);
});

test('background agents count; shells such as a dev server or chill\'s own hold task do not',()=>{
  assert.deepEqual(backgroundTasks([{id:'1',type:'subagent',status:'running',agent_type:'general-purpose',description:'Review'},{id:'2',type:'monitor',status:'running',server:'ci',tool:'watch'},{id:'3',type:'shell',status:'running',command:'npm run dev'},{id:'4',type:'shell',status:'running',command:'chill connection wait'},{id:'5',type:'subagent',status:'completed'}]),
    [{id:'1',type:'subagent',name:'general-purpose',description:'Review'},{id:'2',type:'monitor',name:'ci watch',description:null}]);
  assert.deepEqual(backgroundTasks(undefined),[]);
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
  assert.deepEqual([work.phase,work.background.map(t=>[t.id,t.type])],['idle',[['a','subagent']]]);
  assert.equal(agentStatus({work}),'running');
});

test('a subagent runs from SubagentStart to SubagentStop, as its own hooks report',async t=>{
  const c=await conversation(t),subagent=(name,patch)=>reportClaudeHook(c.event(name,{agent_id:'a1',agent_type:'general-purpose',...patch}));
  await reportClaudeHook(c.event('UserPromptSubmit'));
  await subagent('SubagentStart');
  await handleClaudeToolHook(c.event('Stop',{background_tasks:[{id:'a1',type:'subagent',status:'running',agent_type:'general-purpose',description:'Review'}]}));
  const listed=(await c.observed()).work;
  assert.equal(agentStatus({work:listed}),'running','the response ended; the subagent still runs');
  assert.deepEqual(listed.background.map(t=>[t.id,t.name,t.description]),[['a1','general-purpose','Review']]);
  await subagent('PreToolUse',{tool_name:'Bash',tool_input:{command:'sleep 1'}});
  assert.ok((await c.record()).agentWork.background[0].activeAt,'its tools show when it was last active');
  await subagent('SubagentStop',{stop_hook_active:false,agent_transcript_path:'/example/a1.jsonl'});
  assert.equal(agentStatus({work:(await c.observed()).work}),'idle','its end needs no further Stop');
});

test('a background task stopped without SubagentStop ends with the notice Claude Code writes, and silence makes it unknown',async t=>{
  const c=await conversation(t);
  await reportClaudeHook(c.event('UserPromptSubmit'));
  await reportClaudeHook(c.event('SubagentStart',{agent_id:'a2',agent_type:'general-purpose'}));
  await handleClaudeToolHook(c.event('Stop',{background_tasks:[{id:'a2',type:'subagent',status:'running'},{id:'m1',type:'monitor',status:'running',server:'ci',tool:'watch'}]}));
  assert.equal((await c.observed({now:()=>Date.now()+silentMs+60000})).known,false,'nothing active for that long is unknown, not Running');
  await writeFile(c.transcript,claudeLine(claudeEntry.notice('a2',{timestamp:new Date(Date.now()+1000).toISOString()})));
  assert.deepEqual((await c.observed()).work.background.map(t=>t.id),['m1'],'the stopped subagent is gone');
  assert.equal((await c.record()).agentWork.background.length,2,'reading changes nothing');
  await writeFile(c.transcript,claudeLine(claudeEntry.notice('m1',{timestamp:'2020-01-01T00:00:00.000Z'})),{flag:'a'});
  assert.deepEqual((await c.observed()).work.background.map(t=>t.id),['m1'],'a notice from before the task was listed is an earlier run');
});
