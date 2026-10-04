import assert from 'node:assert/strict';
import test from 'node:test';
import {createConversationWindow} from '../public/conversation-window.js';

const messages=Array.from({length:45},(_,i)=>({id:i+1}));
const shown=segments=>segments.filter(s=>s.kind==='messages').flatMap(s=>s.messages.map(e=>e.id));
const gaps=segments=>segments.filter(s=>s.kind==='gap').map(s=>s.messages.map(e=>e.id));

test('read a long conversation from either end without skipping or repeating messages',()=>{
  const view=createConversationWindow();
  assert.deepEqual(shown(view.segments('1',messages)),[43,44,45]);
  assert.deepEqual(view.expand('1',messages,1,42,'top').map(e=>e.id),[1,2,3]);
  assert.deepEqual(gaps(view.segments('1',messages)),[messages.slice(3,42).map(e=>e.id)]);
  assert.deepEqual(view.expand('1',messages,4,42,'bottom').map(e=>e.id),[40,41,42]);
  assert.deepEqual(gaps(view.segments('1',messages)),[messages.slice(3,39).map(e=>e.id)]);
  let side='top';
  while(gaps(view.segments('1',messages)).length) {
    const gap=gaps(view.segments('1',messages))[0];
    const added=view.expand('1',messages,gap[0],gap.at(-1),side);
    assert.equal(added.length,Math.min(3,gap.length));
    side=side==='top'?'bottom':'top';
  }
  assert.deepEqual(shown(view.segments('1',messages)),messages.map(e=>e.id));
  assert.equal(view.canCollapse('1',messages),true);
  view.collapse('1',messages);
  assert.deepEqual(shown(view.segments('1',messages)),[43,44,45]);
  const short=messages.slice(0,5);
  view.segments('short',short);
  assert.deepEqual(view.expand('short',short,1,2,'bottom').map(e=>e.id),[1,2]);
  assert.deepEqual(shown(view.segments('short',short)),[1,2,3,4,5]);
});

test('pending questions stay visible; a referenced older post can be opened on its own',()=>{
  const view=createConversationWindow(),pinned=new Set([12]);
  assert.deepEqual(shown(view.segments('1',messages,pinned)),[12,43,44,45]);
  assert.equal(view.canCollapse('1',messages,pinned),false);
  view.reveal('1',messages,5);
  assert.ok(shown(view.segments('1',messages,pinned)).includes(5));
  view.collapse('1',messages);
  assert.ok(shown(view.segments('1',messages,pinned)).includes(12));
});

test('all unanswered Letters are protected on entry and collapse without caller pinning',()=>{
  const view=createConversationWindow();
  const history=messages.map(e=>({...e,goalId:'1',type:[4,12,22,30].includes(e.id)?'letter':'comment',author:'agent',...(e.id===30?{receivedAt:'2026-09-30T00:00:00Z'}:{})}));
  history[22]={...history[22],author:'user',annotations:[{kind:'letter',source:{kind:'comment',eventId:22},text:'Answered'}]};
  assert.deepEqual(shown(view.segments('1',history)),[4,12,43,44,45]);
  view.reveal('1',history,4);
  assert.equal(view.canCollapse('1',history),false,'a visible unanswered Letter alone cannot enable collapse');
  view.expand('1',history,13,21,'top');
  assert.equal(view.canCollapse('1',history),true);
  view.collapse('1',history);
  assert.deepEqual(shown(view.segments('1',history)),[4,12,43,44,45]);
  const received=history.map(e=>e.id===4?{...e,receivedAt:'2026-09-30T00:00:01Z'}:e);
  assert.equal(view.canCollapse('1',received),false);
  assert.deepEqual(shown(view.segments('1',received)),[12,43,44,45]);
});

test('arrivals and rereading history keep the current reading window; other Goals start independently',()=>{
  const view=createConversationWindow();
  view.segments('1',messages);
  view.expand('1',messages,1,42,'bottom');
  const before=shown(view.segments('1',messages));
  const updated=[...messages,{id:46}];
  assert.deepEqual(shown(view.segments('1',updated)),[...before,46]);
  assert.deepEqual(shown(view.segments('1',updated)),[...before,46]);
  assert.equal(shown(view.segments('2',updated)).length,3);
  assert.deepEqual(view.expand('1',updated,100,200,'top'),[]);
});
