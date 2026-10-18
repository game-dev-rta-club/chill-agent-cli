import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {readFile,writeFile} from './record-fixture.mjs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {captureClaudeEntry,claudeEntryPaths} from '../lib/claude-entry.mjs';
import {runClaudeAction,handleClaudeToolHook,hasSavedClaudeFeedback,claudeSessionStartContext} from '../lib/claude-actions.mjs';
import {waitForClaudeFeedback,waitResultText,watchClaudeConversation,watcherWakeText} from '../lib/claude-wait.mjs';
import {readClaudeConnectionStatus} from '../lib/claude-status.mjs';
import {listGoals,appendFeedback,createGoal,readFeedback} from '../lib/goal-store.mjs';
import {deliverFeedback} from '../lib/delivery.mjs';
import {readJson,writeJsonAtomically} from '../lib/storage.mjs';
import {createClaudeFeedbackReader} from '../lib/claude-feedback-cache.mjs';
import {fileURLToPath} from 'node:url';
import {hookFor} from './claude-fixtures.mjs';

async function fixture(t) {
 const dir=await mkdtemp(join(tmpdir(),'claude-wait-test-')),data=join(dir,'data'),cwd=join(dir,'project');await mkdir(cwd);
 const old=process.env.CHILL_AGENT_DATA_DIR;process.env.CHILL_AGENT_DATA_DIR=data;
 t.after(async()=>{if(old===undefined)delete process.env.CHILL_AGENT_DATA_DIR;else process.env.CHILL_AGENT_DATA_DIR=old;await rm(dir,{recursive:true,force:true});});
 const envFile=join(dir,'env');await writeFile(envFile,'');
 let record,env;const sessionId=randomUUID(),promptId=randomUUID();
 const event=hookFor({session_id:sessionId,prompt_id:promptId,cwd});
 async function start(source='startup'){record=await captureClaudeEntry(event('SessionStart',{source}),{cwd,env:{CLAUDE_ENV_FILE:envFile}});env={CHILL_AGENT_HARNESS:'claude-code',CHILL_AGENT_SESSION_ID:sessionId,CHILL_AGENT_CONNECTION_GENERATION:record.generation};return record;}
 async function action(name,payload={}) {const r=await runClaudeAction(name,payload,{env});return {hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:r.text}};}
 await start();const created=await action('create-goal',{title:'Wait receipt',scope:'Test',criteria:'No duplicate'});const root=(await listGoals())[0];
 const recordPath=claudeEntryPaths(data,sessionId).record;
 // Waiters run until feedback; tests stop the ones that should keep waiting.
 const wait=(opts={})=>{const controller=new AbortController();const done=waitForClaudeFeedback({env,pollMs:10,signal:controller.signal,...opts});return {done,stop:()=>{controller.abort();return done;}};};
 const until=async check=>{for(let i=0;i<200;i++){if(await check())return;await new Promise(r=>setTimeout(r,10));}throw Error('Timed out');};
 const waiting=()=>until(async()=>!!(await readJson(recordPath))?.waiter);
 // The response that created the Goal ends, as a real one does before the user replies.
 const stop=()=>handleClaudeToolHook(event('Stop'),{cwd});
 const tool=(patch={})=>handleClaudeToolHook(event('PostToolUse',{tool_name:'Bash',tool_use_id:randomUUID(),tool_response:{stdout:'work'},...patch}),{cwd});
 return {dir,data,cwd,root,created,event,start,action,stop,tool,wait,waiting,until,recordPath,envFile,env:()=>env,connection:{harnessId:'claude-code',sessionId,contextId:record.contextId}};
}
const context=output=>output?.hookSpecificOutput?.additionalContext||'';

