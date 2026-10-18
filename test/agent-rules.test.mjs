import test from 'node:test';
import assert from 'node:assert/strict';
import {agentStatus,awaitsReply,commentMark,cursorAfter,handing,idleWork,nextWork,pendingComments,quietGoals,runningGoals,unanswered} from '../lib/agent-rules.mjs';

const replay=(...events)=>events.reduce(nextWork,idleWork);
const status=(work,patch={})=>agentStatus({work,...patch});
const user=(id,goalId='1')=>({id,goalId,author:'user',type:'comment'});
const agent=(id,goalId='1',type='comment')=>({id,goalId,author:'agent',type});

test('an agent runs only between the start and the end of its work, or while background tasks run',()=>{
  const cases=[
    ['nothing reported, such as a local command like /reload-skills',[],'idle'],
    ['a prompt started its work',[{type:'started'}],'running'],
    ['its work finished',[{type:'started'},{type:'finished'}],'idle'],
    ['a background agent still runs after its work',[{type:'started'},{type:'background',count:1},{type:'finished'}],'running'],
    ['the background agent reported back and ended',[{type:'started'},{type:'background',count:1},{type:'finished'},{type:'background',count:0}],'idle'],
    ['Esc stopped it',[{type:'started'},{type:'interrupted'}],'interrupted'],
    ['it works again after an interrupt',[{type:'started'},{type:'interrupted'},{type:'started'}],'running'],
    ['the conversation ended',[{type:'started'},{type:'ended'}],'unlinked'],
  ];
  for(const [name,events,expected] of cases)assert.equal(status(replay(...events)),expected,name);
});

test('Pause, an unreadable harness and a missing conversation take priority over the work',()=>{
  const working=replay({type:'started'});
  assert.equal(status(working,{paused:true}),'paused');
  assert.equal(status(working,{known:false}),'unknown');
  assert.equal(status(idleWork,{known:false}),'unknown','an unreadable harness is never shown idle');
  assert.equal(status(working,{linked:false}),'unlinked');
});

test('a Goal awaits a reply while the user spoke last in it, whichever comment the reply answers',()=>{
  const cases=[
    ['no comments',[],false],
    ['one comment, no reply',[user(1)],true],
    ['three comments and one reply',[user(1),user(2),user(3),agent(4)],false],
    ['a comment after the reply',[user(1),agent(2),user(3)],true],
    ['a short OK after the reply still awaits one',[user(1),agent(2),user(3)],true],
    ['a Letter is a reply',[user(1),agent(2,'1','letter')],false],
    ['a deleted reply is not a reply',[user(1),{...agent(2),deletedAt:'2026-10-18'}],true],
  ];
  for(const [name,events,expected] of cases)assert.equal(awaitsReply(events),expected,name);
  assert.deepEqual(unanswered([user(1),agent(2),user(3),user(4)]).map(e=>e.id),[3,4]);
});

test('the Goal is answered by the agent\'s Comment, not by its work ending',()=>{
  const events=[user(1)];
  const work=replay({type:'started'},{type:'handed',goals:['1']},{type:'finished'});
  assert.equal(status(work),'idle');
  assert.equal(awaitsReply(events),true,'Codex once showed Done when the turn ended without a reply');
  assert.equal(awaitsReply([...events,agent(2)]),false,'a reply answers it even while the work still runs');
});

test('comments wait only while the agent\'s own work runs',()=>{
  const pending=[user(5)];
  const cases=[
    ['idle',idleWork,{},{hand:[5],hold:null}],
    ['working',replay({type:'started'}),{},{hand:[],hold:'waiting'}],
    ['working, Send now',replay({type:'started'}),{sendNow:true},{hand:[5],hold:null}],
    ['only a background agent runs',replay({type:'started'},{type:'background',count:1},{type:'finished'}),{},{hand:[5],hold:null}],
    ['interrupted',replay({type:'started'},{type:'interrupted'}),{},{hand:[5],hold:null}],
    ['paused',idleWork,{paused:true},{hand:[],hold:'paused'}],
    ['paused, Send now',replay({type:'started'}),{paused:true,sendNow:true},{hand:[],hold:'paused'}],
    ['no conversation',idleWork,{linked:false},{hand:[],hold:'unlinked'}],
  ];
  for(const [name,work,patch,expected] of cases){
    const result=handing({pending,work,...patch});
    assert.deepEqual({hand:result.hand.map(e=>e.id),hold:result.hold},expected,name);
  }
  assert.deepEqual(handing({pending:[],work:idleWork}),{hand:[],hold:null});
});

