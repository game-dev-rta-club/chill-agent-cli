import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {readFile,writeFile} from './record-fixture.mjs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {captureClaudeEntry,claudeEntryPaths} from '../lib/claude-entry.mjs';
import {runClaudeAction,handleClaudeToolHook,hasSavedClaudeFeedback,claudeSessionStartContext} from '../lib/claude-actions.mjs';
import {holdClaudeConversation,holdResultText,watchClaudeConversation,watcherWakeText} from '../lib/claude-wait.mjs';
import {readClaudeConnectionStatus} from '../lib/claude-status.mjs';
import {listGoals,appendFeedback,createGoal,readFeedback} from '../lib/goal-store.mjs';
import {deliverFeedback} from '../lib/delivery.mjs';
import {readJson,writeJsonAtomically} from '../lib/storage.mjs';
import {createClaudeFeedbackReader} from '../lib/claude-feedback-cache.mjs';
import {fileURLToPath} from 'node:url';
import {hookFor} from './claude-fixtures.mjs';

const watcherSettings=JSON.stringify({hooks:{Stop:[{hooks:[{type:'command',command:"'/x/chill' connection claude-watch",asyncRewake:true,timeout:604800}]}]}});
async function fixture(t) {
 const dir=await mkdtemp(join(tmpdir(),'claude-wait-test-')),data=join(dir,'data'),cwd=join(dir,'project');await mkdir(join(cwd,'.claude'),{recursive:true});
 // Setup installs the watcher hook with every other hook.
 await writeFile(join(cwd,'.claude/settings.local.json'),watcherSettings);
 const old=process.env.CHILL_AGENT_DATA_DIR;process.env.CHILL_AGENT_DATA_DIR=data;
 t.after(async()=>{if(old===undefined)delete process.env.CHILL_AGENT_DATA_DIR;else process.env.CHILL_AGENT_DATA_DIR=old;await rm(dir,{recursive:true,force:true});});
 const envFile=join(dir,'env');await writeFile(envFile,'');
 let record,env;const sessionId=randomUUID(),promptId=randomUUID();
 const event=hookFor({session_id:sessionId,prompt_id:promptId,cwd});
 async function start(source='startup'){record=await captureClaudeEntry(event('SessionStart',{source}),{cwd,env:{CLAUDE_ENV_FILE:envFile}});env={CHILL_AGENT_HARNESS:'claude-code',CHILL_AGENT_SESSION_ID:sessionId,CHILL_AGENT_CONNECTION_GENERATION:record.generation};return record;}
 async function action(name,payload={}) {const r=await runClaudeAction(name,payload,{env});return {hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:r.text}};}
 await start();const created=await action('create-goal',{title:'Wait receipt',scope:'Test',criteria:'No duplicate'});const root=(await listGoals())[0];
 const recordPath=claudeEntryPaths(data,sessionId).record;
 // Watchers run until feedback and holds until stopped; tests stop the ones that should keep running.
 const run=(start,opts)=>{const controller=new AbortController();const done=start({pollMs:10,signal:controller.signal,...opts});return {done,stop:()=>{controller.abort();return done;}};};
 const wait=(opts={})=>run(o=>watchClaudeConversation({sessionId,...o}),opts),hold=(opts={})=>run(o=>holdClaudeConversation({env,...o}),opts);
 const until=async check=>{for(let i=0;i<200;i++){if(await check())return;await new Promise(r=>setTimeout(r,10));}throw Error('Timed out');};
 const waiting=()=>until(async()=>!!(await readJson(recordPath))?.waiter);
 // The response that created the Goal ends, as a real one does before the user replies.
 const stop=()=>handleClaudeToolHook(event('Stop'),{cwd});
 const tool=(patch={})=>handleClaudeToolHook(event('PostToolUse',{tool_name:'Bash',tool_use_id:randomUUID(),tool_response:{stdout:'work'},...patch}),{cwd});
 return {dir,data,cwd,root,created,event,start,action,stop,tool,wait,hold,waiting,until,recordPath,envFile,env:()=>env,connection:{harnessId:'claude-code',sessionId,contextId:record.contextId}};
}
const context=output=>output?.hookSpecificOutput?.additionalContext||'';

