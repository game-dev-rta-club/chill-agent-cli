import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile),url=new URL('../lib/goal-store.mjs',import.meta.url).href;
for(const backend of ['json','sqlite'])test(`${backend} pages are bounded, scoped and include off-page answer targets`,async t=>{
 const root=await mkdtemp(join(tmpdir(),'chill-pages-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const code=`
 import assert from 'node:assert/strict';import * as s from ${JSON.stringify(url)};
 await s.createGoal({title:'A'});await s.createGoal({title:'B'});
 const letter=await s.appendAgentComment({goalId:'1',type:'letter',title:'Choice',text:'Choose'});
 for(let i=0;i<12;i++)await s.appendAgentComment({goalId:'1',type:'comment',text:'Message '+i});
 await s.appendAgentComment({goalId:'2',type:'comment',text:'Other'});
 const answer=await s.appendFeedback({goalId:'1',text:'Answer',annotations:[{kind:'letter',source:{kind:'comment',eventId:letter.id},text:'Yes'}]});
 const first=await s.readConversationPage('1',{limit:4});
 assert.equal(first.events.length,4);assert.equal(first.events.at(-1).id,answer.id);assert.equal(first.answerTargets[0].id,letter.id);assert.equal(first.hasMore,true);
 const ids=first.events.map(e=>e.id);let page=first;
 while(page.hasMore){page=await s.readConversationPage('1',{limit:4,before:page.nextBefore});ids.push(...page.events.map(e=>e.id));}
 assert.equal(ids.length,14);assert.equal(new Set(ids).size,14);assert.equal(page.nextBefore,null);
 await s.closeLetter('1',letter.id);
 const newer=await s.listEventsSince(first.cursor);
 // The answered Letter is already closed semantically, so close is a no-op.
 assert.equal(newer.events.length,0);
 const notice=await s.appendAgentComment({goalId:'1',type:'letter',title:'Result',text:'Ready'});
 await s.closeLetter('1',notice.id);
 const changed=await s.readConversationPage('1',{limit:1});assert.equal(changed.events[0].id,notice.id);assert.ok(changed.events[0].changeId>notice.id);
 await assert.rejects(s.readConversationPage('1',{limit:101}),/limit/);
 await assert.rejects(s.readConversationPage('1',{before:0}),/before/);
 await assert.rejects(s.readConversationPage('99'),/Goal not found/);
 `;
 const result=await execute(process.execPath,['--input-type=module','-e',code],{env:{...process.env,CHILL_AGENT_DATA_DIR:root,CHILL_AGENT_STORAGE:backend}});
 assert.equal(result.stdout,'');
});
