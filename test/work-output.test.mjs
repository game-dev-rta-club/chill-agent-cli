import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {workReader, needsWorkRefresh, presentDelivery} from '../lib/work-output.mjs';
import {workProgressGroups, workDisclosure} from '../public/work-ui.js';

const thread='00000000-0000-0000-0000-000000000001';
const turn='00000000-0000-0000-0000-000000000002';
const started='2026-09-27T04:00:00.000Z', start=Date.parse(started);
const state={threadId:thread,hookTurnId:turn,messageId:'notice-1',status:'working',agentReported:true,history:[{status:'working',at:started}]};
const meta={id:turn,startedAt:start/1000-10,completedAt:null,status:'interrupted',items:[]};
const message=(id,text,at=start+100,turnId=turn)=>({turnId,startedAtMs:at,item:{id,type:'agentMessage',phase:'commentary',text}});
const clientFor=(entries, metadata=meta)=>({request:async(method,p)=>{
  assert.equal(p.threadId,thread);
  if(method==='thread/turns/list')return {data:[metadata],nextCursor:null};
  assert.equal(method,'thread/items/list');assert.equal(p.turnId,turn);return {data:entries,nextCursor:null};
}});

test('all public output in the linked turn is kept, including before working and after completed',async()=>{
  const entries=[message('before','Opening message',start-5000),message('now','Progress'),message('wrong','other turn',start+100,'other'),
    {turnId:turn,startedAtMs:start+100,item:{type:'reasoning',content:['private']}},
    {turnId:turn,startedAtMs:start+100,item:{type:'commandExecution',command:'secret'}},
    {...message('after','Final answer',start+500),item:{id:'after',type:'agentMessage',phase:'final_answer',text:'Final answer'}}];
  const work=await workReader(clientFor(entries,{...meta,status:'completed',completedAt:start/1000+1}))({...state,status:'completed',history:[...state.history,{status:'completed',at:new Date(start+300).toISOString()}]});
  assert.deepEqual(work.messages.map(m=>m.text),['Opening message','Progress','Final answer']);
  assert.ok(!JSON.stringify(work).includes('secret'));
  assert.ok(!JSON.stringify(work).includes('private'));
  assert.equal(work.endedAt,new Date(start+1000).toISOString());
});

test('work output carries turn settings rather than current thread settings',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'work-settings-')),path=join(dir,'rollout.jsonl');
 await writeFile(path,JSON.stringify({type:'turn_context',payload:{turn_id:turn,model:'actual-model',effort:'high'}})+'\n');
 const base=clientFor([]),client={request:async(method,p)=>method==='thread/read'?{thread:{path,model:'next-model',reasoningEffort:'low'}}:base.request(method,p)};
 const work=await workReader(client)(state);assert.deepEqual(work.settings,{model:'actual-model',reasoning:'high'});
});

test('queued notices bind automatically without activity receipts, never to unrelated latest turns',async()=>{
  const calls=[];
  const reader=workReader({request:async(method,p)=>{
    calls.push([method,p]);
    if(method==='thread/turns/list') return p.cursor
      ? {data:[{...meta,items:[{type:'userMessage',content:[{type:'text',text:'[chill-agent:notice-1]'}]}]}],nextCursor:null}
      : {data:[{id:'unrelated',items:[]}],nextCursor:'older'};
    assert.equal(p.turnId,turn);return {data:[message('a','ours')],nextCursor:null};
  }});
  const queued={...state,status:'queued',hookTurnId:undefined,history:[]};
  const work=await reader(queued);
  assert.equal(work.turnId,turn);assert.equal(work.status,'working');
  assert.equal(calls.filter(([m])=>m==='thread/turns/list').length,2);
  assert.equal(await reader({...queued,messageId:'missing'}),null);
});

test('Codex completion timestamps, not activity commands or misleading runtime status, end Progress',async()=>{
  const earlyReceipt={...state,status:'completed',agentReported:true};
  const running=await workReader(clientFor([message('a','Still working')]))(earlyReceipt);
  assert.equal(running.status,'working');assert.equal(running.endedAt,null);
  assert.equal(presentDelivery({...earlyReceipt,work:running}).status,'working');
  assert.equal(needsWorkRefresh({...earlyReceipt,work:running}),true);
  for(const status of ['completed','interrupted','failed']) {
    const work=await workReader(clientFor([], {...meta,status,completedAt:start/1000+1}))(state);
    assert.equal(work.status,status);assert.ok(work.endedAt);
    assert.equal(needsWorkRefresh({...earlyReceipt,work}),false);
  }
  assert.equal(needsWorkRefresh({...earlyReceipt,work:{turnId:turn,endedAt:started}}),true,'Old interval snapshots are backfilled');
});

