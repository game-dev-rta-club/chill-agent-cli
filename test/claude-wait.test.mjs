import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {readFile,writeFile} from './record-fixture.mjs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {captureClaudeEntry,claudeEntryPaths} from '../lib/claude-entry.mjs';
import {requestClaudeAction,handleClaudeToolHook,hasSavedClaudeFeedback,claudeSessionStartContext} from '../lib/claude-actions.mjs';
import {waitForClaudeFeedback,waitResultText} from '../lib/claude-wait.mjs';
import {readClaudeConnectionStatus} from '../lib/claude-status.mjs';
import {listGoals,appendFeedback,createGoal,readFeedback} from '../lib/goal-store.mjs';
import {readDeliveryState,prepareDelivery,updateDelivery} from '../lib/delivery.mjs';
import {readJson,writeJsonAtomically} from '../lib/storage.mjs';
import {createClaudeFeedbackReader} from '../lib/claude-feedback-cache.mjs';
const writeFeedbackHold=(id,value)=>writeJsonAtomically(join(process.env.CHILL_AGENT_DATA_DIR,'workspace/feedback-holds',`${id}.json`),value);

async function fixture(t) {
 const dir=await mkdtemp(join(tmpdir(),'claude-wait-test-')),data=join(dir,'data'),cwd=join(dir,'project');await mkdir(cwd);
 const old=process.env.CHILL_AGENT_DATA_DIR;process.env.CHILL_AGENT_DATA_DIR=data;
 t.after(async()=>{if(old===undefined)delete process.env.CHILL_AGENT_DATA_DIR;else process.env.CHILL_AGENT_DATA_DIR=old;await rm(dir,{recursive:true,force:true});});
 const envFile=join(dir,'env');await writeFile(envFile,'');
 let record,env;const sessionId=randomUUID(),promptId=randomUUID();
 const event=(name,patch={})=>({hook_event_name:name,session_id:sessionId,prompt_id:promptId,cwd,...patch});
 async function start(source='startup'){record=await captureClaudeEntry(event('SessionStart',{source}),{cwd,env:{CLAUDE_ENV_FILE:envFile}});env={CHILL_AGENT_HARNESS:'claude-code',CHILL_AGENT_SESSION_ID:sessionId,CHILL_AGENT_CONNECTION_GENERATION:record.generation};return record;}
 async function action(name,payload={}) {const r=await requestClaudeAction(name,payload,{env});return handleClaudeToolHook(event('PostToolUse',{tool_name:'Bash',tool_use_id:randomUUID(),tool_response:{stdout:r.marker}}),{cwd});}
 await start();const created=await action('create-goal',{title:'Wait receipt',scope:'Test',criteria:'No duplicate'});const root=(await listGoals())[0];
 const recordPath=claudeEntryPaths(data,sessionId).record;
 // Waiters run until feedback; tests stop the ones that should keep waiting.
 const wait=(opts={})=>{const controller=new AbortController();const done=waitForClaudeFeedback({env,pollMs:10,signal:controller.signal,...opts});return {done,stop:()=>{controller.abort();return done;}};};
 const until=async check=>{for(let i=0;i<200;i++){if(await check())return;await new Promise(r=>setTimeout(r,10));}throw Error('Timed out');};
 const waiting=()=>until(async()=>!!(await readJson(recordPath))?.waiter);
 return {dir,data,cwd,root,created,event,start,action,wait,waiting,until,recordPath,envFile,env:()=>env,connection:{harnessId:'claude-code',sessionId,contextId:record.contextId}};
}
const context=output=>output?.hookSpecificOutput?.additionalContext||'';

test('a saved reply ends the waiter without offering it; the main-hook inbox still claims it once',async t=>{
 const f=await fixture(t),w=f.wait();await f.waiting();
 const reply=await appendFeedback({goalId:f.root.id,text:'after the response ended'});
 assert.deepEqual(await w.done,{status:'feedback'});
 assert.equal(await readDeliveryState(reply.changeId),null,'detecting is not offering');
 assert.equal((await readJson(f.recordPath)).waiter,undefined,'a finished waiter releases its record');
 const text=waitResultText({status:'feedback'});assert.match(text,/connection inbox/);assert.match(text,/connection wait/);
 assert.match(context(await f.action('inbox')),/after the response ended/);assert.equal((await readDeliveryState(reply.changeId)).status,'unknown');
 await f.action('activity',{eventId:reply.changeId,state:'working'});await f.action('activity',{eventId:reply.changeId,state:'completed'});
 assert.doesNotMatch(context(await f.action('inbox')),/after the response ended/,'completed work is not offered again');
});

