// Inspect or deliberately alter published test records independently of the
// public API. Transport records and editable files remain ordinary files.
import * as fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
function target(path){
 if(typeof path!=='string')return null;
 const m=path.replaceAll('\\','/').match(/^(.*\/workspace)\/(?:goals\/(\d+)\/(goal\.json|briefs\/v(\d+)\.json)|events\/(\d+)\.json)$/);
 if(!m||!existsSync(m[1]+'/workspace.sqlite'))return null;
 return {database:m[1]+'/workspace.sqlite',table:m[5]?'events':m[4]?'briefs':'goals',id:Number(m[5]||m[2]),version:Number(m[4])};
}
export async function readFile(path,encoding){
 const t=target(path);if(!t)return fs.readFile(path,encoding);
 const db=new DatabaseSync(t.database,{readOnly:true});try{
  const row=t.table==='briefs'?db.prepare('SELECT body FROM briefs WHERE goal_id=? AND version=?').get(t.id,t.version):db.prepare(`SELECT body FROM ${t.table} WHERE id=?`).get(t.id);
  if(!row)throw Error('Missing fixture record: '+path);
  return encoding?row.body:Buffer.from(row.body);
 }finally{db.close();}
}
export async function writeFile(path,body,...options){
 const t=target(path);if(!t)return fs.writeFile(path,body,...options);
 if(t.table==='briefs')throw Error('Only Goal and event fixture mutation is supported.');
 const record=JSON.parse(body),db=new DatabaseSync(t.database);try{
  if(t.table==='events')db.prepare('UPDATE events SET body=? WHERE id=?').run(String(body),t.id);
  else db.prepare('UPDATE goals SET parent_id=?,body=? WHERE id=?').run(record.parentId===null?null:Number(record.parentId),String(body),t.id);
 }finally{db.close();}
}
