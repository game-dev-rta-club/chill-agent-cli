import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {captureClaudeEntry} from '../lib/claude-entry.mjs';
import {requestClaudeAction,handleClaudeToolHook} from '../lib/claude-actions.mjs';
import {startClaudeIdleWatch,startClaudeResumeWatch,pollClaudeIdleWatch} from '../lib/claude-idle.mjs';
import {listGoals,appendFeedback,createGoal} from '../lib/goal-store.mjs';
import {readDeliveryState,prepareDelivery,updateDelivery} from '../lib/delivery.mjs';
import {writeJsonAtomically} from '../lib/storage.mjs';
import {createClaudeFeedbackReader} from '../lib/claude-feedback-cache.mjs';
const writeFeedbackHold=(id,value)=>writeJsonAtomically(join(process.env.CHILL_AGENT_DATA_DIR,'workspace/feedback-holds',`${id}.json`),value);

async function fixture(t) {
 const dir=await mkdtemp(join(tmpdir(),'claude-idle-test-')),data=join(dir,'data'),cwd=join(dir,'project');await mkdir(cwd);
 const old=process.env.CHILL_AGENT_DATA_DIR;process.env.CHILL_AGENT_DATA_DIR=data;
 t.after(async()=>{if(old===undefined)delete process.env.CHILL_AGENT_DATA_DIR;else process.env.CHILL_AGENT_DATA_DIR=old;await rm(dir,{recursive:true,force:true});});
 const envFile=join(dir,'env');await writeFile(envFile,'');
 let record,env,promptId=randomUUID();const sessionId=randomUUID();
 const event=(name,patch={})=>({hook_event_name:name,session_id:sessionId,prompt_id:promptId,cwd,...patch});
 async function start(source='startup'){record=await captureClaudeEntry(event('SessionStart',{source}),{cwd,env:{CLAUDE_ENV_FILE:envFile}});env={CHILL_AGENT_HARNESS:'claude-code',CHILL_AGENT_SESSION_ID:sessionId,CHILL_AGENT_CONNECTION_GENERATION:record.generation};}
 async function action(name,payload={},patch={}) {const r=await requestClaudeAction(name,payload,{env});return handleClaudeToolHook(event('PostToolUse',{tool_name:'Bash',tool_use_id:randomUUID(),tool_response:{stdout:r.marker},...patch}),{cwd});}
 const stop=()=>handleClaudeToolHook(event('Stop'),{cwd});
 const watch=opts=>startClaudeIdleWatch(event('Stop'),{cwd,...opts});
 await start();await action('create-goal',{title:'Idle receipt',scope:'Test',criteria:'No duplicate'});const root=(await listGoals())[0];
 return {dir,data,cwd,root,event,start,action,stop,watch,newPrompt:()=>{promptId=randomUUID();}};
}

test('one verified Stop owns one wake; duplicates and tool hooks cannot reoffer input',async t=>{
 const f=await fixture(t);assert.equal((await f.watch()).status,'pending-checkpoint');await f.stop();
 const [a,b]=await Promise.all([f.watch(),f.watch()]);const active=[a,b].find(x=>x.status==='watching');assert(active);assert.equal([a,b].filter(x=>x.status==='watching').length,1);
 const reply=await appendFeedback({goalId:f.root.id,text:'after stop'});
 const answers=await Promise.all([pollClaudeIdleWatch(active.ticket),pollClaudeIdleWatch(active.ticket)]);
 assert.equal(answers.filter(x=>x.status==='offered').length,1);assert.match(answers.find(x=>x.context).context,/after stop/);
 assert.equal((await readDeliveryState(reply.changeId)).status,'unknown');assert.equal((await f.watch()).status,'inactive');
 assert.equal(await handleClaudeToolHook(f.event('PostToolUse',{tool_name:'Read',tool_use_id:randomUUID()}),{cwd:f.cwd}),null);
 await f.action('activity',{eventId:reply.changeId,state:'working'});await f.action('activity',{eventId:reply.changeId,state:'completed'});
 assert.equal((await readDeliveryState(reply.changeId)).status,'completed');
});

