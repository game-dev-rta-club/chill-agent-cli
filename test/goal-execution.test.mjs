import assert from 'node:assert/strict';
import test from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm} from 'node:fs/promises';
import {readFile,writeFile} from './record-fixture.mjs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGoalView} from '../public/goal-view.js';
import {fileURLToPath} from 'node:url';
import {expectHidden} from './hidden-failures.mjs';
import {goalCommentMarks} from '../lib/agents/index.mjs';

// What the Goal page reads for its comments, in this fixture's data directory.
async function pageMarks(f,goalId) {
  const previous={...process.env};Object.assign(process.env,f.env);
  try{return await goalCommentMarks(goalId);}finally{for(const key of Object.keys(process.env))if(!(key in previous))delete process.env[key];Object.assign(process.env,previous);}
}
const execute=promisify(execFile), cli=fileURLToPath(new URL('../bin/chill-agent.mjs',import.meta.url));
const thread='00000000-0000-0000-0000-000000000001',other='00000000-0000-0000-0000-000000000002';
const turn='00000000-0000-0000-0000-000000000010';
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'chill-execution-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const env={...process.env,CHILL_AGENT_DATA_DIR:root,CHILL_AGENT_CODEX_PATH:fileURLToPath(new URL('./fake-codex.mjs',import.meta.url)),CODEX_THREAD_ID:thread,PORT:'4199'};
  const run=async(...args)=>JSON.parse((await execute(process.execPath,[cli,...args],{env})).stdout);
  const json=async path=>JSON.parse(await readFile(join(root,path),'utf8'));
  let serial=0;
  const patch=async(id,data)=>{const path=join(root,`patch-${serial++}.json`);await writeFile(path,JSON.stringify(data));return run('update','--id',id,'--input-file',path);};
  const history=async value=>writeFile(join(root,'fake-history.json'),JSON.stringify(value));
  await history({turns:[{id:turn,status:'interrupted',startedAt:Math.floor(Date.now()/1000),completedAt:null}]});
  await run('create','--title','Root agreement','--scope','Only editor changes','--criteria','Two improvements');
  await run('create','--title','Waiting branch','--parent','1');
  await run('create','--title','Independent branch','--parent','1');
  const note=async(id='2')=>{const path=join(root,`workspace/goals/${id}/deliverable.md`);await writeFile(path,`Question ${++serial}`);return run('deliverable','update','--id',id);};
  const feedback=async(id='2')=>{const input=join(root,'input.json');await writeFile(input,JSON.stringify({text:'My answer'}));return (await execute(process.execPath,[cli,'feedback','--id',id,'--input-file',input],{env})).stdout.trim().split('\n').map(JSON.parse);};
  const selectionPath=`workspace/executions/${thread}.json`;
  return {root,env,run,json,patch,history,note,feedback,selectionPath};
}

test('verified root assignment hands child comments with their Goal, and a reassigned Root keeps what it handed',{skip:process.platform==='win32'&&'Codex Desktop harness is macOS-only; fake-codex.mjs runs as an executable'},async t=>{
  const f=await fixture(t);await f.note();await f.note('2','notice');
  await assert.rejects(f.run('assign','--id','2','--thread-id',thread),/root Goal only/);
  await assert.rejects(f.run('assign','--id','1','--thread-id','00000000-0000-0000-0000-999999999999'),/Chat not found/);
  await f.run('assign','--id','1','--thread-id',thread);
  const [{feedback},{comment}]=await f.feedback();
  assert.equal(comment.mark,'handed');assert.equal(feedback.version,undefined);
  const queue=await f.json('fake-queue.json'),text=queue[0].input[0].text;
  assert.match(text,/PORT='4199'/);assert.match(text,/"eventId":1,"goalId":"2"/);
  assert.match(text,/show --id 2 --since 0 --format text/);
  assert.equal((await f.run('show','--id','2','--version','1')).root.scope,'Only editor changes');
  await f.run('assign','--id','1','--thread-id',other);
  await pageMarks(f,'2');
  assert.equal((await f.json('fake-queue.json')).length,1,'a handed comment is not handed again to the new chat');
});