test('all pages and long public messages are retained without the old size or count caps',async()=>{
  let count=0;
  const reader=workReader({request:async(method,p)=>{
    if(method==='thread/turns/list')return {data:[meta],nextCursor:null};
    if(method==='thread/read')return {thread:{path:null}};
    count++;const page=Number(p.cursor || 0);
    return {data:page===0 ? [message('long','x'.repeat(51000),start+99999),message('growing','short expanded',start+99998)] :
      page===21 ? [message('growing','short',start+99998),{...message('untimed','No timestamp'),startedAtMs:null}] :
      Array.from({length:6},(_,n)=>message(`${page}-${n}`,`Page ${page}, item ${n}`,start+page*10+n)),
    nextCursor:page<21?String(page+1):null};
  }});
  const a=await reader(state),b=await reader(state);
  assert.deepEqual(a,b);assert.equal(count,22);
  assert.ok(a.messages.length>100);
  assert.equal(a.messages.find(m=>m.id==='long').text.length,51000);
  assert.equal(a.messages.find(m=>m.id==='growing').text,'short expanded');
  assert.ok(a.messages.some(m=>m.id==='untimed'));
  assert.equal(a.truncated,false);
});

test('shared turn output appears once; manual collapse is respected and Codex finish closes it',()=>{
  const events=[{author:'user',changeId:1,goalId:'3'},{author:'user',changeId:2,goalId:'3'}];
  const deliveries=new Map([[1,{...state,status:'completed',work:{turnId:turn,messages:[{id:'a',at:1,text:'Hello'}]}}],
    [2,{...state,work:{turnId:turn,messages:[{id:'a',at:1,text:'Hello world'},{id:'b',at:2,text:'Next'}]}}]]);
  const groups=workProgressGroups(events,deliveries);
  assert.equal(groups.size,1);assert.equal(groups.has(1),false);
  assert.deepEqual(groups.get(2).eventIds,[1,2]);
  assert.deepEqual(groups.get(2).messages.map(m=>m.text),['Hello world','Next']);
  assert.equal(groups.get(2).live,true);
  let view=workDisclosure(undefined,true);assert.equal(view.open,true);
  view.open=false;assert.equal(workDisclosure(view,true).open,false);
  view.open=true;view=workDisclosure(view,false);assert.equal(view.open,false);
  view.open=true;assert.equal(workDisclosure(view,false).open,true);
  deliveries.get(2).threadId='other';assert.equal(workProgressGroups(events,deliveries).size,2);
});

test('follow-ups share an indicator only after joining the same work, within the same Goal',()=>{
  const event=(id,extra={})=>({author:'user',changeId:id,goalId:'7',...extra});
  const events=[event(1),event(2),event(3)];
  const working={...state,work:{turnId:turn,messages:[]}};
  const deliveries=new Map([[1,working],[2,{threadId:thread,status:'queued'}]]);
  let groups=workProgressGroups(events,deliveries);
  assert.deepEqual(groups.get(1).eventIds,[1],'queued feedback does not take over ongoing work');
  deliveries.set(2,{...state,work:undefined});
  groups=workProgressGroups(events,deliveries);
  assert.deepEqual(groups.get(2).eventIds,[1,2],'a claimed hook identifies the same turn before its output arrives');
  deliveries.set(3,working);
  groups=workProgressGroups(events,deliveries);
  assert.equal(groups.size,1);
  assert.deepEqual(groups.get(3).eventIds,[1,2,3],'older entries point directly to the newest follow-up');
  for(const [id,extra] of [[4,{goalId:'9'}],[5,{goalId:'8'}],[6,{}],[7,{}]]) {
    events.push(event(id,extra));
    deliveries.set(id,id===6?{...working,work:{turnId:'another',messages:[]}}:
      id===7?{...working,threadId:'another'}:working);
  }
  groups=workProgressGroups(events,deliveries);
  assert.equal(groups.size,5,'other Goals, turns and chats stay independent');
  assert.deepEqual(groups.get(3).eventIds,[1,2,3]);
  assert.equal(deliveries.get(1).status,'working','grouping does not rewrite the stored receipt');
});

test('Queue fallback after an unclaimed hook replaces even a cached old turn',async()=>{
  const reader=workReader({request:async(method,p)=>{
    if(method==='thread/turns/list')return {data:[
      {...meta,items:[{type:'userMessage',content:[{type:'text',text:'[chill-agent:notice-1]'}]}]},
      {id:'old-hook',items:[]}
    ],nextCursor:null};
    assert.equal(p.turnId,turn);return {data:[message('a','new handler')],nextCursor:null};
  }});
  assert.equal((await reader({...state,hookTurnId:'old-hook',work:{turnId:'old-hook'}})).turnId,turn);
});

