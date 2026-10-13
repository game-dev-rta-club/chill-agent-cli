import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {captureClaudeEntry,identifyClaudeCaller} from '../lib/claude-entry.mjs';
import {requestClaudeJoin,requestClaudeAction,confirmClaudeAction} from '../lib/claude-actions.mjs';
import {listGoals} from '../lib/goal-store.mjs';
import {projectRoot,sameProject} from '../lib/project-root.mjs';
import {projectDirectory} from '../lib/project-workspace.mjs';
import {configureClaudeHooks} from '../lib/claude-setup.mjs';

async function fixture(t) {
  const dir=await realpath(await mkdtemp(join(tmpdir(),'chill-claude-join-')));
  const previous=process.env.CHILL_AGENT_DATA_DIR;
  process.env.CHILL_AGENT_DATA_DIR=join(dir,'data');
  t.after(async()=>{if(previous===undefined)delete process.env.CHILL_AGENT_DATA_DIR;else process.env.CHILL_AGENT_DATA_DIR=previous;await rm(dir,{recursive:true,force:true});});
  const cwd=join(dir,'project');await mkdir(cwd);
  const hook=(sessionId,marker,patch={})=>({hook_event_name:'PostToolUse',session_id:sessionId,cwd,tool_use_id:randomUUID(),tool_name:'Bash',prompt_id:randomUUID(),tool_response:{stdout:marker,interrupted:false},...patch});
  return {dir,cwd,hook,confirm:input=>confirmClaudeAction(input,{cwd})};
}
// A linked worktree as Git lays it out: a .git file pointing into the main
// checkout's .git/worktrees/<name>, whose commondir leads back to .git.
async function repository(dir) {
  const main=join(dir,'main'),worktree=join(dir,'wt'),admin=join(main,'.git','worktrees','wt');
  await mkdir(admin,{recursive:true});await mkdir(worktree);
  await writeFile(join(admin,'commondir'),'../..\n');
  await writeFile(join(worktree,'.git'),`gitdir: ${admin}\n`);
  return {main,worktree};
}
const context=output=>output?.hookSpecificOutput?.additionalContext;

test('a running conversation joins through its own main hook, then creates a Goal without SessionStart',async t=>{
  const f=await fixture(t),env={CLAUDE_CODE_SESSION_ID:'native-session'};
  await assert.rejects(identifyClaudeCaller({env}),/not connected yet.*connection join/);
  const request=await requestClaudeJoin({env});
  // Neither a subagent nor another session can complete the claim.
  assert.equal(await f.confirm(f.hook('native-session',request.marker,{agent_id:'child'})),null);
  await assert.rejects(f.confirm(f.hook('other-session',request.marker)),/different conversation/);
  await assert.rejects(identifyClaudeCaller({env}),/not connected yet/);
  assert.match(context(await f.confirm(f.hook('native-session',request.marker))),/Connected this Claude conversation/);
  const caller=await identifyClaudeCaller({env});
  assert.equal(caller.identity.sessionId,'native-session');assert.equal(caller.source,'join');
  // A replayed hook is silent; a second join keeps the same connection.
  assert.equal(await f.confirm(f.hook('native-session',request.marker)),null);
  const again=await requestClaudeJoin({env});
  assert.match(context(await f.confirm(f.hook('native-session',again.marker))),/already connected/);
  assert.equal((await identifyClaudeCaller({env})).identity.generation,caller.identity.generation);
  const create=await requestClaudeAction('create-goal',{title:'Joined mid-conversation',scope:'',criteria:''},{env});
  assert.match(context(await f.confirm(f.hook('native-session',create.marker))),/Created Goal/);
  const [goal]=await listGoals();
  assert.equal(goal.connection.sessionId,'native-session');assert.equal(goal.connection.contextId,caller.contextId);
});

test('join needs the session Claude names in the shell and keeps a SessionStart connection',async t=>{
  const f=await fixture(t);
  await assert.rejects(requestClaudeJoin({env:{}}),/did not name this conversation/);
  const envFile=join(f.dir,'env');await writeFile(envFile,'');
  const started=await captureClaudeEntry({hook_event_name:'SessionStart',session_id:'started',source:'startup',cwd:f.cwd},{cwd:f.cwd,env:{CLAUDE_ENV_FILE:envFile}});
  const request=await requestClaudeJoin({env:{CLAUDE_CODE_SESSION_ID:'started'}});
  assert.match(context(await f.confirm(f.hook('started',request.marker))),/already connected/);
  const caller=await identifyClaudeCaller({env:{CLAUDE_CODE_SESSION_ID:'started'}});
  assert.equal(caller.identity.generation,started.generation);assert.equal(caller.contextId,started.contextId);
});

test('a linked worktree is its main checkout: one store, shared hooks and accepted hook directories',async t=>{
  const f=await fixture(t),{main,worktree}=await repository(f.dir),other=join(f.dir,'other');await mkdir(other);
  assert.equal(await projectRoot(worktree),main);
  assert.equal(await projectRoot(main),main);
  assert.equal(await projectRoot(other),other);
  assert.equal(await projectDirectory(worktree,join(f.dir,'base')),await projectDirectory(main,join(f.dir,'base')));
  assert.equal(await sameProject(worktree,main),true);
  assert.equal(await sameProject(other,main),false);
  // The main checkout's hook runs for a conversation in the worktree.
  const envFile=join(f.dir,'env');await writeFile(envFile,'');
  assert.ok(await captureClaudeEntry({hook_event_name:'SessionStart',session_id:'in-worktree',source:'startup',cwd:worktree},{cwd:main,env:{CLAUDE_ENV_FILE:envFile}}));
  await assert.rejects(captureClaudeEntry({hook_event_name:'SessionStart',session_id:'elsewhere',source:'startup',cwd:other},{cwd:main,env:{CLAUDE_ENV_FILE:envFile}}),/does not match/);
  // Setup from the worktree writes the main checkout's local settings, which Claude loads in both.
  const status=await configureClaudeHooks(worktree,{entry:join(f.dir,'data','runtime','chill')});
  assert.equal(status.settingsPath,join(main,'.claude','settings.local.json'));
});