test('the cursor hands each comment once, and a lost hand-off still awaits a reply',()=>{
  const events=[user(1),agent(2),user(3),user(4)];
  let cursor=0;
  const first=handing({pending:pendingComments(events,cursor),work:idleWork});
  cursor=cursorAfter(cursor,first.hand);
  assert.equal(cursor,4);
  assert.deepEqual(pendingComments(events,cursor),[],'nothing is handed twice');
  assert.deepEqual(unanswered(events).map(e=>e.id),[3,4],'if the agent never saw them, its inbox still lists them');
  assert.deepEqual(pendingComments([...events,user(5)],cursor).map(e=>e.id),[5]);
});

test('a conversation that takes over a Root receives what its earlier owner was never handed',()=>{
  const events=[user(1),user(2)],rootCursor=1;
  assert.deepEqual(pendingComments(events,rootCursor).map(e=>e.id),[2],'the cursor belongs to the Root, not to a conversation');
});

test('each comment that awaits a reply shows where it is',()=>{
  const cases=[
    ['handed',{id:3},{cursor:4,hold:null},'handed'],
    ['waiting for the work to end',{id:5},{cursor:4,hold:'waiting'},'waiting'],
    ['paused',{id:5},{cursor:4,hold:'paused'},'paused'],
    ['no conversation',{id:5},{cursor:4,hold:'unlinked'},'saved'],
    ['about to be handed',{id:5},{cursor:4,hold:null},'saved'],
  ];
  for(const [name,comment,state,expected] of cases)assert.equal(commentMark(comment,state),expected,name);
});

test('the Goals of the running work are Running, together with their parents',()=>{
  const parents={'2':'1','3':'1','1':null,'4':null},parentOf=id=>parents[id]??null;
  const awaiting=new Set(['2','3']),awaits=id=>awaiting.has(id);
  const work=replay({type:'started'},{type:'handed',goals:['2','3']});
  const running=patch=>runningGoals({status:status(patch.work??work),work:patch.work??work,awaits:patch.awaits??awaits,parentOf,selected:patch.selected}).sort();
  assert.deepEqual(running({}),['1','2','3'],'comments on two Goals in one work make both Running');
  assert.deepEqual(running({awaits:id=>id==='3'}),['1','3'],'a Goal leaves Running once the agent replies in it');
  const replied=nextWork(work,{type:'commented',goalId:'3'});
  assert.deepEqual(running({work:replied,awaits:()=>false}),['1','3'],'after replying everywhere, the Goal it last spoke in stays Running while it works');
  assert.deepEqual(running({selected:'4'}),['1','2','3','4']);
  assert.deepEqual(running({work:nextWork(work,{type:'finished'})}),[],'nothing runs once the work ends');
  const background=replay({type:'started'},{type:'handed',goals:['2']},{type:'background',count:1},{type:'finished'});
  assert.deepEqual(running({work:background}),['1','2'],'a background agent keeps its Goal Running');
});

test('a stop is held once while a handed Goal awaits a reply and nothing keeps running',()=>{
  const cases=[
    ['a handed Goal awaits a reply',{handedAwaiting:['1'],background:0,held:false},['1']],
    ['everything was answered',{handedAwaiting:[],background:0,held:false},[]],
    ['a background task will wake it',{handedAwaiting:['1'],background:1,held:false},[]],
    ['the stop right after a hold',{handedAwaiting:['1'],background:0,held:true},[]],
  ];
  for(const [name,facts,expected] of cases)assert.deepEqual(quietGoals(facts),expected,name);
});

test('unknown work events are refused',()=>{
  assert.throws(()=>nextWork(idleWork,{type:'local-command'}),/Unknown agent work event/);
});