test('Web collects before receipt and after activity completion, then freezes only the actual completed turn',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'chill-work-test-'));
  const env={...process.env,CHILL_AGENT_DATA_DIR:dir,CHILL_AGENT_CODEX_PATH:new URL('./fake-codex.mjs',import.meta.url).pathname,CODEX_THREAD_ID:thread};
  const cli=new URL('../bin/chill-agent.mjs',import.meta.url).pathname;
  const run=async args=>JSON.parse((await promisify(execFile)(process.execPath,[cli,...args],{env})).stdout.trim());
  const invoke=args=>promisify(execFile)(process.execPath,[cli,...args],{env});
  const body=join(dir,'workspace/goals/1/brief.md');
  await invoke(['create','--title','Progress','--thread-id',thread]);
  await writeFile(body,'<p>Plan</p>');
  await invoke(['brief','update','--id','1']);
  const input=join(dir,'feedback.json');await writeFile(input,JSON.stringify({text:'Go'}));
  await invoke(['feedback','--id','1','--input-file',input]);
  const delivery=JSON.parse(await readFile(join(dir,'workspace','deliveries','1.json'),'utf8'));
  const history={turns:[{...meta,items:[{type:'userMessage',content:[{type:'text',text:`[chill-agent:${delivery.messageId}]`}]}]}],items:{[turn]:[message('first','Opening before receipt',Date.now())]}};
  const saveHistory=()=>writeFile(join(dir,'fake-history.json'),JSON.stringify(history));
  await saveHistory();
  const server=spawn(process.execPath,[new URL('../server.mjs',import.meta.url).pathname],{env:{...env,PORT:'0'},stdio:['ignore','pipe','pipe']});
  const url=await new Promise((resolve,reject)=>{server.stdout.on('data',chunk=>{const m=chunk.toString().match(/http:\/\/127\.0\.0\.1:\d+/);if(m)resolve(m[0]);});server.on('error',reject);});
  try {
    const [live]=await (await fetch(`${url}/api/goals/1/deliveries`)).json();
    assert.equal(live.status,'working');assert.equal(live.agentReported,undefined);
    assert.equal(live.work.messages[0].text,'Opening before receipt');
    await run(['activity','--event','1','--state','working']);
    history.fail=true;await saveHistory();
    const unavailable=(await run(['activity','--event','1','--state','working'])).delivery;
    assert.ok(unavailable.workError);assert.equal(unavailable.work.messages[0].text,'Opening before receipt');
    history.fail=false;history.items[turn].push(message('progress','Progress update',Date.now()));await saveHistory();
    const receipt=(await run(['activity','--event','1','--state','completed'])).delivery;
    assert.equal(receipt.workError,null);assert.equal(receipt.work.status,'working');assert.equal(receipt.work.endedAt,null);
    const [stillRunning]=await (await fetch(`${url}/api/goals/1/deliveries`)).json();
    assert.equal(stillRunning.status,'working');assert.equal(stillRunning.reportedStatus,'completed');
    history.items[turn].push(message('final','Final answer after receipt',Date.now()));
    history.turns[0].status='completed';history.turns[0].completedAt=Date.now()/1000;
    await saveHistory();await delay(5100);
    const [done]=await (await fetch(`${url}/api/goals/1/deliveries`)).json();
    assert.equal(done.status,'completed');assert.equal(done.work.messages.length,3);assert.ok(done.work.endedAt);
    const groups=workProgressGroups([{author:'user',changeId:1,goalId:'1'}],new Map([[1,done]]));
    assert.equal(workDisclosure({live:true,open:true},groups.get(1).live).open,false);
    assert.equal((await (await fetch(`${url}/api/events`)).json()).events.length,1,'Output is not a Conversation comment');
    history.items[turn].push(message('unrelated','Wrong turn',Date.now()+100,'other'));await saveHistory();
    const [frozen]=await (await fetch(`${url}/api/goals/1/deliveries`)).json();
    assert.deepEqual(frozen.work,done.work);
  }finally{server.kill('SIGTERM');await once(server,'exit');}
});


test('queued resumed input binds by the common input marker instead of the original completed comment',async()=>{
 const resumed={...meta,id:turn,items:[{type:'userMessage',content:[{type:'text',text:'[chill-agent:batch-new]\n[chill-agent:notice-1]'}]}]};
 const old={...meta,id:'old',status:'completed',completedAt:123,items:[{type:'userMessage',content:[{type:'text',text:'[chill-agent:notice-1]'}]}]};
 const client={request:async(method,p)=>{
  if(method==='thread/turns/list')return {data:[old,resumed],nextCursor:null};
  if(method==='thread/read')return {thread:{}};
  assert.equal(p.turnId,turn);return {data:[message('a','Resumed output')],nextCursor:null};
 }};
 const work=await workReader(client)({...state,hookTurnId:null,batchId:'batch-new',status:'queued'});
 assert.equal(work.turnId,turn);assert.equal(work.messages[0].text,'Resumed output');
});