test('feedback saved before a chat is assigned reaches it once, when chill next reads the Goal',{skip:process.platform==='win32'&&'Codex Desktop harness is macOS-only; fake-codex.mjs runs as an executable'},async t=>{
  const f=await fixture(t);await f.note();
  const {comment}=(await f.feedback())[1];assert.equal(comment.mark,'saved');assert.equal(comment.unassigned,true);
  await f.run('assign','--id','1','--thread-id',thread);
  await assert.rejects(f.json('fake-queue.json'),{code:'ENOENT'},'assigning sends nothing by itself');
  assert.deepEqual((await pageMarks(f,'2')).map(m=>m.mark),['handed']);await pageMarks(f,'2');
  assert.equal((await f.json('fake-queue.json')).length,1);
  await f.run('comment','--id','2','--text','Received');
  assert.equal((await f.run('show','--id','2','--version','1')).conversation.at(-1).text,'Received');
});

test('one selected branch works while another waits; turn end returns to Idle',{skip:process.platform==='win32'&&'Codex Desktop harness is macOS-only; fake-codex.mjs runs as an executable'},async t=>{
  const f=await fixture(t);await f.run('assign','--id','1','--thread-id',thread);
  await f.note();await f.patch('2',{state:'waiting',waitReason:'Need a choice'});
  await assert.rejects(f.run('work','--id','2'),/Resolve Waiting or reopen Done/);
  await f.run('work','--id','3');
  let tree=(await f.run('tree','--id','1'))[0];
  assert.equal(tree.state,'working');assert.equal(tree.children[0].state,'waiting');assert.equal(tree.children[0].letterCount,0);
  assert.equal(tree.children[1].state,'working');assert.equal(tree.progress,0);
  const page=await f.run('show','--id','1');
  assert.equal(page.goal.state,tree.state);assert.equal(page.goal.progress,tree.progress);
  assert.equal(page.splitGoals[1].execution.goalId,'3');assert.equal(page.goal.storedState,'idle');
  await f.feedback();
  assert.equal((await f.json(f.selectionPath)).goalId,'3','receiving A does not switch work away from B');
  await f.patch('2',{state:'idle'});await f.run('work','--id','2');
  tree=(await f.run('tree'))[0];assert.equal(tree.children[0].state,'working');assert.equal(tree.children[1].state,'idle');
  await f.history({turns:[{id:turn,status:'completed',completedAt:Math.floor(Date.now()/1000)}]});
  tree=(await f.run('tree'))[0];assert.equal(tree.state,'idle');assert.equal(tree.children[0].state,'idle');assert.equal(tree.progress,0);
  await assert.rejects(f.run('work','--id','2'),/No current unfinished/);
});

test('connection loss and reassignment clear Running; a stale unfinished turn is not shown Running',{skip:process.platform==='win32'&&'Codex Desktop harness is macOS-only; fake-codex.mjs runs as an executable'},async t=>{
 expectHidden(t,'codex-work.observe');
  const f=await fixture(t);await f.run('assign','--id','1','--thread-id',thread);await f.run('work','--id','3');
  assert.equal((await f.run('tree'))[0].children[1].state,'working');
  await f.history({fail:true});let tree=(await f.run('tree'))[0];
  assert.equal(tree.state,'idle');assert.equal(tree.children[1].execution,undefined);
  const selection=await f.json(f.selectionPath);selection.heartbeatAt=new Date(Date.now()-120001).toISOString();
  await writeFile(join(f.root,f.selectionPath),JSON.stringify(selection));
  await f.history({turns:[{id:turn,status:'interrupted',completedAt:null}]});
  tree=(await f.run('tree'))[0];assert.equal(tree.children[1].execution,undefined);assert.equal(tree.state,'idle');
  const nextTurn='00000000-0000-0000-0000-000000000011';
  await f.history({turns:[{id:nextTurn,status:'inProgress',completedAt:null}]});
  tree=(await f.run('tree'))[0];assert.equal(tree.state,'idle','the selection belongs to the earlier turn');
  await f.run('work','--id','3');assert.equal((await f.json(f.selectionPath)).turnId,nextTurn);
  await f.run('work','--id','3','--stop');assert.equal((await f.run('tree'))[0].state,'idle');
  await f.run('work','--id','3');await f.run('assign','--id','1','--thread-id',other);
  assert.equal((await f.run('tree'))[0].children[1].execution,undefined);
  await assert.rejects(f.run('work','--id','3'),/assigned chat/);
});

