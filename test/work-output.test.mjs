import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {workReader} from '../lib/agents/codex-work-output.mjs';
import {activityDisplay, commentMarkDisplay, workDisclosure} from '../public/work-ui.js';
import {codexThread, contractStub} from './codex-contract.mjs';

const thread='00000000-0000-0000-0000-000000000001';
const turn='00000000-0000-0000-0000-000000000002';
const started='2026-09-27T04:00:00.000Z', start=Date.parse(started);
const state={threadId:thread,turnId:turn,history:[{status:'saved',at:started}]};
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

test('Think opens while its work runs; a manual collapse is respected and the end of the work closes it',()=>{
  let view=workDisclosure(undefined,true);assert.equal(view.open,true);
  view.open=false;assert.equal(workDisclosure(view,true).open,false);
  view.open=true;view=workDisclosure(view,false);assert.equal(view.open,false);
  view.open=true;assert.equal(workDisclosure(view,false).open,true);
});

test('a comment shows a mark only until its Goal has a reply, and the agent shows Paused apart from Interrupted',()=>{
  assert.equal(commentMarkDisplay({eventId:1,mark:null}),null);
  assert.deepEqual(['saved','waiting','paused','handed','interrupted'].map(mark=>commentMarkDisplay({mark}).label),['Saved','Waiting','Paused','Sent','Interrupted']);
  assert.equal(commentMarkDisplay({mark:'waiting'}).sendNow,true);assert.equal(commentMarkDisplay({mark:'saved'}).sendNow,false);
  assert.match(commentMarkDisplay({mark:'saved',unassigned:true}).description,/No chat/);
  assert.notEqual(activityDisplay({status:'paused'}).label,activityDisplay({status:'interrupted'}).label);
  assert.equal(activityDisplay({status:'idle',work:{messages:[]}}),null,'nothing to show where the agent did nothing');
  assert.equal(activityDisplay({status:'running',work:{live:true,messages:[]}}).live,true);
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
