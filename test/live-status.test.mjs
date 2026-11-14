import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createLiveStatus} from '../lib/live-status.mjs';

async function harness(t,{allowed=async()=>true,...options}={}){
  const state={presence:{status:'working'},summary:{rootId:'1',title:'Root',count:0},signature:1,reads:0,update:'idle'};
  const live=createLiveStatus({allowed,tickMs:20,pingMs:60000,recountMs:60000,...options,read:{
    presence:async()=>state.presence,
    summary:async()=>{state.reads++;return state.summary;},
    signature:async()=>state.signature,
    ...(options.withUpdate?{update:async()=>state.update}:{}),
  }});
  const server=createServer((request,response)=>response.end());
  server.on('upgrade',(request,socket,head)=>void live.upgrade(request,socket,head));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>{live.close();server.close();});
  const url=path=>`ws://127.0.0.1:${server.address().port}${path}`;
  return {state,live,server,url};
}
function messages(socket){
  const queue=[],waiting=[];
  socket.addEventListener('message',event=>{const data=JSON.parse(event.data);const next=waiting.shift();next?next(data):queue.push(data);});
  return ()=>queue.length?Promise.resolve(queue.shift()):new Promise(resolve=>waiting.push(resolve));
}

test('a live socket sends the current state, then only what changes',async t=>{
  const {state,url}=await harness(t);
  const socket=new WebSocket(url('/api/goals/1/live'));const next=messages(socket);
  assert.deepEqual(await next(),{presence:{status:'working'},summary:{rootId:'1',title:'Root',count:0}});
  state.presence={status:'idle'};
  assert.deepEqual(await next(),{presence:{status:'idle'}},'an agent going idle reaches the tab without waiting for a poll');
  state.summary={rootId:'1',title:'Root',count:1};state.signature=2;
  assert.deepEqual(await next(),{summary:{rootId:'1',title:'Root',count:1}},'a new unread reply reaches the tab');
  socket.close();
});

test('the update phase reaches every open page as it changes',async t=>{
  const {state,url}=await harness(t,{withUpdate:true});
  const socket=new WebSocket(url('/api/goals/1/live'));const next=messages(socket);
  assert.deepEqual((await next()).update,{phase:'idle'});
  state.update='restarting';
  assert.deepEqual(await next(),{update:{phase:'restarting'}},'a background tab hears the update start');
  socket.close();
});

test('counts are read again only when the signature changes',async t=>{
  const {state,live,url}=await harness(t);
  const socket=new WebSocket(url('/api/goals/1/live'));const next=messages(socket);await next();
  await live.tick();const reads=state.reads;
  await live.tick();await live.tick();
  assert.equal(state.reads,reads,'an unchanged store is not recounted every tick');
  state.signature=3;await live.tick();
  assert.equal(state.reads,reads+1);
  socket.close();
});

test('a socket the gate refuses, or another path, is not opened',async t=>{
  const {url}=await harness(t,{allowed:async request=>request.headers.origin==='http://allowed.example'});
  for(const path of ['/api/goals/1/live','/api/goals/1/other']){
    const socket=new WebSocket(url(path));
    const [event]=await Promise.race([once(socket,'error'),once(socket,'open')]);
    assert.equal(event.type,'error',`${path} must not open`);
  }
});

test('closing ends every open socket so the server can stop',async t=>{
  const {live,server,url}=await harness(t);
  const socket=new WebSocket(url('/api/goals/1/live'));await once(socket,'open');
  assert.equal(live.size,1);
  const closed=once(socket,'close');live.close();await closed;
  assert.equal(live.size,0);
  await new Promise(resolve=>server.close(resolve));
});