test('a Done Goal requires an explicit reopen before work selection',{skip:process.platform==='win32'&&'Codex Desktop harness is macOS-only; fake-codex.mjs runs as an executable'},async t=>{
  const f=await fixture(t);await f.run('assign','--id','1','--thread-id',thread);
  const path='workspace/goals/3/goal.json',old=await f.json(path);
  await writeFile(join(f.root,path),JSON.stringify({...old,state:'done',started:true}));
  await assert.rejects(f.run('work','--id','3'),/reopen Done/);
  assert.equal((await f.json(path)).state,'done');
  await f.patch('3',{state:'idle'});await f.run('work','--id','3');
  assert.equal((await f.json(path)).state,'idle');
  assert.equal((await f.run('tree'))[0].children[1].state,'working');
  await f.run('work','--id','3','--stop');
  assert.equal((await f.run('tree'))[0].children[1].state,'idle');
});

test('the Web renders Working only on the selected branch and its ancestors',()=>{
  const base={briefs:[],conversation:[],state:'idle',started:false};
  const goals={'1':{...base,id:'1',title:'Root',children:['2','3']},'2':{...base,id:'2',title:'Wait',parentId:'1',children:[],state:'waiting',waitReason:'Choice'},'3':{...base,id:'3',title:'Work',parentId:'1',children:[],execution:{status:'working',expiresAt:new Date(Date.now()+15000).toISOString()}}};
  const html=createGoalView(goals,'1',new Set()).brief('1');
  assert.equal((html.match(/status working/g)||[]).length,2);assert.match(html,/status waiting/);
  goals['3'].execution.expiresAt='2020-01-01T00:00:00.000Z';
  const expired=createGoalView(goals,'1',new Set()).brief('1');assert.ok(!expired.includes('status working'));assert.doesNotMatch(expired,/status idle|>Running</);
});

test('hook heartbeats are limited to the selected chat and turn, and stop stays stopped',{skip:process.platform==='win32'&&'Codex Desktop harness is macOS-only; fake-codex.mjs runs as an executable'},async t=>{
  const f=await fixture(t);await f.run('assign','--id','1','--thread-id',thread);await f.run('work','--id','3');
  const stored=await f.json(f.selectionPath);stored.heartbeatAt='2020-01-01T00:00:00.000Z';await writeFile(join(f.root,f.selectionPath),JSON.stringify(stored));
  const hookCall=async input=>execute(process.execPath,['--input-type=module','-e',`import {hookOutput} from ${JSON.stringify(new URL('../bin/chill-hook.mjs',import.meta.url).href)}; await hookOutput(${JSON.stringify({hook_event_name:'PostToolUse',session_id:thread,turn_id:turn,...input})},'${thread}');`],{env:f.env});
  await hookCall({agent_id:'child'});await hookCall({turn_id:other});await hookCall({session_id:other});
  assert.equal((await f.json(f.selectionPath)).heartbeatAt,stored.heartbeatAt);
  await hookCall({});assert.notEqual((await f.json(f.selectionPath)).heartbeatAt,stored.heartbeatAt);
  await f.run('work','--id','3','--stop');const stopped=await f.json(f.selectionPath);await hookCall({});
  assert.deepEqual(await f.json(f.selectionPath),stopped);
});

