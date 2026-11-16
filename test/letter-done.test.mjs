import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const execute=promisify(execFile),cli=fileURLToPath(new URL('../bin/chill-agent.mjs',import.meta.url));

// The Web's Done button: the user closes a Letter and may take only their own Done back.
test('the user marks a Letter Done and takes back only their own Done',async t=>{
  const root=await mkdtemp(join(tmpdir(),'chill-letter-done-'));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  const env={...process.env,CHILL_AGENT_DATA_DIR:root};
  const run=async(...args)=>JSON.parse((await execute(process.execPath,[cli,...args],{env})).stdout);
  const store=async(name,...args)=>JSON.parse((await execute(process.execPath,['--input-type=module','-e',`import {${name}} from ${JSON.stringify(new URL('../lib/goal-store.mjs',import.meta.url).href)};console.log(JSON.stringify(await ${name}(...${JSON.stringify(args)})));`],{env})).stdout);
  await run('create','--title','Letters');
  const mine=await run('reply','--id','1','--ask','Close me','--text','Q'),theirs=await run('reply','--id','1','--ask','Agent closes','--text','Q');
  const done=await store('closeLetter','1',mine.id,'','user');
  assert.deepEqual([done.status,done.receivedBy,done.changed],['received','user',true]);
  const back=await store('reopenLetter','1',mine.id);
  assert.deepEqual([back.status,back.receivedAt,back.receivedBy,back.changed],['open',undefined,undefined,true]);
  assert.ok(back.changeId>done.changeId,'open Webs learn of the change');
  assert.equal((await store('reopenLetter','1',mine.id)).changed,false,'an open Letter stays open');
  await run('close-letter','--id','1','--event',String(theirs.id));
  const kept=await store('reopenLetter','1',theirs.id);
  assert.deepEqual([kept.status,kept.changed],['received',false],'a Letter the agent closed stays closed');
  await assert.rejects(store('reopenLetter','1',9999),/Letter not found/);
});
