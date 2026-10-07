import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createClaudeFeedbackReader} from '../lib/claude-feedback-cache.mjs';
import {readJson,numberedFiles,writeJsonAtomically} from '../lib/storage.mjs';

async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'chill-event-cache-')),events=join(directory,'workspace/events');
 t.after(()=>rm(directory,{recursive:true,force:true}));
 let reads=0;
 const read=async()=>{reads++;return Promise.all((await numberedFiles(events,/^([1-9][0-9]*)\.json$/)).map(id=>readJson(join(events,`${id}.json`))));};
 return {directory,events,read,reads:()=>reads,put:(id,text)=>writeJsonAtomically(join(events,`${id}.json`),{id,text})};
}
test('unchanged polls do not reopen history; folder creation, append and replacement invalidate it',async t=>{
 const f=await fixture(t),read=createClaudeFeedbackReader(f);
 assert.deepEqual(await read(),[]);assert.deepEqual(await read(),[]);assert.equal(f.reads(),1);
 await f.put(1,'first');assert.deepEqual(await read(),[{id:1,text:'first'}]);
 for(let i=0;i<100;i++)await read();assert.equal(f.reads(),2);
 await f.put(2,'second');assert.equal((await read()).length,2);
 await f.put(1,'revised');assert.equal((await read())[0].text,'revised');assert.equal(f.reads(),4);
});
test('a write during the scan is rechecked on the next poll, and a failed scan is retried',async t=>{
 const f=await fixture(t);await f.put(1,'first');let injected=false;
 const read=createClaudeFeedbackReader({directory:f.directory,read:async()=>{const before=await f.read();if(!injected){injected=true;await f.put(2,'concurrent');}return before;}});
 assert.equal((await read()).length,1);assert.equal((await read()).length,2);
 let fail=true;const recovering=createClaudeFeedbackReader({directory:f.directory,read:async()=>{if(fail){fail=false;throw Error('interrupted');}return f.read();}});
 await assert.rejects(recovering(),/interrupted/);assert.equal((await recovering()).length,2);
});
test('replacing an event directory and using another store cannot reuse the snapshot',async t=>{
 const a=await fixture(t),b=await fixture(t);await a.put(1,'a');await b.put(1,'b');
 const ar=createClaudeFeedbackReader(a),br=createClaudeFeedbackReader(b);
 assert.equal((await ar())[0].text,'a');assert.equal((await br())[0].text,'b');
 await rm(a.events,{recursive:true});await a.put(1,'replacement');
 assert.equal((await ar())[0].text,'replacement');assert.equal((await br())[0].text,'b');assert.equal(b.reads(),1);
});
