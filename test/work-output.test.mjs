import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {workReader} from '../lib/agents/codex-work-output.mjs';
import {workProgressGroups, workDisclosure} from '../public/work-ui.js';
import {fileURLToPath} from 'node:url';
import {expectHidden} from './hidden-failures.mjs';
import {codexThread, contractStub} from './codex-contract.mjs';

const thread='00000000-0000-0000-0000-000000000001';
const turn='00000000-0000-0000-0000-000000000002';
const started='2026-09-27T04:00:00.000Z', start=Date.parse(started);
const state={threadId:thread,turnId:turn,history:[{status:'saved',at:started}]};
// A comment's view as the Web reads it while its work runs.
const shown={threadId:thread,status:'working'};
const meta={id:turn,startedAt:Math.floor(start/1000)-10,completedAt:null,status:'interrupted',items:[]};
const userMessage=text=>({type:'userMessage',id:'user-1',content:[{type:'text',text}]});
const message=(id,text,at=start+100,turnId=turn)=>({turnId,startedAtMs:at,item:{id,type:'agentMessage',phase:'commentary',text}});
const clientFor=(entries, metadata=meta)=>contractStub(async(method,p)=>{
  assert.equal(p.threadId,thread);
  if(method==='thread/read')return {thread:codexThread({id:thread})};
  if(method==='thread/turns/list')return {data:[metadata],nextCursor:null};
  assert.equal(method,'thread/items/list');assert.equal(p.turnId,turn);return {data:entries,nextCursor:null};
});

test('all public output of the turn is kept, and nothing private',async()=>{
  const entries=[message('before','Opening message',start-5000),message('now','Progress'),message('wrong','other turn',start+100,'other'),
    {turnId:turn,startedAtMs:start+100,item:{id:'thought',type:'reasoning',content:['private']}},
    {turnId:turn,startedAtMs:start+100,item:{id:'command',type:'commandExecution',command:'secret',commandActions:[],cwd:'/tmp',status:'completed'}},
    {...message('after','Final answer',start+500),item:{id:'after',type:'agentMessage',phase:'final_answer',text:'Final answer'}}];
  const work=await workReader(clientFor(entries,{...meta,status:'completed',completedAt:Math.floor(start/1000)+1}))(state);
  assert.deepEqual(work.messages.map(m=>m.text),['Opening message','Progress','Final answer']);
  assert.ok(!JSON.stringify(work).includes('secret'));
  assert.ok(!JSON.stringify(work).includes('private'));
  assert.equal(work.endedAt,new Date(start+1000).toISOString());
});

test('work output carries turn settings rather than current thread settings',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'work-settings-')),path=join(dir,'rollout.jsonl');
 await writeFile(path,JSON.stringify({type:'turn_context',payload:{turn_id:turn,model:'actual-model',effort:'high'}})+'\n');
 const base=clientFor([]),client=contractStub(async(method,p)=>method==='thread/read'?{thread:codexThread({id:thread,path,model:'next-model',reasoningEffort:'low'})}:base.request(method,p));
 const work=await workReader(client)(state);assert.deepEqual(work.settings,{model:'actual-model',reasoning:'high'});
});

test('a turn is found by its ID across history pages; another ID finds none',async()=>{
  const calls=[];
  const reader=workReader(contractStub(async(method,p)=>{
    calls.push([method,p]);
    if(method==='thread/read')return {thread:codexThread({id:thread})};
    if(method==='thread/turns/list') return p.cursor
      ? {data:[{...meta,items:[]}],nextCursor:null}
      : {data:[{id:'unrelated',status:'completed',items:[]}],nextCursor:'older'};
    assert.equal(p.turnId,turn);return {data:[message('a','ours')],nextCursor:null};
  }));
  const work=await reader(state);
  assert.equal(work.turnId,turn);assert.equal(work.status,'working');assert.deepEqual(work.messages.map(m=>m.text),['ours']);
  assert.equal(calls.filter(([m])=>m==='thread/turns/list').length,2);
  assert.equal(await reader({...state,turnId:'missing'}),null);
});

