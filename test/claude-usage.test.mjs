import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {readClaudeUsage,claudeUsagePath} from '../lib/claude-usage.mjs';

const now=Date.parse('2026-10-26T07:30:00Z');
async function recorded(value) {
  const path=claudeUsagePath(await mkdtemp(join(tmpdir(),'claude-usage-')));
  if(value!==undefined){await mkdir(dirname(path),{recursive:true});await writeFile(path,typeof value==='string'?value:JSON.stringify(value));}
  return path;
}

test('Claude usage shows the windows the usage mod recorded as percent left', async()=>{
  const path=await recorded({at:'2026-10-26T07:02:09.390Z',rateLimits:[
    {kind:'five_hour',percentUsed:26,resetsAt:'2026-10-26T08:00:00.000Z'},
    {kind:'seven_day',percentUsed:3,resetsAt:'2026-11-02T05:00:00.000Z'},
    {kind:'spend_limit',percentUsed:10,resetsAt:'2026-11-02T05:00:00.000Z'}]});
  assert.deepEqual(await readClaudeUsage({path,now}),{at:'2026-10-26T07:02:09.390Z',usage:[{id:'claude',name:'Claude',windows:[
    {id:'five_hour',remaining:74,minutes:300,resetAt:Date.parse('2026-10-26T08:00:00Z')/1000},
    {id:'seven_day',remaining:97,minutes:10080,resetAt:Date.parse('2026-11-02T05:00:00Z')/1000}]}]});
});

test('Claude usage drops a window past its reset and is unavailable with nothing left', async()=>{
  const path=await recorded({at:'2026-10-26T01:00:00Z',rateLimits:[
    {kind:'five_hour',percentUsed:90,resetsAt:'2026-10-26T05:00:00.000Z'},
    {kind:'seven_day',percentUsed:40,resetsAt:'2026-11-02T05:00:00.000Z'}]});
  assert.deepEqual((await readClaudeUsage({path,now})).usage[0].windows.map(w=>w.id),['seven_day']);
  assert.equal(await readClaudeUsage({path,now:Date.parse('2026-11-03T00:00:00Z')}),null);
});

test('Claude usage is unavailable before anything was recorded, and a torn file fails', async()=>{
  assert.equal(await readClaudeUsage({path:await recorded(),now}),null);
  await assert.rejects(readClaudeUsage({path:await recorded('{"at":'),now}),SyntaxError);
});
