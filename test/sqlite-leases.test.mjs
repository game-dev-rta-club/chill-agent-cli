import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {storeBusy,withStoreLock} from '../lib/storage.mjs';
import {sqliteBusy} from '../lib/sqlite-errors.mjs';
const moduleURL=new URL('../lib/storage.mjs',import.meta.url).href;
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'chill-sqlite-leases-'));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));const workspace=join(root,'workspace');return {root,workspace,lock:join(workspace,'locks','test')};}
test('SQLite leases serialize callers, release after errors, and keep file count bounded',async t=>{
 const f=await fixture(t);let value=0;
 await Promise.all(Array.from({length:12},()=>withStoreLock(f.lock,async()=>{const old=value;await delay(3);value=old+1;})));assert.equal(value,12);
 await assert.rejects(withStoreLock(f.lock,()=>{throw Error('caller failed');}),/caller failed/);
 await withStoreLock(f.lock,()=>withStoreLock(join(f.workspace,'locks','other'),()=>{}));
 for(let i=0;i<500;i++)await withStoreLock(f.lock,()=>{});
 assert.deepEqual(await readdir(f.workspace),['coordination.sqlite']);
 const db=new DatabaseSync(join(f.workspace,'coordination.sqlite'));assert.equal(db.prepare('SELECT count(*) AS n FROM leases').get().n,0);db.close();
});
test('live process cannot be stolen; killed process recovers and token release is fenced',async t=>{
 const f=await fixture(t);
 const source=`import {withStoreLock} from ${JSON.stringify(moduleURL)};await withStoreLock(${JSON.stringify(f.lock)},async()=>{console.log('held');await new Promise(()=>{});});`;
 // An active timer keeps the owner process alive while its callback is pending.
 const child=spawn(process.execPath,['--input-type=module','-e','setInterval(()=>{},1000);'+source],{stdio:['ignore','pipe','pipe']});const exit=once(child,'exit');
 try{
  await Promise.race([once(child.stdout,'data'),exit.then(()=>{throw Error('Owner exited before holding');})]);
  await assert.rejects(withStoreLock(f.lock,()=>assert.fail('stolen'),{timeoutMs:80}),error=>storeBusy(error)&&/busy/.test(error.message));
  await withStoreLock(join(f.workspace,'locks','independent'),()=>{});
  child.kill('SIGKILL');await exit;
  await withStoreLock(f.lock,()=>{});
  const db=new DatabaseSync(join(f.workspace,'coordination.sqlite'));
  try{
   await withStoreLock(f.lock,()=>db.prepare("UPDATE leases SET token='different-owner' WHERE key='locks/test'").run());
   assert.equal(db.prepare('SELECT token FROM leases').get().token,'different-owner');
   db.exec('DELETE FROM leases');
  }finally{db.close();}
 }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await exit;}}
});
// BUSY, LOCKED and PROTOCOL (a WAL transaction start that keeps losing its race), with their extended codes.
test('SQLite contention codes are retried; other failures are not',()=>{
 for(const errcode of [5,6,15,261,517])assert.equal(sqliteBusy({errcode}),true,String(errcode));
 for(const errcode of [1,11,14,undefined])assert.equal(sqliteBusy({errcode}),false,String(errcode));
});
test('independent processes increment under the same SQLite lease',async t=>{
 const f=await fixture(t),counter=join(f.root,'counter');await writeFile(counter,'0');
 const code=`import {withStoreLock} from ${JSON.stringify(moduleURL)};import {readFile,writeFile} from 'node:fs/promises';for(let i=0;i<8;i++)await withStoreLock(${JSON.stringify(f.lock)},async()=>{const value=Number(await readFile(${JSON.stringify(counter)},'utf8'));await new Promise(r=>setTimeout(r,5));await writeFile(${JSON.stringify(counter)},String(value+1));});`;
 await Promise.all(Array.from({length:4},async()=>{const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','ignore','pipe']});let errors='';child.stderr.on('data',b=>errors+=b);const [exitCode]=await once(child,'exit');assert.equal(exitCode,0,errors);}));
 assert.equal(await readFile(counter,'utf8'),'32');
});
test('legacy protocols and foreign databases are not silently adopted',async t=>{
 const f=await fixture(t);await mkdir(f.lock,{recursive:true});await writeFile(join(f.lock,'1.json'),JSON.stringify({pid:process.pid,released:true}));
 await assert.rejects(withStoreLock(f.lock,()=>{}),/offline reconciliation/);
 await rm(f.lock,{recursive:true,maxRetries:10,retryDelay:100});
 const db=new DatabaseSync(join(f.workspace,'coordination.sqlite'));db.exec('CREATE TABLE foreign_data (value TEXT)');db.close();
 await assert.rejects(withStoreLock(f.lock,()=>{}),/foreign/);
 const check=new DatabaseSync(join(f.workspace,'coordination.sqlite'));assert.ok(check.prepare("SELECT name FROM sqlite_master WHERE name='foreign_data'").get());check.close();
});
