import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile);
const storeUrl=new URL('../lib/goal-store.mjs',import.meta.url).href;

test('SQLite operations roll back ancestor changes and serialize in-process writes without file leases',async t=>{
 const root=await mkdtemp(join(tmpdir(),'chill-sqlite-atomic-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const code=`
 import assert from 'node:assert/strict';
 import {mkdir,writeFile,readFile,rm} from 'node:fs/promises';
 import {join} from 'node:path';
 import * as s from ${JSON.stringify(storeUrl)};
 const root=await s.createGoal({title:'Root',state:'done'});
 const path=join(s.workspaceDirectory(),'goals','2');
 await writeFile(path,'block initial source directory');
 await assert.rejects(s.createGoal({title:'Child',parentId:root.id}));
 assert.equal((await s.readGoal(root.id)).state,'done');
 assert.equal((await s.listGoals()).length,1);
 await rm(path);
 const child=await s.createGoal({title:'Child',parentId:root.id});
 assert.equal(child.id,'2');assert.equal((await s.readGoal(root.id)).state,'idle');
 const messages=await Promise.all(Array.from({length:20},(_,i)=>s.appendAgentComment({goalId:root.id,type:'comment',text:'message '+i})));
 assert.equal(new Set(messages.map(m=>m.id)).size,20);
 assert.equal((await s.readFeedback()).length,20);
 await assert.rejects(s.updateGoal(root.id,{state:'done'}),/unfinished/);
 await s.updateGoal(child.id,{state:'done'});await s.updateGoal(root.id,{state:'done'});
 await assert.rejects(readFile(join(s.workspaceDirectory(),'locks','events','1.json')),{code:'ENOENT'});
 await assert.rejects(readFile(join(s.workspaceDirectory(),'locks','tree','1.json')),{code:'ENOENT'});
 `;
 const result=await execute(process.execPath,['--input-type=module','-e',code],{env:{...process.env,CHILL_AGENT_DATA_DIR:root,CHILL_AGENT_STORAGE:'sqlite'},timeout:20000});
 assert.equal(result.stdout,'');
});

test('separate CLI processes allocate unique event IDs inside SQLite transactions',async t=>{
 const root=await mkdtemp(join(tmpdir(),'chill-sqlite-processes-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const env={...process.env,CHILL_AGENT_DATA_DIR:root,CHILL_AGENT_STORAGE:'sqlite'};
 const run=code=>execute(process.execPath,['--input-type=module','-e',`import * as s from ${JSON.stringify(storeUrl)};${code}`],{env,timeout:20000});
 await run("await s.createGoal({title:'Root'});");
 await Promise.all([run("for(let i=0;i<15;i++)await s.appendAgentComment({goalId:'1',type:'comment',text:'A'+i});"),run("for(let i=0;i<15;i++)await s.appendAgentComment({goalId:'1',type:'comment',text:'B'+i});")]);
 const {stdout}=await run('console.log(JSON.stringify(await s.readFeedback()));');
 const events=JSON.parse(stdout);assert.equal(events.length,30);assert.equal(new Set(events.map(e=>e.id)).size,30);
});
