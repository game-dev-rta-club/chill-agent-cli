// Storage boundary for published records. Editable sources and transport records
// retain their own paths; callers own validation and operation-level locks.
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {openSqliteWorkspace} from './sqlite-workspace.mjs';

export function sqliteSelected(directory) {
  const requested=process.env.CHILL_AGENT_STORAGE;
  if(requested&&!['json','sqlite'].includes(requested))throw Error('CHILL_AGENT_STORAGE must be json or sqlite.');
  const exists=existsSync(join(directory,'workspace.sqlite'));
  if(exists&&requested==='json')throw Error('This workspace uses SQLite; refusing to create a parallel JSON store.');
  return exists||requested==='sqlite';
}
export async function withDatabase(directory,run) {
  const store=await openSqliteWorkspace(directory);
  try {return run(store.db);} finally {store.close();}
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
