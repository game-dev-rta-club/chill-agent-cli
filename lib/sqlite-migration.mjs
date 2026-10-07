// Offline, source-preserving migration bundles. No runtime or delivery imports.
import {mkdir,readdir,lstat,readFile,writeFile,open,rm,rename,realpath} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {createInterface} from 'node:readline';
import {join,resolve,relative,dirname,sep,isAbsolute} from 'node:path';
import {openSqliteWorkspace} from './sqlite-workspace.mjs';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
async function fileHash(path){const digest=createHash('sha256');for await(const chunk of createReadStream(path))digest.update(chunk);return digest.digest('hex');}
const safePath=path=>typeof path==='string'&&path.length>0&&!path.includes('\\')&&!path.startsWith('/')&&path.split('/').every(p=>p&&p!=='.'&&p!=='..');
const number=value=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0;
const goalId=value=>typeof value==='string'&&/^[1-9][0-9]*$/.test(value)&&number(Number(value));
function record(path){
 let m;if((m=/^goals\/([1-9][0-9]*)\/goal.json$/.exec(path)))return {table:'goals',id:Number(m[1])};
 if((m=/^goals\/([1-9][0-9]*)\/briefs\/v([1-9][0-9]*)\.json$/.exec(path)))return {table:'briefs',id:Number(m[1]),version:Number(m[2])};
 if((m=/^events\/([1-9][0-9]*)\.json$/.exec(path)))return {table:'events',id:Number(m[1])};
 return null;
}
async function inventory(root){
 const files=[];
 async function visit(path=''){
  for(const name of (await readdir(join(root,path))).sort()){
   const part=path?path+'/'+name:name,full=join(root,part),stat=await lstat(full);
   if(!safePath(part)||stat.isSymbolicLink())throw Error('Migration refuses unsafe paths or symbolic links: '+part);
   if(stat.isDirectory())await visit(part);
   else if(stat.isFile())files.push({path:part,size:stat.size,mode:stat.mode&0o777,sha256:await fileHash(full)});
   else throw Error('Migration accepts regular files only: '+part);
  }
 }
 await visit();return files.sort((a,b)=>a.path.localeCompare(b.path,'en'));
}
function insert(db,path,bytes){
 const type=record(path);if(!type)return;
 const body=bytes.toString('utf8'),value=JSON.parse(body);
 if(!number(type.id))throw Error('Invalid record identity: '+path);
 if(type.table==='goals'){
  if(value.id!==String(type.id)||(value.parentId!==null&&!goalId(value.parentId)))throw Error('Goal identity mismatch: '+path);
  db.prepare('INSERT INTO goals VALUES (?,?,?)').run(type.id,value.parentId===null?null:Number(value.parentId),body);
 }else if(type.table==='events'){
  if(value.id!==type.id||!number(value.changeId)||!goalId(value.goalId))throw Error('Event identity mismatch: '+path);
  db.prepare('INSERT INTO events VALUES (?,?,?,?)').run(type.id,value.changeId,Number(value.goalId),body);
 }else{
  if(value.goalId!==String(type.id)||value.version!==type.version||!number(type.version))throw Error('Brief identity mismatch: '+path);
  db.prepare('INSERT INTO briefs VALUES (?,?,?)').run(type.id,type.version,body);
 }
}
function validateDatabase(db){
 const mismatch=db.prepare(`SELECT id FROM goals WHERE id<>CAST(json_extract(body,'$.id') AS INTEGER) OR parent_id IS NOT CAST(json_extract(body,'$.parentId') AS INTEGER)
  UNION ALL SELECT id FROM events WHERE id<>json_extract(body,'$.id') OR change_id<>json_extract(body,'$.changeId') OR goal_id<>CAST(json_extract(body,'$.goalId') AS INTEGER)
  UNION ALL SELECT goal_id FROM briefs WHERE goal_id<>CAST(json_extract(body,'$.goalId') AS INTEGER) OR version<>json_extract(body,'$.version') LIMIT 1`).get();
 if(mismatch)throw Error('Database index columns differ from record contents.');
 if(db.prepare('PRAGMA foreign_key_check').all().length)throw Error('Dangling Goal reference.');
 const goals=new Map(db.prepare('SELECT id,parent_id FROM goals').all().map(g=>[g.id,g.parent_id]));
 for(const id of goals.keys()){const seen=new Set();let current=id;while(current!==null){if(seen.has(current))throw Error('Goal hierarchy contains a cycle.');seen.add(current);current=goals.get(current);if(current===undefined)throw Error('Dangling parent.');}}
 const invalid=db.prepare(`SELECT e.id FROM events e,json_each(e.body,'$.annotations') n
  WHERE (json_extract(n.value,'$.source.kind')='comment' AND NOT EXISTS
   (SELECT 1 FROM events t WHERE t.id=json_extract(n.value,'$.source.eventId') AND t.goal_id=e.goal_id))
  OR (json_extract(n.value,'$.source.kind')='brief' AND NOT EXISTS
   (SELECT 1 FROM briefs b WHERE b.goal_id=e.goal_id AND b.version=json_extract(n.value,'$.source.version'))) LIMIT 1`).get();
 if(invalid)throw Error('Dangling annotation source in event '+invalid.id);
 if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('SQLite integrity check failed.');
}
function counts(db){return Object.fromEntries(['goals','events','briefs'].map(table=>[table,db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n]));}