test('a saved reply ends the waiter without handing it; the inbox then hands it and lists it until a reply',async t=>{
 const f=await fixture(t);await f.stop();const w=f.wait();await f.waiting();
 const reply=await appendFeedback({goalId:f.root.id,text:'after the response ended'});
 assert.deepEqual(await w.done,{status:'feedback'});
 assert.equal(await hasSavedClaudeFeedback(f.connection),true,'detecting is not handing');
 assert.equal((await readJson(f.recordPath)).waiter,undefined,'a finished waiter releases its record');
 const text=waitResultText({status:'feedback'});assert.match(text,/connection inbox/);assert.match(text,/connection wait/);
 assert.match(context(await f.action('inbox')),/after the response ended/);
 assert.equal(await hasSavedClaudeFeedback(f.connection),false,'handed once');
 await f.action('reply',{goalId:f.root.id,text:'Done'});
 assert.doesNotMatch(context(await f.action('inbox')),/after the response ended/,'an answered Goal is not listed again');
 assert.ok(reply.changeId);
});

test('one waiter per context: a second exits, a stale one is replaced',async t=>{
 const f=await fixture(t),first=f.wait({refreshMs:20});await f.waiting();
 assert.deepEqual(await f.wait({livenessMs:300}).done,{status:'already-running'},'a live waiter keeps refreshing');
 assert.deepEqual(await first.stop(),{status:'stopped'});
 assert.equal((await readJson(f.recordPath)).waiter,undefined,'a stopped waiter releases its record at once');
 // A killed waiter leaves a fresh refresh behind; a new waiter sees it stop advancing and takes over.
 const record=await readJson(f.recordPath),dead=randomUUID();
 await writeJsonAtomically(f.recordPath,{...record,waiter:{id:dead,contextId:record.contextId,checkedAt:new Date().toISOString()}});
 const takeover=f.wait({livenessMs:100});await f.until(async()=>(await readJson(f.recordPath)).waiter?.id!==dead);
 assert.deepEqual(await takeover.stop(),{status:"stopped"});
 // Freshness decides liveness: a waiter that stopped refreshing can be replaced.
 const staleAt=Date.now()-120000,stale=f.wait({now:()=>staleAt});await f.waiting();
 const next=f.wait();assert.deepEqual(await stale.done,{status:'replaced'});await next.stop();
});

test('the waiter refreshes its record; status reports it and falls back when it stops',async t=>{
 const f=await fixture(t);let clock=1_000_000;const now=()=>clock;
 const w=f.wait({now});await f.waiting();
 let status=await readClaudeConnectionStatus(f.connection,{now});assert.equal(status.state,'waiting');
 clock+=31000;await f.until(async()=>Date.parse((await readJson(f.recordPath)).waiter.checkedAt)===clock);
 await w.stop();assert.notEqual((await readClaudeConnectionStatus(f.connection,{now})).state,'waiting');
 // A waiter that was killed leaves its last refresh behind until it is stale.
 const record=await readJson(f.recordPath);await writeJsonAtomically(f.recordPath,{...record,waiter:{id:randomUUID(),contextId:record.contextId,checkedAt:new Date(clock).toISOString()}});
 clock+=60000;assert.equal((await readClaudeConnectionStatus(f.connection,{now})).state,'waiting');
 clock+=31000;status=await readClaudeConnectionStatus(f.connection,{now});assert.notEqual(status.state,'waiting');assert.match(status.detail,/No watcher is running/);
});

test('the next action names the waiter only while none is running',async t=>{
 const f=await fixture(t);assert.match(context(f.created),/connection wait/);
 const w=f.wait();await f.waiting();
 assert.doesNotMatch(context(await f.action('inbox')),/connection wait/);
 await w.stop();assert.match(context(await f.action('inbox')),/run_in_background/);
});