test('one waiter per context: a second exits, a stale one is replaced',async t=>{
 const f=await fixture(t),first=f.wait();await f.waiting();
 assert.deepEqual(await f.wait().done,{status:'already-running'});
 assert.deepEqual(await first.stop(),{status:'stopped'});
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
 clock+=31000;status=await readClaudeConnectionStatus(f.connection,{now});assert.notEqual(status.state,'waiting');assert.match(status.detail,/No reply waiter is running/);
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
 assert.equal(lines.filter(l=>l.startsWith('export CHILL_AGENT_CONNECTION_GENERATION=')).length,1);
 assert(lines.includes(`export CHILL_AGENT_CONNECTION_GENERATION='${f.env().CHILL_AGENT_CONNECTION_GENERATION}'`));
 assert(lines.includes('export OTHER_HOOK=1'));
});

test('all assigned Goals count; holds, other owners and uncertain offers do not',async t=>{
 const f=await fixture(t),child=await createGoal({title:'Child',parentId:f.root.id});
 const held=await appendFeedback({goalId:f.root.id,text:'held'});await prepareDelivery(held);await updateDelivery(held.changeId,()=>({heldBy:randomUUID()}));
 const uncertain=await appendFeedback({goalId:f.root.id,text:'uncertain'});await prepareDelivery(uncertain);await updateDelivery(uncertain.changeId,()=>({status:'unknown',mayHaveSent:true,nativeOfferId:randomUUID()}));
 const foreign=await createGoal({title:'Foreign'});await appendFeedback({goalId:foreign.id,text:'other owner'});
 assert.equal(await hasSavedClaudeFeedback(f.connection),false);
 await appendFeedback({goalId:child.id,text:'child reply'});assert.equal(await hasSavedClaudeFeedback(f.connection),true);
});

test('cached history still observes manual holds and ownership changes',async t=>{
 const f=await fixture(t),reply=await appendFeedback({goalId:f.root.id,text:'paused'});await prepareDelivery(reply);
 const readEvents=createClaudeFeedbackReader();await readEvents();
 await writeFeedbackHold(f.root.id,{phase:'pending'});assert.equal(await hasSavedClaudeFeedback(f.connection,{readEvents}),false);
 await writeFeedbackHold(f.root.id,{phase:'sent'});assert.equal(await hasSavedClaudeFeedback(f.connection,{readEvents}),true);
 const path=join(f.data,'workspace/goals',f.root.id,'goal.json'),goal=JSON.parse(await readFile(path,'utf8'));
 await writeFile(path,JSON.stringify({...goal,connection:{...goal.connection,contextId:randomUUID()}}));
 assert.equal(await hasSavedClaudeFeedback(f.connection,{readEvents}),false);
});

test('CLI wait prints the next actions once feedback is saved',async t=>{
 const f=await fixture(t),entry=new URL('../bin/chill-connection.mjs',import.meta.url).pathname;
 const p=spawn(process.execPath,[entry,'wait'],{cwd:f.cwd,env:{...process.env,...f.env()},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
 p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);
 await f.waiting();await appendFeedback({goalId:f.root.id,text:'from the Web'});
 const code=await new Promise((resolve,reject)=>{p.on('error',reject);p.on('exit',resolve);});
 assert.equal(code,0);assert.equal(stderr,'');assert.match(stdout,/new Web feedback[\s\S]*connection inbox[\s\S]*connection wait/);
});

test('reply posts on the Web and completes the receipt in one confirmed action',async t=>{
 const f=await fixture(t),reply=await appendFeedback({goalId:f.root.id,text:'Please summarize'});
 await assert.rejects(f.action('reply',{eventId:reply.changeId,text:'Too early'}),/connection inbox first/);
 assert.match(context(await f.action('inbox')),/connection reply --event <eventId>/);
 const done=context(await f.action('reply',{eventId:reply.changeId,text:'Here is the summary.'}));
 assert.match(done,new RegExp(`recorded feedback #${reply.changeId} as completed`));
 const state=await readDeliveryState(reply.changeId);assert.equal(state.status,'completed');assert.equal(state.agentReported,true);
 const posted=(await readFeedback()).filter(e=>e.author==='agent'&&e.goalId===f.root.id);
 assert.deepEqual(posted.map(e=>e.text),['Here is the summary.']);
 await assert.rejects(f.action('reply',{eventId:reply.changeId,text:'Again'}),/terminal receipt/);
 assert.equal((await readFeedback()).filter(e=>e.author==='agent').length,1,'a rejected reply posts nothing');
});