test('a finite watch expires without renewal; a fresh verified prompt can watch again',async t=>{
 const f=await fixture(t);await f.stop();const {ticket}=await f.watch({now:()=>1000,timeoutMs:1000});
 assert.equal((await pollClaudeIdleWatch(ticket,{now:()=>1999})).status,'watching');
 assert.equal((await pollClaudeIdleWatch(ticket,{now:()=>2000})).status,'expired');
 const e=await appendFeedback({goalId:f.root.id,text:'late'});assert.equal((await f.watch()).status,'inactive');assert.equal((await pollClaudeIdleWatch(ticket)).status,'inactive');assert.equal(await readDeliveryState(e.changeId),null);
 f.newPrompt();await f.action('create-goal',{title:'Next',scope:'',criteria:''});assert.equal((await readDeliveryState(e.changeId)).status,'unknown');await f.stop();await appendFeedback({goalId:f.root.id,text:'next idle reply'});const next=await f.watch();const result=await pollClaudeIdleWatch(next.ticket);assert.equal(result.status,'offered');assert.doesNotMatch(result.context,/"text":"late"/);
});

test('a twelve-hour watch still receives a late reply once and respects a late manual hold',async t=>{
 const f=await fixture(t);await f.stop();const started=Date.now(),duration=12*60*60*1000;
 const {ticket}=await f.watch({now:()=>started,timeoutMs:duration}),readEvents=createClaudeFeedbackReader();
 assert.equal(ticket.expiresAt,started+duration);
 assert.equal((await pollClaudeIdleWatch(ticket,{now:()=>started+11*60*60*1000,readEvents})).status,'watching');
 const reply=await appendFeedback({goalId:f.root.id,text:'reply before morning'});
 await writeFeedbackHold(f.root.id,{phase:'pending'});
 assert.equal((await pollClaudeIdleWatch(ticket,{now:()=>ticket.expiresAt-2,readEvents})).status,'watching');
 assert.equal(await readDeliveryState(reply.changeId),null);
 await writeFeedbackHold(f.root.id,{phase:'sent'});
 const result=await pollClaudeIdleWatch(ticket,{now:()=>ticket.expiresAt-1,readEvents});
 assert.equal(result.status,'offered');assert.match(result.context,/reply before morning/);
 assert.equal((await pollClaudeIdleWatch(ticket,{now:()=>ticket.expiresAt-1,readEvents})).status,'inactive');
});

test('sleeping past a day-long deadline leaves a reply saved without renewing or waking',async t=>{
 const f=await fixture(t);await f.stop();const started=Date.now();
 const {ticket}=await f.watch({now:()=>started,timeoutMs:86400000});
 const reply=await appendFeedback({goalId:f.root.id,text:'while asleep'});
 assert.equal((await pollClaudeIdleWatch(ticket,{now:()=>started+86400001})).status,'expired');
 assert.equal(await readDeliveryState(reply.changeId),null);
 assert.equal((await f.watch({now:()=>started+86400002,timeoutMs:86400000})).status,'inactive');
});

test('new input, exit and session generation changes revoke old watches',async t=>{
 for(const trigger of ['UserPromptSubmit','SessionEnd','resume','clear'])await t.test(trigger,async t=>{
  const f=await fixture(t);await f.stop();const {ticket}=await f.watch();
  if(['resume','clear'].includes(trigger))await f.start(trigger);else await handleClaudeToolHook(f.event(trigger),{cwd:f.cwd});
  const e=await appendFeedback({goalId:f.root.id,text:'remain saved'});await prepareDelivery(e);
  assert.equal((await pollClaudeIdleWatch(ticket)).status,'inactive',trigger);assert.equal((await f.watch()).status,'inactive',trigger);assert.equal((await readDeliveryState(e.changeId)).status,'saved');
 });
});