test('Codex completion timestamps, not misleading runtime status, end Progress',async()=>{
  const running=await workReader(clientFor([message('a','Still working')]))(state);
  assert.equal(running.status,'working');assert.equal(running.endedAt,null);
  for(const status of ['completed','interrupted','failed']) {
    const work=await workReader(clientFor([], {...meta,status,completedAt:Math.floor(start/1000)+1}))(state);
    assert.equal(work.status,status);assert.ok(work.endedAt);
  }
});

test('all pages and long public messages are retained without the old size or count caps',async()=>{
  let count=0;
  const reader=workReader(contractStub(async(method,p)=>{
    if(method==='thread/turns/list')return {data:[meta],nextCursor:null};
    if(method==='thread/read')return {thread:codexThread({id:thread})};
    count++;const page=Number(p.cursor || 0);
    return {data:page===0 ? [message('long','x'.repeat(51000),start+99999),message('growing','short expanded',start+99998)] :
      page===21 ? [message('growing','short',start+99998),{...message('untimed','No timestamp'),startedAtMs:null}] :
      Array.from({length:6},(_,n)=>message(`${page}-${n}`,`Page ${page}, item ${n}`,start+page*10+n)),
    nextCursor:page<21?String(page+1):null};
  }));
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
  const deliveries=new Map([[1,{...shown,status:'completed',work:{turnId:turn,messages:[{id:'a',at:1,text:'Hello'}]}}],
    [2,{...shown,work:{turnId:turn,messages:[{id:'a',at:1,text:'Hello world'},{id:'b',at:2,text:'Next'}]}}]]);
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
  const working={...shown,work:{turnId:turn,messages:[]}};
  const deliveries=new Map([[1,working],[2,{threadId:thread,status:'queued'}]]);
  let groups=workProgressGroups(events,deliveries);
  assert.deepEqual(groups.get(1).eventIds,[1],'queued feedback does not take over ongoing work');
  deliveries.set(2,working);
  groups=workProgressGroups(events,deliveries);
  assert.deepEqual(groups.get(2).eventIds,[1,2],'a follow-up handed to the same turn joins it');
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
  assert.equal(deliveries.get(1).status,'working','grouping does not rewrite a comment view');
});

test('an AutoContinue run is found by its exact result command',async()=>{
 const command='chill monitor result --id 1 --attempt 00000000-0000-0000-0000-000000000123 --outcome worked';
 const queued={threadId:thread,matchText:command,history:[]};
 assert.equal((await workReader(clientFor([],{...meta,items:[userMessage(command)]}))(queued)).turnId,turn);
 for(const text of [command.replace('--id 1','--id 2'),command+'other',command.replace('000123','000124')]) {
  const reader=workReader(clientFor([],{...meta,items:[userMessage(text)]}));
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

test('Claude feedback received in one response shares one live Think, and closes when the response ends',()=>{
  const event=id=>({author:'user',changeId:id,goalId:'2'});
  const claude=(status,work)=>({threadId:null,connection:{harnessId:'claude-code'},status,work:{source:'turn',turnId:'claude:p1',...work}});
  const deliveries=new Map([[1,claude('completed',{status:'working',messages:[{id:'a',at:1,text:'First'}]})],
    [2,claude('received',{status:'working',messages:[{id:'a',at:1,text:'First'},{id:'b',at:2,text:'Second'}]})]]);
  let groups=workProgressGroups([event(1),event(2)],deliveries);
  assert.equal(groups.size,1);assert.deepEqual(groups.get(2).eventIds,[1,2]);
  assert.equal(groups.get(2).live,true,'transcript work keeps Think open while the delivery reads Received');
  for(const d of deliveries.values())d.work.status='completed';
  groups=workProgressGroups([event(1),event(2)],deliveries);assert.equal(groups.get(2).live,false);
});
