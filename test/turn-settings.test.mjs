import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,appendFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readTurnSettings} from '../lib/turn-settings.mjs';
const context=(id,model,effort)=>JSON.stringify({timestamp:'2026-10-04',type:'turn_context',payload:{turn_id:id,model,effort}});
test('Activity settings match the actual turn across chunks, preserve history, and update on append',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'turn-settings-')),path=join(dir,'rollout.jsonl');
 try{
 await writeFile(path,context('old','astra','medium')+'\n'+JSON.stringify({type:'response_item',payload:{text:'x'.repeat(300000)}})+'\n'+context('new','sol','high')+'\n');
 assert.deepEqual(await readTurnSettings(path,'old'),{model:'astra',reasoning:'medium'});
 assert.deepEqual(await readTurnSettings(path,'new'),{model:'sol',reasoning:'high'});
 assert.equal(await readTurnSettings(path,'unknown'),null);
 await appendFile(path,context('new','astra','xhigh')+'\n');
 assert.deepEqual(await readTurnSettings(path,'new'),{model:'astra',reasoning:'xhigh'});
 assert.deepEqual(await readTurnSettings(path,'old'),{model:'astra',reasoning:'medium'});
 assert.equal(await readTurnSettings('/missing','old'),null);
 }finally{await rm(dir,{recursive:true,force:true});}
});