test('all assigned Goals are eligible; holds, other owners and uncertain offers stay untouched',async t=>{
 const f=await fixture(t),child=await createGoal({title:'Child',parentId:f.root.id});await f.action('create-goal',{title:'Second',scope:'',criteria:''});const second=(await listGoals()).at(-1);
 const held=await appendFeedback({goalId:f.root.id,text:'held'});await prepareDelivery(held);await updateDelivery(held.changeId,()=>({heldBy:randomUUID()}));
 const uncertain=await appendFeedback({goalId:f.root.id,text:'uncertain'});await prepareDelivery(uncertain);await updateDelivery(uncertain.changeId,()=>({status:'unknown',mayHaveSent:true,nativeOfferId:randomUUID()}));
 const foreign=await createGoal({title:'Foreign'});await appendFeedback({goalId:foreign.id,text:'other owner'});
 await appendFeedback({goalId:child.id,text:'child reply'});await appendFeedback({goalId:second.id,text:'second reply'});
 await f.stop();const {ticket}=await f.watch(),result=await pollClaudeIdleWatch(ticket);assert.equal(result.status,'offered');assert.match(result.context,/child reply/);assert.match(result.context,/second reply/);assert.doesNotMatch(result.context,/"text":"held"|uncertain|other owner/);
 assert.equal((await readDeliveryState(held.changeId)).status,'saved');assert.equal((await readDeliveryState(uncertain.changeId)).status,'unknown');
});

test('Root manual hold suppresses wake and release preserves the same saved event',async t=>{
 const f=await fixture(t);const e=await appendFeedback({goalId:f.root.id,text:'paused'});await prepareDelivery(e);
 await writeFeedbackHold(f.root.id,{phase:'pending'});await f.stop();const {ticket}=await f.watch();
 assert.equal((await pollClaudeIdleWatch(ticket)).status,'watching');assert.equal((await readDeliveryState(e.changeId)).status,'saved');
 await writeFeedbackHold(f.root.id,{phase:'sent'});assert.equal((await pollClaudeIdleWatch(ticket)).status,'offered');
});

test('cached history still observes manual release and uncertain receipts without a new event',async t=>{
 const f=await fixture(t),reply=await appendFeedback({goalId:f.root.id,text:'cached pending reply'});await prepareDelivery(reply);
 const readEvents=createClaudeFeedbackReader();await readEvents();
 await writeFeedbackHold(f.root.id,{phase:'pending'});await f.stop();const {ticket}=await f.watch();
 assert.equal((await pollClaudeIdleWatch(ticket,{readEvents})).status,'watching');
 // Ownership/hold records are deliberately outside the event cache.
 await updateDelivery(reply.changeId,()=>({status:'unknown',mayHaveSent:true}));
 await writeFeedbackHold(f.root.id,{phase:'sent'});
 assert.equal((await pollClaudeIdleWatch(ticket,{readEvents})).status,'watching');
 assert.equal((await readDeliveryState(reply.changeId)).status,'unknown');
 const second=await appendFeedback({goalId:f.root.id,text:'release without a new event'});await prepareDelivery(second);
 await writeFeedbackHold(f.root.id,{phase:'pending'});assert.equal((await pollClaudeIdleWatch(ticket,{readEvents})).status,'watching');
 await writeFeedbackHold(f.root.id,{phase:'sent'});
 const result=await pollClaudeIdleWatch(ticket,{readEvents});assert.equal(result.status,'offered');
 assert.match(result.context,/release without a new event/);assert.doesNotMatch(result.context,/cached pending reply/);
});

test('cached history cannot offer a reply after its Root changes connection',async t=>{
 const f=await fixture(t);await appendFeedback({goalId:f.root.id,text:'old context'});
 const readEvents=createClaudeFeedbackReader();await readEvents();await f.stop();const {ticket}=await f.watch();
 const path=join(f.data,'workspace/goals',f.root.id,'goal.json'),goal=JSON.parse(await readFile(path,'utf8'));
 await writeJsonAtomically(path,{...goal,connection:{...goal.connection,contextId:randomUUID()}});
 assert.equal((await pollClaudeIdleWatch(ticket,{readEvents})).status,'watching');
});

test('subagent, wrong event, missing prompt and wrong directory cannot start a watch',async t=>{
 const f=await fixture(t);await f.stop();
 for(const patch of [{agent_id:'child'},{agent_id:''},{hook_event_name:'PostToolUse'},{prompt_id:null},{prompt_id:randomUUID()}])assert.equal((await startClaudeIdleWatch(f.event('Stop',patch),{cwd:f.cwd})).status,'inactive');
 await assert.rejects(startClaudeIdleWatch(f.event('Stop'),{cwd:f.dir}),/directory/);
 for(const timeoutMs of [0,999,86400001,Infinity,NaN,1000.5])await assert.rejects(f.watch({timeoutMs}),/timeout/);
});