test('resume and compact keep a running waiter; only a resumed owner is told to start one',async t=>{
 const f=await fixture(t),w=f.wait();await f.waiting();
 await f.start('compact');assert.equal(await claudeSessionStartContext(await readJson(f.recordPath)),null,'a waiter survives compact');
 assert(await readJson(f.recordPath).then(r=>r.waiter));
 await w.stop();const resumed=await f.start('resume');
 assert.match(context(await claudeSessionStartContext(resumed)),/owns chill-agent Goals[\s\S]*connection wait/);
 assert.equal(await claudeSessionStartContext(await f.start('clear')),null,'a cleared context owns no Goals');
});

test('a waiter ends when its conversation context changes',async t=>{
 const f=await fixture(t),w=f.wait();await f.waiting();await f.start('clear');
 assert.deepEqual(await w.done,{status:'context-changed'});
});

test('repeated SessionStart keeps one set of exports and preserves other hooks',async t=>{
 const f=await fixture(t);await writeFile(f.envFile,`${await readFile(f.envFile,'utf8')}export OTHER_HOOK=1\n`);
 await f.start('resume');await f.start('compact');
 const lines=(await readFile(f.envFile,'utf8')).trim().split('\n');
 assert.equal(lines.filter(l=>l.startsWith('export CHILL_AGENT_SESSION_ID=')).length,1);
 assert.equal(lines.filter(l=>l.startsWith('export CHILL_AGENT_CONNECTION_GENERATION=')).length,0,'agents never carry the generation');
 assert(lines.includes('export OTHER_HOOK=1'));
});

test('all owned Goals count; other owners and handed comments do not',async t=>{
 const f=await fixture(t),child=await createGoal({title:'Child',parentId:f.root.id});
 await appendFeedback({goalId:f.root.id,text:'handed'});await f.action('inbox');
 const foreign=await createGoal({title:'Foreign'});await appendFeedback({goalId:foreign.id,text:'other owner'});
 assert.equal(await hasSavedClaudeFeedback(f.connection),false);
 await appendFeedback({goalId:child.id,text:'child reply'});assert.equal(await hasSavedClaudeFeedback(f.connection),true);
});

test('cached history still observes ownership changes',async t=>{
 const f=await fixture(t);await appendFeedback({goalId:f.root.id,text:'saved'});
 const readEvents=createClaudeFeedbackReader();await readEvents();
 assert.equal(await hasSavedClaudeFeedback(f.connection,{readEvents}),true);
 const path=join(f.data,'workspace/goals',f.root.id,'goal.json'),goal=JSON.parse(await readFile(path,'utf8'));
 await writeFile(path,JSON.stringify({...goal,connection:{...goal.connection,contextId:randomUUID()}}));
 assert.equal(await hasSavedClaudeFeedback(f.connection,{readEvents}),false);
});