test('the inbox hands saved feedback and lists it until a reply',async t=>{
 const f=await fixture(t);await f.stop();
 const reply=await appendFeedback({goalId:f.root.id,text:'after the response ended'});
 assert.equal(await hasSavedClaudeFeedback(f.connection),true);
 assert.match(context(await f.action('inbox')),/after the response ended/);
 assert.equal(await hasSavedClaudeFeedback(f.connection),false,'handed once');
 await f.action('reply',{goalId:f.root.id,text:'Done'});
 assert.doesNotMatch(context(await f.action('inbox')),/after the response ended/,'an answered Goal is not listed again');
 assert.ok(reply.changeId);
});

test('one watcher per conversation: a second exits, a stale one is replaced',async t=>{
 const f=await fixture(t),first=f.wait({refreshMs:20});await f.waiting();
 assert.deepEqual(await f.wait({livenessMs:300}).done,{status:'already-running'},'a live watcher keeps refreshing');
 assert.deepEqual(await first.stop(),{status:'stopped'});
 assert.equal((await readJson(f.recordPath)).waiter,undefined,'a stopped watcher releases its record at once');
 // A killed watcher leaves a fresh refresh behind; a new one sees it stop advancing and takes over.
 const record=await readJson(f.recordPath),dead=randomUUID();
 await writeJsonAtomically(f.recordPath,{...record,waiter:{id:dead,contextId:record.contextId,checkedAt:new Date().toISOString()}});
 const takeover=f.wait({livenessMs:100});await f.until(async()=>(await readJson(f.recordPath)).waiter?.id!==dead);
 assert.deepEqual(await takeover.stop(),{status:"stopped"});
 // Freshness decides liveness: a watcher that stopped refreshing can be replaced.
 const staleAt=Date.now()-120000,stale=f.wait({now:()=>staleAt});await f.waiting();
 const next=f.wait();assert.deepEqual(await stale.done,{status:'replaced'});await next.stop();
});

test('the watcher refreshes its record; status reports it and falls back when it stops',async t=>{
 const f=await fixture(t);let clock=1_000_000;const now=()=>clock;
 const w=f.wait({now});await f.waiting();
 let status=await readClaudeConnectionStatus(f.connection,{now});assert.equal(status.state,'waiting');
 clock+=31000;await f.until(async()=>Date.parse((await readJson(f.recordPath)).waiter.checkedAt)===clock);
 await w.stop();assert.notEqual((await readClaudeConnectionStatus(f.connection,{now})).state,'waiting');
 // A watcher that was killed leaves its last refresh behind until it is stale.
 const record=await readJson(f.recordPath);await writeJsonAtomically(f.recordPath,{...record,waiter:{id:randomUUID(),contextId:record.contextId,checkedAt:new Date(clock).toISOString()}});
 clock+=60000;assert.equal((await readClaudeConnectionStatus(f.connection,{now})).state,'waiting');
 clock+=31000;status=await readClaudeConnectionStatus(f.connection,{now});assert.notEqual(status.state,'waiting');assert.match(status.detail,/No watcher is running/);
});

test('outside Claude Desktop nothing asks for connection wait',async t=>{
 const f=await fixture(t);assert.doesNotMatch(context(f.created),/connection wait/);
 assert.doesNotMatch(context(await f.action('inbox')),/connection wait/);
 assert.equal(await f.stop(),null);
 assert.equal(await claudeSessionStartContext(await f.start('resume')),null,'a resumed owner without a running watcher');
});

