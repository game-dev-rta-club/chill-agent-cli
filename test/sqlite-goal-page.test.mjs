import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const execute=promisify(execFile),moduleURL=name=>new URL('../lib/'+name+'.mjs',import.meta.url).href;
test('SQLite CLI pages match complete-history output while selecting only requested bodies',async t=>{
 const root=await mkdtemp(join(tmpdir(),'chill-cli-page-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const code=`
 import assert from 'node:assert/strict';import {writeFile} from 'node:fs/promises';
 import * as s from ${JSON.stringify(moduleURL('goal-store'))};
 import {readConnectedGoals,readGoalPage,goalPage} from ${JSON.stringify(moduleURL('workspace-reader'))};
 import {sqliteGoalPageRecords} from ${JSON.stringify(moduleURL('sqlite-goal-page'))};
 await s.createGoal({title:'Root'});await s.createGoal({title:'Child',parentId:'1'});await s.createGoal({title:'Other'});
 for(const id of ['1','2','3'])for(let i=0;i<4;i++){
  await writeFile(s.briefPath(id),'# Version '+i+' for '+id);
  await s.updateBrief(id);
 }
 const answered=await s.appendAgentComment({goalId:'2',type:'letter',title:'Old question',text:'Choose'});
 const open=await s.appendAgentComment({goalId:'2',type:'letter',title:'Still open',text:'Pending'});
 for(let i=0;i<40;i++)await s.appendAgentComment({goalId:'2',type:'comment',text:'History '+i});
 await s.appendAgentComment({goalId:'3',type:'comment',text:'Other root body'});
 const answer=await s.appendFeedback({goalId:'2',text:'Answer',annotations:[{kind:'letter',source:{kind:'comment',eventId:answered.id},text:'Yes'}]});
 const received=await s.appendAgentComment({goalId:'1',type:'letter',title:'Received',text:'Already seen'});await s.closeLetter('1',received.id);
 const all=await readConnectedGoals();
 for(const id of ['1','2','3'])for(const options of [{},{limit:5},{limit:5,before:30},{version:1,limit:3},{since:15},{since:20,before:30,limit:2},{since:10000}]){
  const expected=goalPage(all,id,options),actual=await readGoalPage(id,options);
  const {attachments,...page}=actual;assert.deepEqual(attachments,[]);assert.deepEqual(page,expected);
 }
 const projection=await sqliteGoalPageRecords('2',{limit:3,version:1});
 assert.equal(projection.selection.events.length,3);
 assert.equal(projection.selection.answerTargets[0].id,answered.id);
 assert.equal(projection.goals.flatMap(g=>g.conversation).length,1);
 assert.equal(projection.goals.flatMap(g=>g.conversation)[0].id,open.id);
 assert.equal(projection.goals.flatMap(g=>g.briefs).filter(b=>b.body!==undefined).length,1);
 assert.equal(projection.selection.total,43);
 for(const options of [{version:99},{limit:0},{before:1,since:1}])await assert.rejects(readGoalPage('2',options));
 await assert.rejects(readGoalPage('99'),/Goal not found/);
 await s.createGoal({title:'Empty'});assert.equal((await readGoalPage('4')).brief,null);
 `;
 await execute(process.execPath,['--input-type=module','-e',code],{env:{...process.env,CHILL_AGENT_DATA_DIR:root,CHILL_AGENT_STORAGE:'sqlite',CHILL_AGENT_CODEX_PATH:'/missing/codex'},maxBuffer:1024*1024});
 assert.ok(true);
});
