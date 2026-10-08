import {mkdir, open, access} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';

const applicationId=0x43484c4c; // CHLL: never adopt another application's database.
const schemaVersion=1;

// Default for new workspaces; legacy JSON requires explicit migration.
export async function openSqliteWorkspace(directory) {
  const deadline=Date.now()+10000;
  for(;;)try{return await openOnce(directory);}catch(error){
    // A concurrent first opener can change the journal mode after inspection.
    // Reopen from scratch; openOnce closes failed connections before yielding.
    if(![5,6].includes(error.errcode)||Date.now()>=deadline)throw error;
    await delay(20);
  }
}
async function openOnce(directory) {
  const [major,minor]=process.versions.node.split('.').map(Number);
  if(major<24||(major===24&&minor<15))throw Error('SQLite workspaces require Node.js 24.15 or newer.');
  try {
    await access(join(directory,'schema.json'));
    throw Error('Legacy workspace requires explicit migration into a separate directory.');
  } catch(error) { if(error.code!=='ENOENT')throw error; }
  const {DatabaseSync}=await import('node:sqlite');
  await mkdir(directory,{recursive:true,mode:0o700});
  const path=join(directory,'workspace.sqlite');
  try { const file=await open(path,'wx',0o600);await file.close(); }
  catch(error) { if(error.code!=='EEXIST')throw error; }
  const db=new DatabaseSync(path,{timeout:5000});
  try {
    // Validate before changing journal mode or schema, including on reopening.
    const inspect=()=>{
      const id=db.prepare('PRAGMA application_id').get().application_id;
      const version=db.prepare('PRAGMA user_version').get().user_version;
      const tables=db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
      return {id,version,empty:id===0&&version===0&&tables.length===0};
    };
    let state=inspect();
    if(state.empty) {
      db.exec('BEGIN IMMEDIATE');
      try {
        state=inspect();
        if(state.empty) {
          db.exec(`
          CREATE TABLE goals (id INTEGER PRIMARY KEY CHECK(id>0), parent_id INTEGER REFERENCES goals(id), body TEXT NOT NULL CHECK(json_valid(body)));
          CREATE INDEX goals_parent ON goals(parent_id);
          CREATE TABLE events (id INTEGER PRIMARY KEY CHECK(id>0), change_id INTEGER NOT NULL UNIQUE CHECK(change_id>0), goal_id INTEGER NOT NULL REFERENCES goals(id), body TEXT NOT NULL CHECK(json_valid(body)));
          CREATE INDEX events_goal_change ON events(goal_id,change_id);
          CREATE TABLE briefs (goal_id INTEGER NOT NULL REFERENCES goals(id), version INTEGER NOT NULL CHECK(version>0), body TEXT NOT NULL CHECK(json_valid(body)), PRIMARY KEY(goal_id,version));
          PRAGMA application_id=${applicationId};
          PRAGMA user_version=${schemaVersion};
          `);
        } else if(state.id!==applicationId||state.version!==schemaVersion)throw Error('Unsupported SQLite workspace identity or schema version.');
        db.exec('COMMIT');
      } catch(error) {db.exec('ROLLBACK');throw error;}
    } else if(state.id!==applicationId||state.version!==schemaVersion)throw Error('Unsupported SQLite workspace identity or schema version.');
    db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    return {
      db,
      path,
      // Keep transactions synchronous and short; never hold a write lock over I/O.
      transaction(run) {
        if(typeof run!=='function'||run.constructor?.name==='AsyncFunction')throw Error('SQLite transaction requires a synchronous callback.');
        db.exec('BEGIN IMMEDIATE');
        try {
          const value=run(db);
          if(value&&typeof value.then==='function')throw Error('SQLite transaction must not return a Promise.');
          db.exec('COMMIT');return value;
        } catch(error) { db.exec('ROLLBACK');throw error; }
      },
      close:()=>db.close(),
    };
  } catch(error) { db.close();throw error; }
}
