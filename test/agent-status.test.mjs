import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {usageWindows} from '../lib/agent-status.mjs';
const exec=promisify(execFile),thread='00000000-0000-0000-0000-000000000001';
test('usage uses all account buckets and windows, distinguishes missing values, and never includes credits',()=>{
 const result=usageWindows({credits:{balance:'62500'},rateLimits:{primary:{usedPercent:50}},rateLimitsByLimitId:{codex:{primary:{usedPercent:12,windowDurationMins:10080,resetsAt:42},secondary:{usedPercent:null}},other:{primary:{usedPercent:110},secondary:{usedPercent:-5}}}});
 assert.deepEqual(result[0].windows,[{id:'primary',remaining:88,minutes:10080,resetAt:42},{id:'secondary',remaining:null,minutes:null,resetAt:null}]);
 assert.deepEqual(result[1].windows.map(w=>w.remaining),[0,100]);assert.doesNotMatch(JSON.stringify(result),/62500/);assert.deepEqual(usageWindows({}),[]);
});
test('agent read resolves child owner, returns saved settings, and does not issue control requests',async()=>{
 const root=await mkdtemp(join(tmpdir(),'chill-agent-status-'));
 const env={...process.env,CHILL_AGENT_DATA_DIR:root,CHILL_AGENT_CODEX_PATH:new URL('./fake-codex.mjs',import.meta.url).pathname};
 const cli=new URL('../bin/chill-agent.mjs',import.meta.url).pathname;
 const run=(...args)=>exec(process.execPath,[cli,...args],{env});
 await run('create','--title','Root','--thread-id',thread);await run('create','--title','Child','--parent','1');
 const script="import {readAgentStatus} from './lib/agent-status.mjs';console.log(JSON.stringify(await readAgentStatus('2')));";
 const read=async()=>JSON.parse((await exec(process.execPath,['--input-type=module','-e',script],{env,cwd:new URL('..',import.meta.url).pathname})).stdout);
 let result=await read();assert.equal(result.rootId,'1');assert.equal(result.goalId,'2');assert.equal(result.settings.model,'gpt-6-astra');assert.equal(result.usage[0].windows[0].remaining,88);assert.equal(result.work.status,'unknown');assert.deepEqual(result.capabilities,{settings:false,stop:false,resume:false});assert.doesNotMatch(JSON.stringify(result),/private-account|62500/);
 await writeFile(join(root,'fake-history.json'),JSON.stringify({usageFail:true}));result=await read();assert.equal(result.usage,null);assert.equal(result.settings.model,'gpt-6-astra','one failed source does not hide other data');
 const calls=(await readFile(join(root,'fake-requests.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 assert.ok(calls.every(c=>['initialize','thread/read','model/list','account/rateLimits/read','thread/turns/list','thread/queue/list'].includes(c.method)));
});

test('Agent work uses Conversation records without requiring work selection',async()=>{
 const {agentWorkFromRecords}=await import('../lib/agent-status.mjs');
 const goals=[{id:'1',title:'Reply'},{id:'2',title:'Implementation'}];
 const reply={eventId:2,goalId:'1',status:'working',work:{turnId:'new',startedAt:'2026-10-04T00:00:00Z'}};
 assert.deepEqual(agentWorkFromRecords(goals,null,[reply]),{status:'working',goalId:'1',title:'Reply'});
 assert.equal(agentWorkFromRecords(goals,{goalId:'2',turnId:'old'},[reply]).goalId,'1');
 assert.equal(agentWorkFromRecords(goals,{goalId:'2',turnId:'new'},[reply]).goalId,'2');
 assert.equal(agentWorkFromRecords(goals,{goalId:'2',turnId:'new',stoppedAt:'now'},[reply]).goalId,'1');
 assert.equal(agentWorkFromRecords(goals,null,[{...reply,status:'completed'}]).status,'idle');
 assert.equal(agentWorkFromRecords(goals,null,[{...reply,status:'queued'}]).status,'idle');
 assert.equal(agentWorkFromRecords(goals,null,[]).status,'unknown');
 assert.equal(agentWorkFromRecords(goals,{goalId:'2'},[],{status:'working',goalId:'2'}).goalId,'2');
});
