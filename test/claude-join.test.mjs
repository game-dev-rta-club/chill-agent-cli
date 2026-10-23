import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {captureClaudeEntry,claudeEntryPaths,identifyClaudeCaller} from '../lib/claude-entry.mjs';
import {joinClaudeConversation,runClaudeAction,hasSavedClaudeFeedback} from '../lib/claude-actions.mjs';
import {appendFeedback,createGoal,listGoals,listStoredGoals,readGoal,updateGoal} from '../lib/goal-store.mjs';
import {readJson,writeJsonAtomically} from '../lib/storage.mjs';
import {projectRoot,sameProject} from '../lib/project-root.mjs';
import {projectDirectory} from '../lib/project-workspace.mjs';
import {configureClaudeHooks} from '../lib/claude-setup.mjs';
import {claudeHook} from './claude-fixtures.mjs';

async function fixture(t) {
  const dir=await realpath(await mkdtemp(join(tmpdir(),'chill-claude-join-')));
  const previous=process.env.CHILL_AGENT_DATA_DIR;
  process.env.CHILL_AGENT_DATA_DIR=join(dir,'data');
  t.after(async()=>{if(previous===undefined)delete process.env.CHILL_AGENT_DATA_DIR;else process.env.CHILL_AGENT_DATA_DIR=previous;await rm(dir,{recursive:true,force:true});});
  const cwd=join(dir,'project');await mkdir(cwd);
  return {dir,cwd,join:env=>joinClaudeConversation({env,cwd})};
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
const act=async(action,payload,env)=>(await runClaudeAction(action,payload,{env})).text;

test('a running conversation joins from its shell, then creates a Goal without SessionStart',async t=>{
  const f=await fixture(t),env={CLAUDE_CODE_SESSION_ID:'native-session'};
  await assert.rejects(identifyClaudeCaller({env}),/not connected yet.*connection join/);
  assert.match(await f.join(env),/Connected this Claude conversation/);
  const caller=await identifyClaudeCaller({env});
  assert.equal(caller.identity.sessionId,'native-session');assert.equal(caller.source,'join');
  // A second join keeps the same connection.
  assert.match(await f.join(env),/already connected/);
  assert.equal((await identifyClaudeCaller({env})).identity.generation,caller.identity.generation);
  assert.match(await act('create-goal',{title:'Joined mid-conversation',scope:'',criteria:''},env),/Created Goal/);
  const [goal]=await listGoals();
  assert.equal(goal.connection.sessionId,'native-session');assert.equal(goal.connection.contextId,caller.contextId);
});

test('join needs the session Claude names in the shell and keeps a SessionStart connection',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.join({}),/did not name this conversation/);
  const envFile=join(f.dir,'env');await writeFile(envFile,'');
  const started=await captureClaudeEntry(claudeHook('SessionStart',{session_id:'started',source:'startup',cwd:f.cwd}),{cwd:f.cwd,env:{CLAUDE_ENV_FILE:envFile}});
  assert.match(await f.join({CLAUDE_CODE_SESSION_ID:'started'}),/already connected/);
  const caller=await identifyClaudeCaller({env:{CLAUDE_CODE_SESSION_ID:'started'}});
  assert.equal(caller.identity.generation,started.generation);assert.equal(caller.contextId,started.contextId);
});

test('a linked worktree is its main checkout: one store and shared hooks',async t=>{
  const f=await fixture(t),{main,worktree}=await repository(f.dir),other=join(f.dir,'other');await mkdir(other);
  assert.equal(await projectRoot(worktree),main);
  assert.equal(await projectRoot(main),main);
  assert.equal(await projectRoot(other),other);
  assert.equal(await projectDirectory(worktree,join(f.dir,'base')),await projectDirectory(main,join(f.dir,'base')));
  assert.equal(await sameProject(worktree,main),true);
  assert.equal(await sameProject(other,main),false);
  // The main checkout's hook runs for a conversation in the worktree.
  const envFile=join(f.dir,'env');await writeFile(envFile,'');
  assert.ok(await captureClaudeEntry(claudeHook('SessionStart',{session_id:'in-worktree',source:'startup',cwd:worktree}),{cwd:main,env:{CLAUDE_ENV_FILE:envFile}}));
  // Setup from the worktree writes the main checkout's local settings, which Claude loads in both.
  const status=await configureClaudeHooks(worktree,{entry:join(f.dir,'data','runtime','chill')});
  assert.equal(status.settingsPath,join(main,'.claude','settings.local.json'));
});

