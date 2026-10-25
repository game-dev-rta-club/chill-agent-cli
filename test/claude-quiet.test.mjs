import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,symlink,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {captureClaudeEntry,claudeEntryPaths} from '../lib/claude-entry.mjs';
import {runClaudeAction} from '../lib/claude-actions.mjs';
import {claudeQuietPath,quietClaudeHook} from '../lib/claude-quiet.mjs';
import {prepareRuntime} from '../lib/runtime-package.mjs';
import {listGoals} from '../lib/goal-store.mjs';
import {readJson} from '../lib/storage.mjs';
import {hookFor} from './claude-fixtures.mjs';

async function store(t) {
  const dir=await mkdtemp(join(tmpdir(),'claude-quiet-test-')),data=join(dir,'data'),cwd=join(dir,'project');await mkdir(cwd);
  const old=process.env.CHILL_AGENT_DATA_DIR;process.env.CHILL_AGENT_DATA_DIR=data;
  t.after(async()=>{if(old===undefined)delete process.env.CHILL_AGENT_DATA_DIR;else process.env.CHILL_AGENT_DATA_DIR=old;await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});});
  const conversation=async()=>{
    const sessionId=randomUUID(),event=hookFor({session_id:sessionId,prompt_id:randomUUID(),cwd}),envFile=join(dir,`${sessionId}.env`);await writeFile(envFile,'');
    const record=await captureClaudeEntry(event('SessionStart',{source:'startup'}),{cwd,env:{CLAUDE_ENV_FILE:envFile}});
    const env={CHILL_AGENT_HARNESS:'claude-code',CHILL_AGENT_SESSION_ID:sessionId,CHILL_AGENT_CONNECTION_GENERATION:record.generation};
    return {sessionId,event,hook:(name,patch)=>quietClaudeHook(event(name,patch)),act:(action,payload)=>runClaudeAction(action,payload,{env}),
      quiet:()=>existsSync(claudeQuietPath(data,sessionId)),record:()=>readJson(claudeEntryPaths(data,sessionId).record)};
  };
  return {dir,data,conversation};
}

test('a conversation that never owned a Goal goes quiet, and owning one wakes its hooks at once',async t=>{
  const s=await store(t),c=await s.conversation();
  assert.equal(await c.hook('SessionStart',{source:'startup'}),false,'SessionStart is always handled');
  assert.equal(c.quiet(),true,'it owns nothing, so later hooks may end early');
  assert.equal(await c.hook('PreToolUse',{tool_name:'Read',tool_input:{}}),true);
  // Starting chill midway: the conversation creates its first Goal.
  await c.act('create-goal',{title:'Start midway',scope:'Test',criteria:'Hooks run'});
  assert.equal(c.quiet(),false);assert.equal((await c.record()).owned,true);
  assert.equal(await c.hook('PostToolUse',{tool_name:'Bash',tool_input:{},tool_response:{}}),false);
  assert.equal(await c.hook('SessionStart',{source:'resume'}),false);assert.equal(c.quiet(),false,'an owner never goes quiet again');
});

test('a continued conversation that adopts a Goal wakes, and the earlier owner never goes quiet',async t=>{
  const s=await store(t),first=await s.conversation(),next=await s.conversation();
  await first.act('create-goal',{title:'Carry over',scope:'Test',criteria:'Adopted'});
  await next.hook('SessionStart',{source:'startup'});assert.equal(next.quiet(),true);
  await next.act('adopt',{goalId:(await listGoals())[0].id});
  assert.equal(next.quiet(),false);
  await first.hook('SessionStart',{source:'resume'});
  assert.equal(first.quiet(),false,'feedback saved for the earlier owner still reaches it');
});

test('a subagent hook or an ID the launcher cannot read is never quiet',async t=>{
  const s=await store(t),c=await s.conversation();
  await c.hook('SessionStart',{source:'startup'});
  assert.equal(await quietClaudeHook(c.event('PreToolUse',{agent_id:'a1',tool_name:'Read',tool_input:{}})),false);
  assert.equal(claudeQuietPath(s.data,'odd/id'),null);
  assert.equal(await quietClaudeHook(c.event('PreToolUse',{session_id:'odd/id',tool_name:'Read',tool_input:{}})),false);
});

test('the launcher ends a quiet conversation\'s hooks before Node starts and passes any other input to Node intact',{skip:process.platform==='win32'&&'the launcher runs in Git Bash there; covered by the POSIX run'},async t=>{
  const s=await store(t),root=fileURLToPath(new URL('../',import.meta.url));
  const prepared=await prepareRuntime(root,s.data);
  const sessionId=randomUUID(),input=JSON.stringify({session_id:sessionId,transcript_path:'/example/session.jsonl',cwd:s.dir,hook_event_name:'PreToolUse',tool_name:'Bash',tool_input:{command:'echo "$HOME" `id` \\ CHILL_HOOK_INPUT'}});
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^chill_agent_data_dir$/i.test(key)));
  const run=(text,extra={})=>execFileSync(prepared.entry,['connection','claude-hook'],{input:text,env:{...env,...extra},encoding:'utf8'});
  // Node gets the hook: it finds a conversation that owns nothing and marks it.
  run(input);
  assert.equal(existsSync(claudeQuietPath(s.data,sessionId)),true,'Node read the input and marked the conversation quiet');
  // Now no Node is needed: only cat is on PATH and the recorded Node is gone.
  const bin=join(s.dir,'bin');await mkdir(bin);await symlink(execFileSync('sh',['-c','command -v cat'],{encoding:'utf8'}).trim(),join(bin,'cat'));
  const {readFile}=await import('node:fs/promises');
  const script=await readFile(prepared.entry,'utf8');await writeFile(prepared.entry,script.replace(/^node=.*$/m,"node='/missing/bin/node'"),{mode:0o700});
  assert.equal(run(input,{PATH:bin}),'','a quiet hook exits 0 before Node');
  const start=JSON.stringify({session_id:sessionId,transcript_path:'/example/session.jsonl',cwd:s.dir,hook_event_name:'SessionStart',source:'startup'});
  assert.throws(()=>run(start,{PATH:bin}),error=>error.status===127,'SessionStart always goes to Node');
});
