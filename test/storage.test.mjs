import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {writeJsonAtomically} from '../lib/storage.mjs';

test('concurrent atomic writes to one file all succeed and leave one complete value',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'chill-storage-'));t.after(()=>rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
 const path=join(dir,'value.json');
 // Windows reports EPERM when two replacements of the same file overlap.
 const results=await Promise.allSettled(Array.from({length:200},(_,i)=>writeJsonAtomically(path,{i})));
 assert.deepEqual(results.filter(r=>r.status==='rejected').map(r=>r.reason.code),[]);
 assert.equal(typeof JSON.parse(await readFile(path,'utf8')).i,'number');
 assert.deepEqual(await readdir(dir),['value.json']);
});