test('CLI emits exit 2 exactly once for an offer, then remains silent',async t=>{
 const f=await fixture(t);await f.stop();await appendFeedback({goalId:f.root.id,text:'CLI wake'});
 const entry=new URL('../bin/chill-connection.mjs',import.meta.url).pathname;
 async function run(){const p=spawn(process.execPath,[entry,'claude-watch','--timeout-ms','1000'],{cwd:f.cwd,env:process.env,stdio:['pipe','pipe','pipe']});let stdout='',stderr='';p.stdout.on('data',b=>stdout+=b);p.stderr.on('data',b=>stderr+=b);p.stdin.end(JSON.stringify(f.event('Stop')));const code=await new Promise((resolve,reject)=>{p.on('error',reject);p.on('exit',resolve);});return {code,stdout,stderr};}
 const first=await run();assert.equal(first.code,2);assert.equal(first.stdout,'');assert.match(first.stderr,/CLI wake/);
 assert.deepEqual(await run(),{code:0,stdout:'',stderr:''});
});

test('a confirmed action lacking native prompt identity still revokes an old idle watch',async t=>{
 const f=await fixture(t);await f.stop();const {ticket}=await f.watch();
 await f.action('create-goal',{title:'Missing prompt',scope:'',criteria:''},{prompt_id:null});
 await appendFeedback({goalId:f.root.id,text:'remain saved'});
 assert.equal((await pollClaudeIdleWatch(ticket)).status,'inactive');assert.equal((await f.watch()).status,'inactive');
});


test('ordinary resume watches existing context without a prompt and offers only once',async t=>{
 const f=await fixture(t);await f.start('resume');
 const input=f.event('SessionStart',{source:'resume'});
 const a=await startClaudeResumeWatch(input,{cwd:f.cwd});assert.equal(a.status,'watching');
 assert.equal((await startClaudeResumeWatch(input,{cwd:f.cwd})).status,'inactive');
 await appendFeedback({goalId:f.root.id,text:'resume without typing'});
 const result=await pollClaudeIdleWatch(a.ticket);assert.equal(result.status,'offered');assert.match(result.context,/resume without typing/);
 assert.equal((await pollClaudeIdleWatch(a.ticket)).status,'inactive');
});
test('resume watch is revoked by typing or exit and cannot adopt a fresh context',async t=>{
 for(const event of ['UserPromptSubmit','SessionEnd']){
  const f=await fixture(t);await f.start('resume');const {ticket}=await startClaudeResumeWatch(f.event('SessionStart',{source:'resume'}),{cwd:f.cwd});
  await handleClaudeToolHook(f.event(event),{cwd:f.cwd});assert.equal((await pollClaudeIdleWatch(ticket)).status,'inactive');
 }
 const f=await fixture(t);await f.start('clear');
 assert.notEqual((await startClaudeResumeWatch(f.event('SessionStart',{source:'resume'}),{cwd:f.cwd})).status,'watching');
});

test('resume siblings require the same native event; expiry and holds preserve saved input',async t=>{
 const f=await fixture(t);await f.start('resume');const input=f.event('SessionStart',{source:'resume'});
 assert.notEqual((await startClaudeResumeWatch({...input,seconds_since_last_response:9},{cwd:f.cwd})).status,'watching');
 const {ticket}=await startClaudeResumeWatch(input,{cwd:f.cwd,now:()=>1000,timeoutMs:1000});
 const e=await appendFeedback({goalId:f.root.id,text:'held on resume'});await prepareDelivery(e);
 await writeFeedbackHold(f.root.id,{phase:'pending'});
 assert.equal((await pollClaudeIdleWatch(ticket,{now:()=>1999})).status,'watching');
 assert.equal((await pollClaudeIdleWatch(ticket,{now:()=>2000})).status,'expired');
 assert.equal((await readDeliveryState(e.changeId)).status,'saved');
});