test('CLI wait prints the next actions once feedback is saved',async t=>{
 const f=await fixture(t);await f.stop();const entry=fileURLToPath(new URL('../bin/chill-connection.mjs',import.meta.url));
 const p=spawn(process.execPath,[entry,'wait'],{cwd:f.cwd,env:{...process.env,CLAUDE_CODE_SESSION_ID:f.env().CHILL_AGENT_SESSION_ID,...f.env()},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
 p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);
 await f.waiting();await appendFeedback({goalId:f.root.id,text:'from the Web'});
 const code=await new Promise((resolve,reject)=>{p.on('error',reject);p.on('exit',resolve);});
 assert.equal(code,0);assert.equal(stderr,'');assert.match(stdout,/new Web feedback[\s\S]*connection inbox[\s\S]*connection wait/);
});

test('the claude-watch hook exits 2 with the feedback, which Claude Code shows the model',async t=>{
 const f=await fixture(t);await f.stop();const entry=fileURLToPath(new URL('../bin/chill-connection.mjs',import.meta.url));
 const p=spawn(process.execPath,[entry,'claude-watch'],{cwd:f.cwd,env:process.env,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';
 p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);
 p.stdin.end(JSON.stringify(f.event('Stop')));
 await f.waiting();await appendFeedback({goalId:f.root.id,text:'from the Web'});
 const code=await new Promise((resolve,reject)=>{p.on('error',reject);p.on('exit',resolve);});
 assert.equal(code,2);assert.equal(stdout,'');assert.match(stderr,/from the Web[\s\S]*connection reply --goal/);
});

test('reply posts on the Goal on the Web and answers it',async t=>{
 const f=await fixture(t);await appendFeedback({goalId:f.root.id,text:'Please summarize'});
 assert.match(context(await f.action('inbox')),/connection reply --goal <goalId>/);
 const done=context(await f.action('reply',{goalId:f.root.id,text:'Here is the summary.'}));
 assert.match(done,new RegExp(`Replied on Goal #${f.root.id}`));
 const posted=(await readFeedback()).filter(e=>e.author==='agent'&&e.goalId===f.root.id);
 assert.deepEqual(posted.map(e=>e.text),['Here is the summary.']);
 assert.equal((await deliverFeedback((await readFeedback()).find(e=>e.author==='user').changeId)).mark,null);
});

test('a Web pause holds feedback, refuses tool calls and survives compact; Resume wakes once',async t=>{
 const {setClaudePause,readClaudePause,claudePauseGuard}=await import('../lib/claude-pause.mjs');
 const f=await fixture(t),tool=name=>claudePauseGuard(f.event('PreToolUse',{tool_name:name}));
 assert.equal(await tool('Read'),null,'nothing is refused before a pause');
 await setClaudePause(f.connection,true);
 await appendFeedback({goalId:f.root.id,text:'sent while paused'});
 assert.equal(await hasSavedClaudeFeedback(f.connection),false,'the waiter does not wake for held feedback');
 assert.doesNotMatch(context(await f.action('inbox')),/sent while paused/);
 assert.equal((await tool('Read')).hookSpecificOutput.permissionDecision,'deny');
 await f.start('compact');assert.equal((await readClaudePause({...f.connection})).paused,true,'compact keeps the pause');
 await setClaudePause(f.connection,false);
 assert.equal(await tool('Bash'),null);
 assert.equal(await hasSavedClaudeFeedback(f.connection),true,'Resume wakes the conversation');
 const resumed=context(await f.action('inbox'));assert.match(resumed,/selected Resume/);assert.match(resumed,/sent while paused/);
 assert.doesNotMatch(context(await f.action('inbox')),/selected Resume/,'the resume notice is delivered once');
});

test('Approve all answers permission prompts for its conversation only while on, and survives compact',async t=>{
 const {setClaudeApproveAll,readClaudeApproveAll,claudePermissionDecision}=await import('../lib/claude-permissions.mjs');
 const f=await fixture(t),prompt=()=>claudePermissionDecision(f.event('PermissionRequest',{tool_name:'mcp__computer-use__request_access'}));
 assert.equal(await prompt(),null,'prompts ask normally by default');
 await setClaudeApproveAll(f.connection,true);
 assert.equal((await prompt()).hookSpecificOutput.decision.behavior,'allow');
 await f.start('compact');assert.equal(await readClaudeApproveAll(f.connection),true);
 assert.equal(await claudePermissionDecision(f.event('PermissionRequest',{session_id:'other-session'})),null);
 await setClaudeApproveAll(f.connection,false);assert.equal(await prompt(),null);
 await assert.rejects(setClaudeApproveAll(f.connection,'yes'),/On or Off/);
});

test('Claude feedback lists open Letters with their close command, as Codex delivery does',async t=>{
 const {appendAgentComment}=await import('../lib/goal-store.mjs');
 const f=await fixture(t);
 const letter=await appendAgentComment({goalId:f.root.id,type:'letter',title:'Pick one',text:'A or B?'});
 await appendFeedback({goalId:f.root.id,text:'B, thanks'});
 const text=context(await f.action('inbox'));
 assert.match(text,/Open Letters/);assert.match(text,new RegExp(`goal close-letter --id ${f.root.id} --event ${letter.id}`));
});

test('a scheduled check wakes the conversation through its waiter when it is due, once',async t=>{
 const {scheduleClaudeWake}=await import('../lib/claude-wake.mjs');
 const f=await fixture(t);let clock=Date.now();const now=()=>clock;
 await assert.rejects(scheduleClaudeWake({minutes:0,env:f.env()}),/whole minutes/);
 const {wake}=await scheduleClaudeWake({minutes:10,reason:'CI of PR #91',env:f.env(),now});
 assert.equal(Date.parse(wake.at)-clock,600000);
 const w=f.wait({now});await f.waiting();
 await new Promise(r=>setTimeout(r,50));
 assert.equal((await readJson(f.recordPath)).wake.reason,'CI of PR #91','not due yet: the waiter keeps waiting');
 clock+=600000;
 assert.deepEqual(await w.done,{status:'wake',reason:'CI of PR #91'});
 assert.equal((await readJson(f.recordPath)).wake,undefined,'a due check is cleared, so it wakes once');
 assert.match(waitResultText({status:'wake',reason:'CI of PR #91'}),/check you scheduled is due \(CI of PR #91\)[\s\S]*connection wake[\s\S]*connection wait/);
 // Cancelling removes a scheduled check.
 await scheduleClaudeWake({minutes:5,env:f.env(),now});
 assert.deepEqual(await scheduleClaudeWake({cancel:true,env:f.env(),now}),{wake:null});
 assert.equal((await readJson(f.recordPath)).wake,undefined);
});

const watch=(f,opts={})=>{const controller=new AbortController();const done=watchClaudeConversation({sessionId:f.connection.sessionId,hook:true,pollMs:10,signal:controller.signal,...opts});return {done,stop:()=>{controller.abort();return done;}};};

test('the watcher hook hands saved feedback over and wakes the model with it',async t=>{
 const f=await fixture(t);await f.stop();const w=watch(f);await f.waiting();
 assert.equal((await readJson(f.recordPath)).waiter.kind,'hook');assert.equal((await readJson(f.recordPath)).hookWatcher,true);
 await appendFeedback({goalId:f.root.id,text:'from the Web'});
 const result=await w.done;
 assert.equal(result.status,'feedback');assert.match(watcherWakeText(result),/from the Web/);assert.match(result.text,/connection reply --goal/);
 assert.equal((await readJson(f.recordPath)).agentWork.phase,'working','the wake starts the work');
 assert.equal((await readJson(f.recordPath)).waiter,undefined);
 assert.equal(await hasSavedClaudeFeedback(f.connection),false,'the next watcher does not wake for it again');
});

test('a hook watcher takes over from a connection wait task; a second hook watcher exits',async t=>{
 const f=await fixture(t),task=f.wait();await f.waiting();
 const w=watch(f,{refreshMs:20});
 assert.deepEqual(await task.done,{status:'replaced'});
 assert.deepEqual(await watch(f,{livenessMs:200}).done,{status:'already-running'},'a live hook watcher keeps its claim');
 assert.deepEqual(await w.stop(),{status:'stopped'});
});

test('a watcher whose Claude Code process ended leaves feedback unclaimed',async t=>{
 const f=await fixture(t);let attached=true;const w=watch(f,{attached:()=>attached});await f.waiting();
 attached=false;
 assert.deepEqual(await w.done,{status:'detached'});
 const reply=await appendFeedback({goalId:f.root.id,text:'nobody is listening'});
 assert.equal(await hasSavedClaudeFeedback(f.connection),true,'still waiting to be handed');assert.ok(reply);
 assert.equal((await readJson(f.recordPath)).waiter,undefined);
});

test('the watcher hook follows a cleared context and ends when the conversation owns no Goal',async t=>{
 const f=await fixture(t),w=watch(f);await f.waiting();
 await f.start('clear');
 assert.deepEqual(await w.done,{status:'not-owner'},'a fresh context owns nothing to wait for');
 assert.equal((await readJson(f.recordPath)).waiter,undefined);
});

test('the watcher hook wakes for a due check and ends itself before its hook timeout',async t=>{
 const {scheduleClaudeWake}=await import('../lib/claude-wake.mjs');
 const f=await fixture(t);let clock=Date.now();const now=()=>clock;
 await scheduleClaudeWake({minutes:1,reason:'CI',env:f.env(),now});
 const w=watch(f,{now});await f.waiting();clock+=60000;
 const due=await w.done;assert.deepEqual(due,{status:'wake',reason:'CI'});assert.match(watcherWakeText(due),/due \(CI\)\. Do it now/);
 const idle=await watch(f,{maxMs:50}).done;
 assert.deepEqual(idle,{status:'idle'});assert.match(watcherWakeText(idle),/Nothing to do/);
});

test('with the watcher hook installed, nothing tells the agent to start a waiter',async t=>{
 const f=await fixture(t);
 assert.match(context(await f.action('inbox')),/connection wait/,'older setups still name the waiter');
 await mkdir(join(f.cwd,'.claude'),{recursive:true});
 await writeFile(join(f.cwd,'.claude/settings.local.json'),JSON.stringify({hooks:{Stop:[{hooks:[{type:'command',command:"'/x/chill' connection claude-watch",asyncRewake:true,timeout:604800}]}]}}));
 assert.equal(await claudeSessionStartContext(await f.start('resume')),null);
 assert.equal((await readJson(f.recordPath)).hookWatcher,true);
 assert.doesNotMatch(context(await f.action('inbox')),/connection wait/);
});

test('in Claude Desktop the agent runs the waiter as a task, which the watcher hook gives way to',async t=>{
 const f=await fixture(t);
 await mkdir(join(f.cwd,'.claude'),{recursive:true});
 await writeFile(join(f.cwd,'.claude/settings.local.json'),JSON.stringify({hooks:{Stop:[{hooks:[{type:'command',command:"'/x/chill' connection claude-watch",asyncRewake:true,timeout:604800}]}]}}));
 process.env.CLAUDE_CODE_ENTRYPOINT='claude-desktop';t.after(()=>{delete process.env.CLAUDE_CODE_ENTRYPOINT;});
 // Desktop pauses an idle conversation with only the hook watching, so the agent is asked for a task.
 assert.match(context(await claudeSessionStartContext(await f.start('resume'))),/owns chill-agent Goals[\s\S]*connection wait/);
 const hook=watch(f,{refreshMs:20});await f.waiting();
 assert.match(context(await f.action('inbox')),/run_in_background[\s\S]*connection wait/);
 const stop=await f.stop();assert.equal(stop.decision,'block');assert.match(stop.reason,/run_in_background[\s\S]*connection wait/);
 assert.equal(await handleClaudeToolHook(f.event('Stop',{stop_hook_active:true}),{cwd:f.cwd}),null,'asked once per stop');
 // The task takes over; the hook ends quietly, and a later hook stands by.
 const task=f.wait({refreshMs:20});
 assert.deepEqual(await hook.done,{status:'replaced'});assert.equal(watcherWakeText({status:'replaced'}),'');
 await f.until(async()=>(await readJson(f.recordPath)).waiter?.kind===undefined);
 assert.deepEqual(await watch(f,{livenessMs:200}).done,{status:'already-running'});
 assert.doesNotMatch(context(await f.action('inbox')),/connection wait/);
 assert.equal(await f.stop(),null);
 assert.equal(await claudeSessionStartContext(await f.start('compact')),null,'a running task survives compact');
 // Feedback ends the task, which tells the agent to read it and start the waiter again.
 await appendFeedback({goalId:f.root.id,text:'from the Web'});
 const result=await task.done;assert.equal(result.status,'feedback');assert.match(waitResultText(result),/connection inbox[\s\S]*connection wait/);
});
