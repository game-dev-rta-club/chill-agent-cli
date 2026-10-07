// Storage boundary for published records. Editable sources and transport records
// retain their own paths; callers own validation; SQLite operations share a transaction context.
import {AsyncLocalStorage} from 'node:async_hooks';
import {setTimeout as delay} from 'node:timers/promises';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {openSqliteWorkspace} from './sqlite-workspace.mjs';

export function sqliteSelected(directory) {
  const requested=process.env.CHILL_AGENT_STORAGE;
  if(requested&&!['json','sqlite'].includes(requested))throw Error('CHILL_AGENT_STORAGE must be json or sqlite.');
  const exists=existsSync(join(directory,'workspace.sqlite'));
  if(exists&&requested==='json')throw Error('This workspace uses SQLite; refusing to create a parallel JSON store.');
  return exists||requested==='sqlite'||(!requested&&!existsSync(join(directory,'schema.json')));
}
const transactions=new AsyncLocalStorage();
export async function withDatabase(directory,run) {
  const current=transactions.getStore();
  if(current?.directory===directory)return run(current.db);
  const store=await openSqliteWorkspace(directory);
  try {return await run(store.db);} finally {store.close();}
}
export function decode(row) {return row?JSON.parse(row.body):null;}
export async function saveRecord(directory,kind,value,exclusive=false) {
  return withDatabase(directory,db=>{
    const body=JSON.stringify(value);
    if(kind==='goal') {
      const suffix=exclusive?'':' ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id, body=excluded.body';
      db.prepare(`INSERT INTO goals(id,parent_id,body) VALUES (?,?,?)${suffix}`).run(Number(value.id),value.parentId===null?null:Number(value.parentId),body);
    } else if(kind==='event') {
      const suffix=exclusive?'':' ON CONFLICT(id) DO UPDATE SET change_id=excluded.change_id, goal_id=excluded.goal_id, body=excluded.body';
      db.prepare(`INSERT INTO events(id,change_id,goal_id,body) VALUES (?,?,?,?)${suffix}`).run(value.id,value.changeId,Number(value.goalId),body);
    } else if(kind==='brief') {
      db.prepare('INSERT INTO briefs(goal_id,version,body) VALUES (?,?,?)').run(Number(value.goalId),value.version,body);
    } else throw Error('Unknown record kind.');
  });
}

// Validation reads and writes share one connection and snapshot. Waiting for a
// different writer must yield: blocking SQLite waits would stall a transaction
// in this same Node process while it completes local filesystem reads.
export async function withSqliteTransaction(directory,run) {
  if(transactions.getStore()?.directory===directory)return run();
  const store=await openSqliteWorkspace(directory);
  let begun=false;
  try {
    store.db.exec('PRAGMA busy_timeout=0');
    const deadline=Date.now()+10000;
    for(;;) {
      try {store.db.exec('BEGIN IMMEDIATE');begun=true;break;}
      catch(error) {
        if(error.errcode!==5||Date.now()>=deadline)throw error;
        await delay(10);
      }
    }
    const result=await transactions.run({directory,db:store.db},run);
    store.db.exec('COMMIT');begun=false;return result;
  } catch(error) {
    if(begun)store.db.exec('ROLLBACK');
    throw error;
  } finally {store.close();}
}