test('a hook tracks chat liveness before work selection; Goal and header use the same turn evidence',{skip:process.platform==='win32'&&'Codex Desktop harness is macOS-only; fake-codex.mjs runs as an executable'},async t=>{
 const f=await fixture(t);await f.run('assign','--id','1','--thread-id',thread);
 const read=async()=>JSON.parse((await execute(process.execPath,['--input-type=module','-e',
  `import {readAgentPresence} from './lib/agent-presence.mjs';console.log(JSON.stringify(await readAgentPresence('1')));`],
  {env:f.env,cwd:fileURLToPath(new URL('..',import.meta.url))})).stdout);
 const hookCall=async extra=>execute(process.execPath,['--input-type=module','-e',
  `import {hookOutput} from ${JSON.stringify(new URL('../bin/chill-hook.mjs',import.meta.url).href)};await hookOutput(${JSON.stringify({hook_event_name:'PostToolUse',session_id:thread,turn_id:turn,...extra})},'${thread}');`],{env:f.env});
 assert.equal((await read()).status,'unknown','an unfinished turn nobody vouches for');
 await hookCall({agent_id:'child'});assert.equal((await read()).status,'unknown');
 await hookCall({});assert.equal((await read()).status,'working');
 await assert.rejects(f.json(f.selectionPath),{code:'ENOENT'},'a heartbeat does not select work');
 await f.run('work','--id','3');
 let tree=(await f.run('tree','--id','1'))[0];assert.equal(tree.children[1].state,'working');
 assert.equal((await read()).goalId,'3');
 const selected=await f.json(f.selectionPath);selected.heartbeatAt='2020-01-01T00:00:00Z';
 await writeFile(join(f.root,f.selectionPath),JSON.stringify(selected));
 tree=(await f.run('tree','--id','1'))[0];assert.equal(tree.children[1].state,'working','independent chat heartbeat confirms the selected run');
 await f.history({turns:[{id:turn,status:'completed',completedAt:Math.floor(Date.now()/1000)}]});
 assert.equal((await read()).status,'idle');assert.equal((await f.run('tree','--id','1'))[0].state,'idle');
});

test('Done stays stored while queued and running feedback takes display priority',{skip:process.platform==='win32'&&'Codex Desktop harness is macOS-only; fake-codex.mjs runs as an executable'},async t=>{
 const f=await fixture(t);await f.run('assign','--id','1','--thread-id',thread);
 await f.patch('2',{state:'done'});await f.patch('3',{state:'done'});await f.patch('1',{state:'done'});
 // A turn the user started in Desktop, before its first tool: the comment waits in the chat queue behind it.
 const typed='00000000-0000-0000-0000-000000000012';
 await f.history({turns:[{id:typed,status:'inProgress',completedAt:null},{id:turn,status:'completed',completedAt:1}]});
 await f.feedback();
 let page=await f.run('show','--id','2');
 assert.equal(page.goal.state,'working');assert.equal(page.goal.execution.status,'queued');assert.equal(page.goal.storedState,'done');assert.equal(page.goal.progress,100);assert.equal(page.root.state,'working');
 const next='00000000-0000-0000-0000-000000000011';
 // Codex runs it once the typed turn ends. chill sees that turn work only from its first tool's hook.
 await writeFile(join(f.root,'fake-queue.json'),'[]');
 await f.history({turns:[{id:next,status:'inProgress',completedAt:null},{id:typed,status:'completed',completedAt:2}]});
 const before=(await f.run('show','--id','2')).goal;assert.equal(before.execution,undefined,'a live turn reads interrupted to chill, so its work is unknown');
 await execute(process.execPath,['--input-type=module','-e',`import {hookOutput} from ${JSON.stringify(new URL('../bin/chill-hook.mjs',import.meta.url).href)};await hookOutput(${JSON.stringify({hook_event_name:'PostToolUse',session_id:thread,turn_id:next})},'${thread}');`],{env:f.env});
 page=await f.run('show','--id','2');assert.equal(page.goal.state,'working');assert.equal(page.goal.execution.status,'working');
 assert.equal((await f.json('workspace/goals/2/goal.json')).state,'done');
 await assert.rejects(f.json(f.selectionPath),{code:'ENOENT'},'display does not select work');
 await f.run('comment','--id','2','--text','Answered');
 await f.history({turns:[{id:next,status:'completed',completedAt:2}]});
 page=await f.run('show','--id','2');assert.equal(page.goal.state,'done');assert.equal(page.root.state,'done');
 // Marking a selected Goal Done also keeps its live activity until the turn ends.
 await f.patch('2',{state:'idle'});await f.history({turns:[{id:next,status:'inProgress',completedAt:null}]});await f.run('work','--id','2');await f.patch('2',{state:'done'});
 page=await f.run('show','--id','2');assert.equal(page.goal.state,'working');assert.equal(page.goal.storedState,'done');
 await f.history({turns:[{id:next,status:'completed',completedAt:3}]});
 assert.equal((await f.run('show','--id','2')).goal.state,'done');
});