test('compact keeps a running watcher; a cleared context owns no Goals',async t=>{
 const f=await fixture(t),w=f.wait();await f.waiting();
 await f.start('compact');assert.equal(await claudeSessionStartContext(await readJson(f.recordPath)),null);
 assert(await readJson(f.recordPath).then(r=>r.waiter),'the watcher survives compact');
 await w.stop();assert.equal(await claudeSessionStartContext(await f.start('clear')),null);
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

test('CLI wait holds the conversation until stopped and releases its hold',{skip:process.platform==='win32'&&'Windows ends the process on kill without running its signal handler'},async t=>{
 const f=await fixture(t);await f.stop();const entry=fileURLToPath(new URL('../bin/chill-connection.mjs',import.meta.url));
 const p=spawn(process.execPath,[entry,'wait'],{cwd:f.cwd,env:{...process.env,CLAUDE_CODE_SESSION_ID:f.env().CHILL_AGENT_SESSION_ID,...f.env()},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
 p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);
 await f.until(async()=>!!(await readJson(f.recordPath)).hold);await appendFeedback({goalId:f.root.id,text:'from the Web'});
 await new Promise(r=>setTimeout(r,50));assert.equal(p.exitCode,null,'the hold does not end for feedback');
 const exited=new Promise((resolve,reject)=>{p.on('error',reject);p.on('exit',resolve);});p.kill('SIGTERM');
 assert.equal(await exited,0);assert.equal(stderr,'');assert.match(stdout,/Start it again as a background task[\s\S]*connection wait/);
 assert.equal((await readJson(f.recordPath)).hold,undefined);
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

test('a prompt the user types in the conversation resumes a Web pause; Claude Code\'s own wakes do not',async t=>{
 const {setClaudePause,readClaudePause}=await import('../lib/claude-pause.mjs');
 const f=await fixture(t),prompt=patch=>handleClaudeToolHook(f.event('UserPromptSubmit',patch)),paused=async()=>(await readClaudePause(f.connection)).paused;
 await setClaudePause(f.connection,true);
 await prompt({prompt:'<task-notification>\n<task-id>a1</task-id>\n</task-notification>',source:'system'});
 assert.equal(await paused(),true,'a task notice is no resume');
 await prompt({prompt:'chill-agent: the check you scheduled is due',source:'schedule_wakeup'});
 assert.equal(await paused(),true,'a scheduled wake is no resume');
 await prompt({prompt:'Go on with the fix',source:'user'});
 assert.equal(await paused(),false,'the user wrote here, so the work continues without the Web');
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

test('a Goal whose ended response scheduled a check shows Waiting, and Check overdue long past it',async t=>{
 const {scheduleClaudeWake}=await import('../lib/claude-wake.mjs');
 const {claudeAgent}=await import('../lib/agents/claude.mjs');
 const {activityDisplay,isWaitingOnCheck}=await import('../public/work-ui.js');
 const {recordClaudeWork}=await import('../lib/claude-agent-work.mjs');
 const f=await fixture(t);await recordClaudeWork(f.connection.sessionId,[{type:'started'},{type:'commented',goalId:f.root.id},{type:'finished'}],{directory:f.data});
 const agent=claudeAgent((await listGoals()).find(g=>g.id===f.root.id));
 assert.equal((await agent.activity(f.root.id)).wake,undefined);assert.equal((await agent.presence()).wake,undefined);
 const {wake}=await scheduleClaudeWake({minutes:10,reason:'CI of PR #91',env:f.env()});
 const activity=await agent.activity(f.root.id);
 assert.deepEqual(activity.wake,{at:wake.at,reason:'CI of PR #91'});
 const shown=activityDisplay(activity,Date.parse(wake.at)-60000);
 assert.equal(shown.state,'waiting');assert.equal(shown.label,'Waiting');assert.match(shown.description,/^CI of PR #91\. Checks again at \d{1,2}:\d{2} [AP]M\.$/);
 assert.equal(activityDisplay(activity,Date.parse(wake.at)+10*60000).label,'Check overdue');
 // The tab icon reads the same check from presence: yellow until it is overdue.
 const presence=await agent.presence();assert.deepEqual(presence.wake,{at:wake.at,reason:'CI of PR #91'});
 assert.equal(isWaitingOnCheck(presence.wake,Date.parse(wake.at)-60000),true);assert.equal(isWaitingOnCheck(presence.wake,Date.parse(wake.at)+10*60000),false);
});

test('with several checks scheduled, the Web shows the next one due',async t=>{
 const {scheduleClaudeWake}=await import('../lib/claude-wake.mjs');
 const {claudeAgent}=await import('../lib/agents/claude.mjs');
 const {activityDisplay,isWaitingOnCheck}=await import('../public/work-ui.js');
 const {recordClaudeWork}=await import('../lib/claude-agent-work.mjs');
 const f=await fixture(t);await recordClaudeWork(f.connection.sessionId,[{type:'started'},{type:'commented',goalId:f.root.id},{type:'finished'}],{directory:f.data});
 const agent=claudeAgent((await listGoals()).find(g=>g.id===f.root.id));
 await scheduleClaudeWake({minutes:2*24*60,reason:'Recount',env:f.env()});
 const {wake}=await scheduleClaudeWake({minutes:15,reason:'CI of PR #91',env:f.env()});
 await scheduleClaudeWake({minutes:60,reason:'Deploy',env:f.env()});
 const activity=await agent.activity(f.root.id),presence=await agent.presence();
 assert.deepEqual(activity.wake,{at:wake.at,reason:'CI of PR #91'});assert.deepEqual(presence.wake,{at:wake.at,reason:'CI of PR #91'});
 assert.match(activityDisplay(activity,Date.parse(wake.at)-60000).description,/^CI of PR #91\. Checks again at /);
 assert.equal(isWaitingOnCheck(presence.wake,Date.parse(wake.at)-60000),true,'the tab icon shows the yellow sun');
});

test('a scheduled check wakes the conversation through its watcher when it is due, once',async t=>{
 const {scheduleClaudeWake}=await import('../lib/claude-wake.mjs');
 const f=await fixture(t);let clock=Date.now();const now=()=>clock;
 await assert.rejects(scheduleClaudeWake({minutes:0,env:f.env()}),/whole minutes/);
 const {wake}=await scheduleClaudeWake({minutes:10,reason:'CI of PR #91',env:f.env(),now});
 assert.equal(Date.parse(wake.at)-clock,600000);
 const w=f.wait({now});await f.waiting();
 await new Promise(r=>setTimeout(r,50));
 assert.equal((await readJson(f.recordPath)).wakes[0].reason,'CI of PR #91','not due yet: the watcher keeps waiting');
 clock+=600000;
 assert.deepEqual(await w.done,{status:'wake',reason:'CI of PR #91'});
 assert.equal((await readJson(f.recordPath)).wakes,undefined,'a due check is removed, so it wakes once');
 assert.match(watcherWakeText({status:'wake',reason:'CI of PR #91'}),/check you scheduled is due \(CI of PR #91\)[\s\S]*connection wake/);
 await assert.rejects(scheduleClaudeWake({cancel:true,env:f.env(),now}),/whole minutes/,'there is no cancel');
 // Compact and resume keep the checks; a cleared context starts without them.
 await scheduleClaudeWake({minutes:5,reason:'Later',env:f.env(),now});
 await f.start('compact');assert.deepEqual((await readJson(f.recordPath)).wakes.map(w=>w.reason),['Later']);
 await f.start('resume');assert.equal((await readJson(f.recordPath)).wakes.length,1);
 await f.start('clear');assert.equal((await readJson(f.recordPath)).wakes,undefined);
});

test('the watcher hook hands saved feedback over and wakes the model with it',async t=>{
 const f=await fixture(t);await f.stop();const w=f.wait();await f.waiting();
 await appendFeedback({goalId:f.root.id,text:'from the Web'});
 const result=await w.done;
 assert.equal(result.status,'feedback');assert.match(watcherWakeText(result),/from the Web/);assert.match(result.text,/connection reply --goal/);
 assert.equal((await readJson(f.recordPath)).agentWork.phase,'working','the wake starts the work');
 assert.equal((await readJson(f.recordPath)).waiter,undefined);
 assert.equal(await hasSavedClaudeFeedback(f.connection),false,'the next watcher does not wake for it again');
});

test('a watcher that stops checking ends as stalled, and the next watcher takes over its record',async t=>{
 const f=await fixture(t);
 // A poll that outlasts the stall limit stands in for I/O that never settles.
 const stuck=f.wait({pollMs:60000,stallMs:100});await f.waiting();const stuckId=(await readJson(f.recordPath)).waiter.id;
 const result=await stuck.done;assert.deepEqual(result,{status:'stalled'});
 assert.match(watcherWakeText(result),/stopped responding[\s\S]*connection inbox/);
 const next=f.wait({livenessMs:100});
 await f.until(async()=>(await readJson(f.recordPath)).waiter?.id!==stuckId);
 await appendFeedback({goalId:f.root.id,text:'after the stall'});
 assert.match((await next.done).text,/after the stall/,'the conversation is woken again');
 await stuck.stop();
});

test('a watcher whose Claude Code process ended leaves feedback unclaimed',async t=>{
 const f=await fixture(t);let attached=true;const w=f.wait({attached:()=>attached});await f.waiting();
 attached=false;
 assert.deepEqual(await w.done,{status:'detached'});
 const reply=await appendFeedback({goalId:f.root.id,text:'nobody is listening'});
 assert.equal(await hasSavedClaudeFeedback(f.connection),true,'still waiting to be handed');assert.ok(reply);
 assert.equal((await readJson(f.recordPath)).waiter,undefined);
});

test('the watcher hook follows a cleared context and ends when the conversation owns no Goal',async t=>{
 const f=await fixture(t),w=f.wait();await f.waiting();
 await f.start('clear');
 assert.deepEqual(await w.done,{status:'not-owner'},'a fresh context owns nothing to wait for');
 assert.equal((await readJson(f.recordPath)).waiter,undefined);
});

test('each check wakes the conversation once, earliest first, with its own reason',async t=>{
 const {scheduleClaudeWake}=await import('../lib/claude-wake.mjs');
 const f=await fixture(t);
 let clock=Date.now();const now=()=>clock;
 // A recount in two days is scheduled first; a CI check in 15 minutes does not replace it.
 await scheduleClaudeWake({minutes:2*24*60,reason:'Recount',env:f.env(),now});
 const {wake,wakes}=await scheduleClaudeWake({minutes:15,reason:'CI of PR #91',env:f.env(),now});
 assert.equal(wake.reason,'CI of PR #91');
 assert.deepEqual(wakes.map(w=>w.reason),['CI of PR #91','Recount'],'both stay, earliest first');
 // A second check for the same thing is added beside the first.
 await scheduleClaudeWake({minutes:30,reason:'CI again',env:f.env(),now});
 assert.deepEqual((await readJson(f.recordPath)).wakes.map(w=>w.reason),['CI of PR #91','CI again','Recount']);
 clock+=15*60000;
 assert.deepEqual(await f.wait({now}).done,{status:'wake',reason:'CI of PR #91'});
 const later=f.wait({now});await f.waiting();await new Promise(r=>setTimeout(r,50));
 assert.equal((await readJson(f.recordPath)).wakes.length,2,'the next checks are not due yet');
 clock+=15*60000;
 assert.deepEqual(await later.done,{status:'wake',reason:'CI again'});
 clock+=2*24*60*60000;
 assert.deepEqual(await f.wait({now}).done,{status:'wake',reason:'Recount'});
 assert.equal((await readJson(f.recordPath)).wakes,undefined);
});

test('checks that fell due while the machine slept wake the conversation one per wake, in due order',async t=>{
 const {scheduleClaudeWake}=await import('../lib/claude-wake.mjs');
 const f=await fixture(t);
 let clock=Date.now();const now=()=>clock;
 await scheduleClaudeWake({minutes:20,reason:'Third',env:f.env(),now});
 await scheduleClaudeWake({minutes:5,reason:'First',env:f.env(),now});
 await scheduleClaudeWake({minutes:10,reason:'Second',env:f.env(),now});
 clock+=8*60*60000;
 assert.deepEqual(await f.wait({now}).done,{status:'wake',reason:'First'});
 assert.deepEqual(await f.wait({now}).done,{status:'wake',reason:'Second'});
 assert.deepEqual(await f.wait({now}).done,{status:'wake',reason:'Third'});
 assert.equal((await readJson(f.recordPath)).currentGoal,undefined,'a wake chooses no Goal for the conversation');
 assert.deepEqual(await f.wait({maxMs:50}).done,{status:'idle'},'nothing is left to wake for');
});

test('a check that falls due while a response runs waits for its end',async t=>{
 const {scheduleClaudeWake}=await import('../lib/claude-wake.mjs');
 const {applyWork,recordClaudeWork,recordedWork}=await import('../lib/claude-agent-work.mjs');
 const f=await fixture(t);let clock=Date.now(),starting=false;
 // The response starts and the check falls due at the same moment: the watcher
 // asks the clock right after it read the record, which still shows no work.
 const now=()=>{
  if(starting){starting=false;const r=JSON.parse(readFileSync(f.recordPath,'utf8'));writeFileSync(f.recordPath,JSON.stringify({...r,agentWork:applyWork(recordedWork(r),[{type:'started',fresh:true}])}));clock+=60000;}
  return clock;
 };
 await scheduleClaudeWake({minutes:1,reason:'CI',env:f.env(),now});
 const w=f.wait({now});await f.waiting();
 starting=true;await f.until(()=>!starting);await new Promise(r=>setTimeout(r,80));
 assert.equal((await readJson(f.recordPath)).wakes.length,1,'due, but the response still runs');
 await recordClaudeWork(f.connection.sessionId,[{type:'finished'}],{directory:f.data});
 assert.deepEqual(await w.done,{status:'wake',reason:'CI'});
});

test('connection show lists the pending checks: due time and reason',async t=>{
 const {scheduleClaudeWake}=await import('../lib/claude-wake.mjs');
 const f=await fixture(t);
 const late=(await scheduleClaudeWake({minutes:60,reason:'Recount',env:f.env()})).wake,soon=(await scheduleClaudeWake({minutes:10,reason:'CI',env:f.env()})).wake;
 // A Goal stored on a check by an earlier version is ignored.
 const record=await readJson(f.recordPath);await writeJsonAtomically(f.recordPath,{...record,wakes:record.wakes.map((w,i)=>i?w:{...w,goalId:f.root.id})});
 const bin=fileURLToPath(new URL('../bin/chill-connection.mjs',import.meta.url));
 const run=(...args)=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[bin,...args],{cwd:f.cwd,env:{...process.env,...f.env(),CHILL_AGENT_DATA_DIR:f.data,CLAUDE_CODE_SESSION_ID:f.connection.sessionId}});let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);child.on('close',code=>code?reject(Error(err)):resolve(JSON.parse(out)));});
 const shown=await run('show');
 assert.deepEqual(shown.wakes,[{at:soon.at,reason:'CI'},{at:late.at,reason:'Recount'}]);
 await assert.rejects(run('wake','--in','5','--reason','CI','--goal',f.root.id),/--goal/,'a check names no Goal');
});

test('the watcher hook wakes for a due check and ends itself before its hook timeout',async t=>{
 const {scheduleClaudeWake}=await import('../lib/claude-wake.mjs');
 const f=await fixture(t);let clock=Date.now();const now=()=>clock;
 await scheduleClaudeWake({minutes:1,reason:'CI',env:f.env(),now});
 const w=f.wait({now});await f.waiting();clock+=60000;
 const due=await w.done;assert.deepEqual(due,{status:'wake',reason:'CI'});assert.match(watcherWakeText(due),/due \(CI\)\. Do it now/);
 const idle=await f.wait({maxMs:50}).done;
 assert.deepEqual(idle,{status:'idle'});assert.match(watcherWakeText(idle),/Nothing to do/);
});

test('hooks that predate the watcher are told to rerun setup, not to start a task',async t=>{
 const f=await fixture(t);await writeFile(join(f.cwd,'.claude/settings.local.json'),'{}');
 const text=context(await claudeSessionStartContext(await f.start('resume')));
 assert.match(text,/predate the reply watcher[\s\S]*setup prepare --harness claude-code[\s\S]*restart/);assert.doesNotMatch(text,/connection wait/);
});

test('in Claude Desktop a task holds the conversation and the watcher hook hands the feedback',async t=>{
 const f=await fixture(t);
 process.env.CLAUDE_CODE_ENTRYPOINT='claude-desktop';t.after(()=>{delete process.env.CLAUDE_CODE_ENTRYPOINT;});
 // Desktop pauses an idle conversation with only the hook watching, so the agent is asked for a task.
 assert.match(context(await claudeSessionStartContext(await f.start('resume'))),/owns chill-agent Goals[\s\S]*connection wait/);
 const hook=f.wait({refreshMs:20});await f.waiting();
 assert.match(context(await f.action('inbox')),/run_in_background[\s\S]*connection wait/);
 const stop=await f.stop();assert.equal(stop.decision,'block');assert.match(stop.reason,/keeps it from pausing[\s\S]*run_in_background[\s\S]*connection wait/);
 assert.equal(await handleClaudeToolHook(f.event('Stop',{stop_hook_active:true}),{cwd:f.cwd}),null,'asked once per stop');
 // The task holds the conversation beside the hook, which keeps watching.
 const task=f.hold({refreshMs:20});
 await f.until(async()=>!!(await readJson(f.recordPath)).hold);
 assert.ok((await readJson(f.recordPath)).waiter,'the hook keeps watching');
 const second=await f.hold({livenessMs:200}).done;
 assert.deepEqual(second,{status:'already-running'});assert.match(holdResultText(second),/already keeps this conversation/);
 assert.doesNotMatch(context(await f.action('inbox')),/connection wait/);
 assert.equal(await f.stop(),null);
 assert.equal(await claudeSessionStartContext(await f.start('compact')),null,'a running task survives compact');
 // Feedback wakes the model through the hook, with its text; the task keeps holding.
 await appendFeedback({goalId:f.root.id,text:'from the Web'});
 const woke=await hook.done;assert.equal(woke.status,'feedback');assert.match(watcherWakeText(woke),/from the Web/);
 assert.equal(await hasSavedClaudeFeedback(f.connection),false,'the hook claimed it');
 await new Promise(r=>setTimeout(r,50));assert.ok((await readJson(f.recordPath)).hold,'the task does not end for feedback');
 const ended=await task.stop();assert.deepEqual(ended,{status:'stopped'});assert.match(holdResultText(ended),/Start it again as a background task[\s\S]*connection wait/);
 assert.equal((await readJson(f.recordPath)).hold,undefined,'a stopped task releases its hold');
});