export async function createMigrationBundle(source,destination){
 source=await realpath(source);destination=resolve(destination);
 const parent=await realpath(dirname(destination));destination=join(parent,relative(dirname(destination),destination));
 const rel=relative(source,destination);if(!(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel)))throw Error('Destination must be outside the source workspace.');
 try{await lstat(destination);throw Error('Destination already exists.');}catch(error){if(error.code!=='ENOENT')throw error;}
 const schema=JSON.parse(await readFile(join(source,'schema.json'),'utf8'));
 if(schema.format!=='goal-workspace'||schema.version!==7)throw Error('Only legacy workspace schema 7 can be imported.');
 const before=await inventory(source),digest=hash(JSON.stringify(before));
 if(before.some(f=>f.path==='workspace.sqlite'))throw Error('Source contains a SQLite database; refusing ambiguous import.');
 const staging=destination+'.pending-'+randomUUID();await mkdir(staging,{mode:0o700});let store,archive;
 try{
  store=await openSqliteWorkspace(join(staging,'records'));archive=await open(join(staging,'source.ndjson'),'wx',0o600);
  store.db.exec('BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON;');
  for(const entry of before){
   const bytes=await readFile(join(source,entry.path));
   if(bytes.length!==entry.size||hash(bytes)!==entry.sha256)throw Error('Source changed during migration: '+entry.path);
   await archive.writeFile(JSON.stringify({...entry,data:bytes.toString('base64')})+'\n');
   insert(store.db,entry.path,bytes);
  }
  validateDatabase(store.db);store.db.exec('COMMIT');await archive.sync();await archive.close();archive=null;
  if(hash(JSON.stringify(await inventory(source)))!==digest)throw Error('Source changed during migration. Stop writers and retry.');
  const summary=counts(store.db);store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');store.close();store=null;
  const manifest={format:'chill-sqlite-migration',version:1,createdAt:new Date().toISOString(),sourceDigest:digest,archiveSha256:await fileHash(join(staging,'source.ndjson')),files:before.length,bytes:before.reduce((n,f)=>n+f.size,0),records:summary,state:'offline-review'};
  await writeFile(join(staging,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});
  await verifyMigrationBundle(staging);
  // Exclusive destination reservation avoids overwriting another migration.
  await mkdir(destination,{mode:0o700});
  try{for(const name of ['records','source.ndjson','manifest.json'])await rename(join(staging,name),join(destination,name));}
  catch(error){await rm(destination,{recursive:true,force:true});throw error;}
  await rm(staging,{recursive:true,force:true});return manifest;
 }catch(error){if(archive)await archive.close();if(store)store.close();await rm(staging,{recursive:true,force:true});throw error;}
}

export async function verifyMigrationBundle(directory){
 const manifest=JSON.parse(await readFile(join(directory,'manifest.json'),'utf8'));
 if(manifest.format!=='chill-sqlite-migration'||manifest.version!==1||manifest.state!=='offline-review')throw Error('Unsupported migration bundle.');
 if(await fileHash(join(directory,'source.ndjson'))!==manifest.archiveSha256)throw Error('Migration archive checksum mismatch.');
 const {DatabaseSync}=await import('node:sqlite'),db=new DatabaseSync(join(directory,'records/workspace.sqlite'),{readOnly:true});
 const entries=[],seen=new Set();let bytes=0;const imported={goals:0,events:0,briefs:0};
 try{
  if(db.prepare('PRAGMA application_id').get().application_id!==0x43484c4c||db.prepare('PRAGMA user_version').get().user_version!==1)throw Error('Unsupported migration database.');
  for await(const line of createInterface({input:createReadStream(join(directory,'source.ndjson')),crlfDelay:Infinity})){
   const {data,...entry}=JSON.parse(line);
   if(!safePath(entry.path)||seen.has(entry.path))throw Error('Unsafe or duplicate archive path.');seen.add(entry.path);
   const content=Buffer.from(data,'base64');if(content.length!==entry.size||hash(content)!==entry.sha256)throw Error('Archive content mismatch: '+entry.path);
   entries.push(entry);bytes+=entry.size;
   const type=record(entry.path);if(type){
    const row=type.table==='briefs'?db.prepare('SELECT body FROM briefs WHERE goal_id=? AND version=?').get(type.id,type.version):db.prepare(`SELECT body FROM ${type.table} WHERE id=?`).get(type.id);
    if(!row||hash(Buffer.from(row.body))!==entry.sha256)throw Error('Imported record differs: '+entry.path);imported[type.table]++;
   }
  }
  if(hash(JSON.stringify(entries))!==manifest.sourceDigest||entries.length!==manifest.files||bytes!==manifest.bytes)throw Error('Archive inventory mismatch.');
  for(const [table,n] of Object.entries(counts(db)))if(n!==imported[table]||n!==manifest.records[table])throw Error('Record count mismatch: '+table);
  validateDatabase(db);return {verified:true,files:entries.length,bytes,records:imported,sourceDigest:manifest.sourceDigest};
 }finally{db.close();}
}