test('a continued conversation takes over a Root and receives earlier saved feedback',async t=>{
  const f=await fixture(t);
  const connect=async sessionId=>{const env={CLAUDE_CODE_SESSION_ID:sessionId};await f.join(env);return env;};
  const before=await connect('earlier'),after=await connect('continued');
  await act('create-goal',{title:'Long running',scope:'',criteria:''},before);
  const [root]=await listGoals();
  const child=await createGoal({title:'Split',parentId:root.id});
  const saved=await appendFeedback({goalId:child.id,text:'Sent while the earlier conversation owned it'});
  const waiting=await appendFeedback({goalId:root.id,text:'Still waiting for a reply'});
  assert.match(await act('adopt',{goalId:child.id},after),/now owns Goal #1/);
  const moved=await readGoal(root.id);
  assert.equal(moved.connection.sessionId,'continued');assert.equal(moved.previousConnections[0].sessionId,'earlier');
  // Taking over writes nothing in Web, so the Root still awaits its reply.
  assert.deepEqual((await listStoredGoals()).find(g=>g.id===root.id).conversation.map(e=>e.id),[waiting.id]);
  // The feedback saved for the earlier owner now reaches the new one, and not the earlier one.
  assert.equal(await hasSavedClaudeFeedback(moved.connection),true);
  assert.match(await act('inbox',{},after),new RegExp(`"eventId":${saved.changeId}`));
  assert.match(await act('inbox',{},before),/Nothing awaits a reply/);
  assert.match(await act('adopt',{goalId:root.id},after),/already owns Goal #1/);
});

test('taking over works while the earlier owner still watches, and is refused for Goals without a Claude owner',async t=>{
  const f=await fixture(t);
  const connect=async sessionId=>{const env={CLAUDE_CODE_SESSION_ID:sessionId};await f.join(env);return env;};
  const before=await connect('owner'),after=await connect('other');
  await act('create-goal',{title:'Owned',scope:'',criteria:''},before);
  const [root]=await listGoals();
  const record=claudeEntryPaths(process.env.CHILL_AGENT_DATA_DIR,'owner').record,current=await readJson(record);
  await writeJsonAtomically(record,{...current,waiter:{contextId:current.contextId,checkedAt:new Date().toISOString()}});
  assert.match(await act('adopt',{goalId:root.id},after),/now owns Goal/);
  assert.equal((await readGoal(root.id)).connection.sessionId,'other');
  const plain=await createGoal({title:'Local only'});
  await assert.rejects(act('adopt',{goalId:plain.id},after),/Only a Goal owned by a Claude conversation/);
  await assert.rejects(act('adopt',{goalId:'x'},after),/Invalid Goal ID/);
});

test('a Split Goal leaves its Root with its history and another conversation takes it over',async t=>{
  const f=await fixture(t);
  const connect=async sessionId=>{const env={CLAUDE_CODE_SESSION_ID:sessionId};await f.join(env);return env;};
  const owner=await connect('owner'),other=await connect('other');
  await act('create-goal',{title:'Everything',scope:'',criteria:''},owner);
  const [root]=await listGoals();
  const web=await createGoal({title:'Web',parentId:root.id}),request=await createGoal({title:'Request',parentId:web.id});
  const handed=await appendFeedback({goalId:request.id,text:'Already handed'});
  assert.match(await act('inbox',{},owner),new RegExp(`"eventId":${handed.changeId}`));
  const ask=await createGoal({title:'Ask',parentId:web.id}),waiting=await appendFeedback({goalId:ask.id,text:'Not handed yet'});
  await assert.rejects(updateGoal(web.id,{parentId:(await createGoal({title:'Elsewhere'})).id}),/Cannot move Goals between native conversations/);
  await updateGoal(web.id,{parentId:null});
  const detached=await readGoal(web.id);
  assert.equal(detached.parentId,null);assert.equal(detached.connection.sessionId,'owner','it stays with the same conversation');
  assert.match(await act('adopt',{goalId:request.id},other),new RegExp(`now owns Goal #${web.id}`));
  assert.equal((await readGoal(root.id)).connection.sessionId,'owner');
  assert.equal((await readGoal(request.id)).parentId,web.id,'its Split Goals and their history go with it');
  const inbox=await act('inbox',{},other);
  assert.match(inbox,new RegExp(`"eventId":${waiting.changeId}`));
  assert.match(inbox,new RegExp(`still awaiting your reply:[\\s\\S]*"eventId":${handed.changeId}`),'a comment already handed is listed as earlier, not handed again');
  assert.match(await act('inbox',{},owner),/Nothing awaits a reply/);
});
