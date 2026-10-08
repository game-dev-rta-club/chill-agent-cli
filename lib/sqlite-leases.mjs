import {mkdir,open} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {sqliteSelected} from './workspace-records.mjs';
const identity=0x43484c4b;
export function sqliteLockLocation(directory){
 const path=resolve(directory),position=path.lastIndexOf(sep+'workspace'+sep);
 if(position<0)return null;
 const workspace=path.slice(0,position+10);
 // Fold resource spelling conservatively: case-insensitive filesystems must not
 // allow two leases for the same file. Lowercase may only serialize extra work.
 return sqliteSelected(workspace)?{workspace,key:path.slice(position+11).split(sep).join('/').toLowerCase()}:null;
}
const busy=error=>error.errcode===5||error.errcode===6;
const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}};
async function connection(workspace){
 const [major,minor]=process.versions.node.split('.').map(Number);
 if(major<24||(major===24&&minor<15))throw Error('SQLite workspaces require Node.js 24.15 or newer.');
 await mkdir(workspace,{recursive:true,mode:0o700});const path=join(workspace,'coordination.sqlite');
 try{const file=await open(path,'wx',0o600);await file.close();}catch(error){if(error.code!=='EEXIST')throw error;}
 const {DatabaseSync}=await import('node:sqlite'),db=new DatabaseSync(path);
 try{
  db.exec('PRAGMA busy_timeout=0');
  const id=db.prepare('PRAGMA application_id').get().application_id;
  if(id===0){
   db.exec('BEGIN IMMEDIATE');
   try{
    const current=db.prepare('PRAGMA application_id').get().application_id;
    if(current===0){
     if(db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get())throw Error('Refusing a foreign coordination database.');
     db.exec(`CREATE TABLE leases (key TEXT PRIMARY KEY,token TEXT NOT NULL,pid INTEGER NOT NULL CHECK(pid>0)); PRAGMA application_id=${identity}; PRAGMA user_version=1;`);
    }else if(current!==identity)throw Error('Unsupported coordination database.');
    db.exec('COMMIT');
   }catch(error){db.exec('ROLLBACK');throw error;}
  }else if(id!==identity)throw Error('Unsupported coordination database.');
  if(db.prepare('PRAGMA user_version').get().user_version!==1)throw Error('Unsupported coordination schema.');
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');return db;
 }catch(error){db.close();throw error;}
}
export async function withSqliteLease({workspace,key},run,{timeoutMs=10000,message='Store is busy. Try again.'}={}){
 const deadline=Date.now()+timeoutMs,token=randomUUID();let db,owned=false;
 try{
  while(Date.now()<deadline){
   try{
    db??=await connection(workspace);
    db.exec('BEGIN IMMEDIATE');
    try{
     const owner=db.prepare('SELECT pid FROM leases WHERE key=?').get(key);
     if(!owner||!alive(owner.pid)){
      db.prepare('INSERT INTO leases VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET token=excluded.token,pid=excluded.pid').run(key,token,process.pid);owned=true;
     }
     db.exec('COMMIT');
    }catch(error){owned=false;db.exec('ROLLBACK');throw error;}
    if(owned)break;
   }catch(error){if(!busy(error))throw error;}
   await delay(20);
  }
  if(!owned)throw Error(message);
  // No transaction spans caller work, including network I/O or nested resources.
  return await run();
 }finally{
  try{if(owned){
   const until=Date.now()+10000;
   for(;;)try{db.prepare('DELETE FROM leases WHERE key=? AND token=?').run(key,token);break;}catch(error){if(!busy(error)||Date.now()>=until)throw error;await delay(20);}
  }}finally{db?.close();}
 }
}
