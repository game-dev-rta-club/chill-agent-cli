import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {mkdtemp,chmod,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {once} from 'node:events';
import {withDesktopSettings,resumeDesktopTurn} from '../lib/desktop-settings.mjs';
import {agentMarkup} from '../public/agent-menu.js';
test('optional Desktop IPC validates response, preserves condition and handles fragmented frames',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ipc-')),path=join(dir,'socket'),calls=[];
 const server=net.createServer(s=>{let b=Buffer.alloc(0);s.on('data',c=>{b=Buffer.concat([b,c]);while(b.length>=4&&b.length>=4+b.readUInt32LE()){const n=b.readUInt32LE(),m=JSON.parse(b.subarray(4,n+4));b=b.subarray(n+4);calls.push(m);const r=Buffer.from(JSON.stringify({type:'response',requestId:m.requestId,resultType:'success',result:m.method==='initialize'?{clientId:'test-client'}:{applied:false}})),h=Buffer.alloc(4);h.writeUInt32LE(r.length);s.write(h.subarray(0,2));s.write(Buffer.concat([h.subarray(2),r]));}});});
 server.listen(path);await once(server,'listening');await chmod(path,0o600);
 try{const r=await withDesktopSettings(update=>update('thread',{model:'model',effort:'high'},{ifModelEquals:'previous'}),{platform:'darwin',path});assert.equal(r.applied,false);assert.equal(calls[1].sourceClientId,'test-client');assert.equal(calls[1].version,2);assert.deepEqual(calls[1].params.condition,{ifModelEquals:'previous'});
 await assert.rejects(withDesktopSettings(()=>{}, {platform:'win32',path}));await chmod(path,0o666);await assert.rejects(withDesktopSettings(()=>{}, {platform:'darwin',path}),/Invalid Desktop/);
 }finally{server.close();await rm(dir,{recursive:true,force:true});}
});
test('unsupported Agent UI is plain settings without an unsupported explanation',()=>{
 const data={connected:true,settings:{model:'m',label:'Model',reasoning:'high'},capabilities:{settings:false},usage:[],queue:{items:[]}};
 const plain=agentMarkup(data);assert.doesNotMatch(plain,/<select|Codexで|プラットフォーム/);
 const edit=agentMarkup({...data,capabilities:{settings:true},models:[{id:'m',label:'Model',efforts:['high']}]});assert.match(edit,/<select/);assert.doesNotMatch(edit,/Next run|次回の実行から/);
});
test('resume IPC sends normalized plain text required by the Desktop renderer',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ipc-resume-')),path=join(dir,'socket'),calls=[];
 const server=net.createServer(socket=>{let buffer=Buffer.alloc(0);socket.on('data',chunk=>{
  buffer=Buffer.concat([buffer,chunk]);
  while(buffer.length>=4&&buffer.length>=4+buffer.readUInt32LE()){
   const size=buffer.readUInt32LE(),m=JSON.parse(buffer.subarray(4,size+4));buffer=buffer.subarray(size+4);calls.push(m);
   const body=Buffer.from(JSON.stringify({type:'response',requestId:m.requestId,resultType:'success',result:m.method==='initialize'?{clientId:'test-client'}:{result:{turn:{id:'new-turn'}}}})),header=Buffer.alloc(4);header.writeUInt32LE(body.length);socket.write(Buffer.concat([header,body]));
  }
 });});
 server.listen(path);await once(server,'listening');await chmod(path,0o600);
 try{
  await resumeDesktopTurn('thread','続きを進めてください','request-id',{platform:'darwin',path});
  const sent=calls[1];assert.equal(sent.method,'thread-follower-start-turn');assert.equal(sent.version,2);
  assert.equal(sent.params.turnStart.request.clientUserMessageId,'request-id');
  const input=sent.params.turnStart.request.input;
  assert.deepEqual(input,[{type:'text',text:'続きを進めてください',text_elements:[]}]);
  // Desktop inspects UI spans synchronously, before App Server fills defaults.
  assert.equal(input.some(p=>p.type==='text'&&p.text_elements.some(e=>e.placeholder==='aeon-continuation')),false);
 }finally{server.close();await rm(dir,{recursive:true,force:true});}
});
