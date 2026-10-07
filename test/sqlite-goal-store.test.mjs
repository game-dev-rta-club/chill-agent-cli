import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const execute=promisify(execFile),cli=new URL('../bin/chill-agent.mjs',import.meta.url).pathname;

test('public Goal commands persist SQLite records, preserve Letter relationships and reject parallel JSON',async t=>{
  const root=await mkdtemp(join(tmpdir(),'chill-sqlite-goals-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const env={...process.env,CHILL_AGENT_DATA_DIR:root,CHILL_AGENT_STORAGE:'sqlite',CHILL_AGENT_CODEX_PATH:'/missing/codex'};
  const run=async(...args)=>JSON.parse((await execute(process.execPath,[cli,...args],{env})).stdout);
  const goal=await run('create','--title','SQLite root');
  assert.equal(await readFile(goal.briefPath,'utf8'),'');
  const child=await run('create','--title','Child','--parent','1');
  assert.equal(child.parentId,'1');
  await writeFile(goal.briefPath,'# Plan\nSQLite content');
  assert.equal((await run('brief','update','--id','1')).version,1);
  assert.equal((await run('brief','update','--id','1')).changed,false);
  const letter=await run('letter','--id','1','--title','Ready','--text','Question');
  await run('comment','--id','2','--text','Other goal');
  const input=join(root,'reply.json');
  await writeFile(input,JSON.stringify({requestId:'sqlite-reply-123',annotations:[{kind:'letter',source:{kind:'comment',eventId:letter.id},text:'Yes'}]}));
  // feedback also prints its transport receipt; inspect the persisted conversation.
  await execute(process.execPath,[cli,'feedback','--id','1','--input-file',input],{env});
  const before=await run('show','--id','1');
  assert.equal(before.letters.length,0);
  await execute(process.execPath,[cli,'feedback','--id','1','--input-file',input],{env});
  assert.equal((await run('show','--id','1')).conversation.length,before.conversation.length);
  const pending=await run('letter','--id','1','--title','Notice','--text','Result');
  await run('close-letter','--id','1','--event',String(pending.id));
  const shown=await run('show','--id','1');
  assert.equal(shown.brief.body,'# Plan\nSQLite content');
  assert.equal(shown.letters.length,0);
  assert.ok(shown.conversation.some(e=>e.id===pending.id&&e.changeId>e.id));
  delete env.CHILL_AGENT_STORAGE;
  assert.equal((await run('show','--id','1')).goal.title,'SQLite root','reopen detects persistent backend');
  env.CHILL_AGENT_STORAGE='json';
  await assert.rejects(run('show','--id','1'),/parallel JSON/);
  await assert.rejects(readFile(join(root,'workspace/schema.json')),{code:'ENOENT'});
  await assert.rejects(readFile(join(root,'workspace/goals/1/goal.json')),{code:'ENOENT'});
});

test('isolated SQLite Web accepts a reply and CLI reads it after server shutdown',async t=>{
  const {spawn}=await import('node:child_process');const {once}=await import('node:events');
  const root=await mkdtemp(join(tmpdir(),'chill-sqlite-web-'));
  const env={...process.env,PORT:'0',CHILL_AGENT_DATA_DIR:root,CHILL_AGENT_STORAGE:'sqlite',CHILL_AGENT_CODEX_PATH:'/missing/codex'};
  const run=async(...args)=>JSON.parse((await execute(process.execPath,[cli,...args],{env})).stdout);
  await run('create','--title','Web SQLite');
  const letter=await run('letter','--id','1','--title','Choice','--text','Choose');
  const child=spawn(process.execPath,[new URL('../server.mjs',import.meta.url).pathname],{env,stdio:['ignore','pipe','pipe']});
  const exit=once(child,'exit');
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await exit;await rm(root,{recursive:true,force:true});});
  const url=await new Promise((resolve,reject)=>{
    let output='';child.stdout.on('data',chunk=>{output+=chunk;const match=output.match(/http:\/\/127\.0\.0\.1:\d+/);if(match)resolve(match[0]);});
    child.stderr.on('data',chunk=>output+=chunk);child.once('error',reject);child.once('exit',()=>reject(Error(output)));
  });
  assert.equal((await (await fetch(url+'/api/goals?view=web')).json())[0].title,'Web SQLite');
  const response=await fetch(url+'/api/goals/1/feedback',{method:'POST',headers:{'Content-Type':'application/json',Origin:url},body:JSON.stringify({text:'Web reply',annotations:[{kind:'letter',source:{kind:'comment',eventId:letter.id},text:'Yes'}]})});
  assert.equal(response.status,201,await response.clone().text());
  const receipt=await response.json();assert.equal(receipt.feedback.text,'Web reply');
  const changes=await (await fetch(url+'/api/events?since='+letter.changeId)).json();
  assert.ok(changes.events.some(event=>event.id===receipt.feedback.id));
  child.kill('SIGTERM');await exit;
  const shown=await run('show','--id','1');assert.equal(shown.letters.length,0);
  assert.ok(shown.conversation.some(event=>event.text==='Web reply'));
});
