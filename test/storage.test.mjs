import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod,mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {writeJsonAtomically} from '../lib/storage.mjs';

test('concurrent atomic writes to one file all succeed and leave one complete value',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'chill-storage-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const path=join(dir,'value.json');
 // Windows reports EPERM when two replacements of the same file overlap.
 const results=await Promise.allSettled(Array.from({length:200},(_,i)=>writeJsonAtomically(path,{i})));
 assert.deepEqual(results.filter(r=>r.status==='rejected').map(r=>r.reason.code),[]);
 assert.equal(typeof JSON.parse(await readFile(path,'utf8')).i,'number');
 assert.deepEqual(await readdir(dir),['value.json']);
});
test('on Windows a write outlasts another process reading the file and a hold of several seconds',{skip:process.platform!=='win32'&&'only Windows refuses to replace an open file',timeout:60000},async t=>{
 const dir=await mkdtemp(join(tmpdir(),'chill-storage-'));t.after(()=>rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:100}));
 const path=join(dir,'value.json');await writeJsonAtomically(path,{i:0});
 // Another process reads the record as hooks and Web do; each open refuses a replacement.
 const reader=spawn(process.execPath,['-e',`const fs=require('fs');const end=Date.now()+3000;while(Date.now()<end){try{fs.readFileSync(${JSON.stringify(path)})}catch{}}`]);
 const exited=new Promise(resolve=>reader.on('exit',resolve));
 for(let i=1;i<=20;i++)await writeJsonAtomically(path,{i});
 await exited;assert.equal(JSON.parse(await readFile(path,'utf8')).i,20);
 // A read-only file refuses replacement (EPERM) as one an antivirus holds does.
 await chmod(path,0o444);setTimeout(()=>chmod(path,0o644),5000);
 await writeJsonAtomically(path,{i:21});assert.equal(JSON.parse(await readFile(path,'utf8')).i,21);
});
