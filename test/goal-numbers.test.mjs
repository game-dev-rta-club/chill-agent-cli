import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const execute=promisify(execFile),cli=fileURLToPath(new URL('../bin/chill-agent.mjs',import.meta.url));
const {numberEvents,readFeedback,goalNumbers}=await import('../lib/goal-store.mjs');
const {listWebRecords}=await import('../lib/web-records.mjs');

for(const storage of ['sqlite','json']){
 test(`comments and Letters are numbered within their Goal on read, and a deleted comment keeps its number (${storage})`,async t=>{
  const root=await mkdtemp(join(tmpdir(),'chill-goal-numbers-'));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  const env={...process.env,CHILL_AGENT_DATA_DIR:root,CHILL_AGENT_CODEX_PATH:'/missing/codex',...(storage==='json'?{CHILL_AGENT_STORAGE:'json'}:{})};
  const run=async(...args)=>JSON.parse((await execute(process.execPath,[cli,...args],{env})).stdout);
  await run('create','--title','One');await run('create','--title','Two');
  const a=await run('comment','--id','1','--text','first');
  await run('comment','--id','2','--text','other Goal');
  const letter=await run('comment','--id','1','--ask','Ask','--text','Question');
  const gone=await run('comment','--id','1','--text','to delete');
  await run('delete-comment','--id','1','--event',String(gone.id));
  const last=await run('comment','--id','1','--text','after the deletion');
  const saved={...process.env};t.after(()=>{for(const key of ['CHILL_AGENT_DATA_DIR','CHILL_AGENT_STORAGE'])if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];});
  process.env.CHILL_AGENT_DATA_DIR=root;if(storage==='json')process.env.CHILL_AGENT_STORAGE='json';else delete process.env.CHILL_AGENT_STORAGE;
  const events=await readFeedback();
  const numbered=new Map((await numberEvents(events)).map(e=>[e.id,e.number]));
  assert.deepEqual([a.id,letter.id,gone.id,last.id].map(id=>numbered.get(id)),[1,2,3,4],'the deleted comment still counts, so later numbers do not move');
  assert.equal(numbered.get(events.find(e=>e.goalId==='2').id),1,'each Goal counts from 1');
  assert.deepEqual(goalNumbers(events),new Map([...numbered]));
  const web=(await listWebRecords()).find(g=>g.id==='1');
  assert.deepEqual(web.conversation.map(e=>e.number).sort(),[1,2,3,4]);
 });
}
