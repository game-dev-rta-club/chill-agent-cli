import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createMigrationBundle,verifyMigrationBundle} from '../lib/sqlite-migration.mjs';
import {openSqliteWorkspace} from '../lib/sqlite-workspace.mjs';
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'chill-migrate-')),source=join(root,'old'),destination=join(root,'bundle');
 t.after(()=>rm(root,{recursive:true,force:true}));
 async function put(path,value){await mkdir(join(source,path,'..'),{recursive:true});await writeFile(join(source,path),typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value,null,2)+'\n');}
 await put('schema.json',{format:'goal-workspace',version:7});
 // Parent ID larger than child ID; foreign keys must be deferred for import.
 await put('goals/2/goal.json',{id:'2',parentId:'8',title:'Child',state:'waiting'});
 await put('goals/8/goal.json',{id:'8',parentId:null,title:'Root',state:'active'});
 await put('goals/2/briefs/v3.json',{goalId:'2',version:3,body:'# Original',format:'markdown'});
 await put('goals/2/brief.md','# Editable original');
 await put('events/4.json',{id:4,goalId:'2',changeId:10,type:'letter',author:'agent',text:'Question',receivedAt:'2026-10-01'});
 await put('events/7.json',{id:7,goalId:'2',changeId:7,type:'comment',author:'user',text:'Answer',annotations:[{kind:'letter',source:{kind:'comment',eventId:4},text:'Yes'},{kind:'text',source:{kind:'brief',version:3},text:'Keep'}]});
 await put('attachments/image.png',Buffer.from([0,1,255,10]));
 await put('deliveries/7.json',{status:'completed',eventId:7});
 await put('locks/events/1.json',{pid:123,released:true});
 return {root,source,destination,put};
}
test('offline bundle preserves IDs, changed cursors, replies and every auxiliary byte',async t=>{
 const f=await fixture(t),original=await readFile(join(f.source,'events/4.json'));
 const result=await createMigrationBundle(f.source,f.destination);assert.deepEqual(result.records,{goals:2,events:2,briefs:1});
 assert.equal((await verifyMigrationBundle(f.destination)).verified,true);
 assert.deepEqual(await readFile(join(f.source,'events/4.json')),original);
 const archive=(await readFile(join(f.destination,'source.ndjson'),'utf8')).trim().split('\n').map(JSON.parse);
 for(const file of archive)assert.deepEqual(Buffer.from(file.data,'base64'),await readFile(join(f.source,file.path)));
 const store=await openSqliteWorkspace(join(f.destination,'records'));
 assert.equal(store.db.prepare('SELECT change_id FROM events WHERE id=4').get().change_id,10);
 store.db.prepare('UPDATE events SET change_id=11 WHERE id=4').run();store.close();
 await assert.rejects(verifyMigrationBundle(f.destination),/index columns/);
 await assert.rejects(createMigrationBundle(f.source,f.destination),/already exists/);
 await assert.rejects(createMigrationBundle(f.source,join(f.source,'..inside')),/outside/);
});
test('invalid relationships fail without publishing a bundle or changing original files',async t=>{
 const f=await fixture(t);await f.put('events/7.json',{id:7,goalId:'2',changeId:7,annotations:[{source:{kind:'comment',eventId:99}}]});
 await assert.rejects(createMigrationBundle(f.source,f.destination),/Dangling annotation/);
 assert.deepEqual(await readdir(f.root),['old']);
 await f.put('events/7.json',{id:7,goalId:'2',changeId:10});
 await assert.rejects(createMigrationBundle(f.source,f.destination),/UNIQUE/);
 assert.deepEqual(await readdir(f.root),['old']);
});
test('archive corruption is detected before database verification',async t=>{
 const f=await fixture(t);await createMigrationBundle(f.source,f.destination);
 await writeFile(join(f.destination,'source.ndjson'),'broken');
 await assert.rejects(verifyMigrationBundle(f.destination),/checksum/);
});