test('monitor receipt binds by its exact result command without a visible marker, retaining legacy support',async()=>{
 const command='chill monitor result --id 1 --attempt 00000000-0000-0000-0000-000000000123 --outcome worked';
 const queued={threadId:thread,messageId:'00000000-0000-0000-0000-000000000123',matchText:command,history:[]};
 for(const text of [command,'[chill-agent:00000000-0000-0000-0000-000000000123]']) {
  const reader=workReader(clientFor([],{...meta,items:[{type:'userMessage',content:[{type:'text',text}]}]}));
  assert.equal((await reader(queued)).turnId,turn);
 }
 for(const text of [command.replace('--id 1','--id 2'),command+'other',command.replace('000123','000124')]) {
  const reader=workReader(clientFor([],{...meta,items:[{type:'userMessage',content:[{type:'text',text}]}]}));
  assert.equal(await reader(queued),null);
 }
});

test('a lagging Activity response cannot split one running turn across feedback entries',()=>{
 const events=[{author:'user',changeId:1,goalId:'3'},{author:'user',changeId:2,goalId:'3'}];
 const deliveries=new Map([[1,{threadId:thread,status:'working',work:{turnId:turn,messages:[{id:'a',text:'Working',at:1}]}}],
   [2,{threadId:thread,status:'working',turnId:turn}]]);
 const activity={goalId:'3',eventId:1,threadId:thread,turnId:turn,status:'working',capabilities:{stop:true}};
 const groups=workProgressGroups(events,deliveries,{...activity,work:{messages:[]}});
 assert.equal(groups.size,1);assert.equal(groups.has(1),false);
 assert.deepEqual(groups.get(2).eventIds,[1,2]);assert.equal(groups.get(2).activity.eventId,activity.eventId);
 assert.equal(groups.get(2).messages[0].text,'Working');
 assert.equal(workProgressGroups(events,deliveries,{...activity,status:'paused'}).get(2).live,false);
 const later=workProgressGroups(events,deliveries,{...activity,eventId:2,turnId:'resumed',work:{messages:[{id:'b',text:'Resumed'}]}});
 assert.equal(later.size,2,'a real resumed turn remains separate');
 assert.equal(later.get(1).live,false);assert.equal(later.get(1).status,'ended');
 assert.equal(later.get(2).live,true);
});

test('direct CLI receipt binds the live turn without a notification marker or work selection',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'chill-direct-receipt-'));
 const env={...process.env,CHILL_AGENT_DATA_DIR:dir,CHILL_AGENT_CODEX_PATH:new URL('./fake-codex.mjs',import.meta.url).pathname,CODEX_THREAD_ID:thread};
 const cli=new URL('../bin/chill-agent.mjs',import.meta.url).pathname;
 const invoke=args=>promisify(execFile)(process.execPath,[cli,...args],{env});
 await invoke(['create','--title','Direct read','--thread-id',thread]);
 const input=join(dir,'feedback.json');await writeFile(input,JSON.stringify({text:'Read through the CLI'}));
 await invoke(['feedback','--id','1','--input-file',input]);
 const history={turns:[meta],items:{[turn]:[message('progress','Working on the direct request',Date.now())]}};
 await writeFile(join(dir,'fake-history.json'),JSON.stringify(history));
 const receipt=JSON.parse((await invoke(['activity','--event','1','--state','working'])).stdout).delivery;
 assert.equal(receipt.turnId,turn);assert.equal(receipt.work.turnId,turn);
 assert.equal(receipt.work.messages[0].text,'Working on the direct request');
 await assert.rejects(readFile(join(dir,'workspace/executions',thread+'.json')),{code:'ENOENT'});
 history.turns=[{id:'next',status:'inProgress',completedAt:null},meta];
 await writeFile(join(dir,'fake-history.json'),JSON.stringify(history));
 const retry=JSON.parse((await invoke(['activity','--event','1','--state','working'])).stdout).delivery;
 assert.equal(retry.turnId,turn,'receipt retries preserve established ownership');
 assert.equal(presentDelivery({status:'working',agentReported:true}).status,'received','unbound legacy receipts are not phantom Running entries');
 assert.equal(presentDelivery({status:'queued'}).status,'queued');
});


test('unclaimed hook notices never borrow the interrupted work output',async()=>{
 const client={request:async(method)=>{
  if(method==='thread/turns/list')return {data:[{id:turn,status:'inProgress',completedAt:null,items:[]}],nextCursor:null};
  throw Error('No other reads expected');
 }};
 const queued={threadId:thread,hookTurnId:turn,messageId:'pending',status:'deferred',history:[]};
 assert.equal(await workReader(client)(queued),null);
});
