import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openSqliteWorkspace} from '../lib/sqlite-workspace.mjs';
import {withSqliteLease} from '../lib/sqlite-leases.mjs';
import {withSqliteTransaction,withDatabase} from '../lib/workspace-records.mjs';

async function directory(t){const dir=await mkdtemp(join(tmpdir(),'chill-busy-'));t.after(()=>rm(dir,{recursive:true,force:true}));return dir;}
// Deterministically reproduce the WAL recovery error seen when parallel hooks
// reopen a database. Real connections/schema/leases exercise the retry boundary.
function failFirstIdentityRead(t,error){
 const original=DatabaseSync.prototype.prepare;let failures=0;
 t.mock.method(DatabaseSync.prototype,'prepare',function(sql,...args){
  if(sql==='PRAGMA application_id'&&!failures++){return {get(){throw error;}};}
  return original.call(this,sql,...args);
 });
}
for(const kind of ['workspace','coordination'])test(`${kind} reopens after SQLITE_BUSY_RECOVERY without repeating caller work`,async t=>{
 const dir=await directory(t),error=Object.assign(Error('database is locked'),{errcode:261});
 failFirstIdentityRead(t,error);
 if(kind==='workspace'){
  const store=await openSqliteWorkspace(dir);
  try{assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');}finally{store.close();}
 }else{
  let calls=0;await withSqliteLease({workspace:dir,key:'feedback'},()=>{calls++;});assert.equal(calls,1);
  const db=new DatabaseSync(join(dir,'coordination.sqlite'));
  try{assert.equal(db.prepare('SELECT count(*) AS n FROM leases').get().n,0);}finally{db.close();}
 }
});
test('writer acquisition retries extended busy before, never during, the transaction callback',async t=>{
 const dir=await directory(t),store=await openSqliteWorkspace(dir);store.close();
 const original=DatabaseSync.prototype.exec;let busy=false,calls=0;
 t.mock.method(DatabaseSync.prototype,'exec',function(sql){
  if(sql==='BEGIN IMMEDIATE'&&!busy){busy=true;throw Object.assign(Error('database is locked'),{errcode:773});}
  return original.call(this,sql);
 });
 await withSqliteTransaction(dir,async()=>{calls++;await withDatabase(dir,db=>db.prepare('INSERT INTO goals VALUES (1,NULL,?)').run('{}'));});
 assert.equal(calls,1);assert.equal(await withDatabase(dir,db=>db.prepare('SELECT count(*) AS n FROM goals').get().n),1);
 const callbackError=Object.assign(Error('caller contention'),{errcode:517});
 await assert.rejects(withSqliteTransaction(dir,()=>{calls++;throw callbackError;}),e=>e===callbackError);
 assert.equal(calls,2,'transaction bodies with possible side effects are never replayed');
});
test('non-contention database errors still escape unchanged',async t=>{
 const dir=await directory(t),error=Object.assign(Error('disk I/O error'),{errcode:266});
 failFirstIdentityRead(t,error);await assert.rejects(openSqliteWorkspace(dir),e=>e===error);
});
