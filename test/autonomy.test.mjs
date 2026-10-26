import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {approvesTools,conversationGoals,feedbackAutonomy,turnPlan,autonomyLines} from '../lib/autonomy.mjs';
import {autonomyLevels,autonomyOf} from '../public/autonomy.js';
const execute=promisify(execFile),cli=fileURLToPath(new URL('../bin/chill-agent.mjs',import.meta.url));

const goal=(id,patch={})=>({id,title:`Goal ${id}`,parentId:null,state:'idle',...patch});
// Root 1 (this conversation) with 2 and 3 under it; Root 4 belongs to another conversation.
const tree=levels=>[goal('1',{autonomy:levels[1]}),goal('2',{parentId:'1',autonomy:levels[2]}),goal('3',{parentId:'1',autonomy:levels[3]}),goal('4',{autonomy:4})];
const owns=g=>['1'].includes(g.id);

test('the four levels and their hover texts',()=>{
  assert.deepEqual(autonomyLevels.map(l=>l.name),['Normal','Thorough','Continue','Drive']);
  assert.equal(autonomyLevels[0].tip,'Work as usual. chill adds nothing.');
  assert.equal(autonomyOf({}),1,'a Goal saved before Autonomy reads as Normal');assert.equal(autonomyOf({autonomy:9}),1);
});

test('the conversation\'s Goals: recorded ones in its Roots, unfinished; else each Root\'s focus',()=>{
  const goals=tree({1:1,2:3,3:2});
  assert.deepEqual(conversationGoals({goals,owns,recent:['2',null,'2','4']}).map(g=>g.id),['2'],'another conversation\'s Root is not this one\'s');
  const events=[{author:'user',goalId:'3'},{author:'agent',goalId:'2'}];
  assert.deepEqual(conversationGoals({goals,events,owns,recent:[]}).map(g=>g.id),['3'],'the Goal with the latest user comment');
  assert.deepEqual(conversationGoals({goals,events:[],owns,recent:[]}).map(g=>g.id),['1'],'or the Root');
  goals[1].state='done';
  assert.deepEqual(conversationGoals({goals,events,owns,recent:['2']}).map(g=>g.id),['3'],'a Done Goal does not count');
});

test('approvals: any Goal at 4, or all at 3 or higher; no Goals, no decision',()=>{
  const at=(...levels)=>levels.map((autonomy,i)=>goal(String(i+1),{autonomy}));
  assert.equal(approvesTools([]),false);
  assert.equal(approvesTools(at(1)),false);assert.equal(approvesTools(at(2)),false);
  assert.equal(approvesTools(at(3)),true);assert.equal(approvesTools(at(3,4)),true);
  assert.equal(approvesTools(at(3,2)),false,'the lowest decides');assert.equal(approvesTools(at(1,4)),true,'Drive overrides');
});

test('feedback names each Goal at 2 or higher once',()=>{
  assert.equal(feedbackAutonomy([goal('1',{autonomy:1})]),'');
  assert.equal(feedbackAutonomy([goal('1',{autonomy:2}),goal('2'),goal('3',{autonomy:4})]),"Autonomy Lv 2 Thorough on Goal #1, Lv 4 Drive on Goal #3: Think in the user's place. Prefer accuracy to speed: investigate deeply and widely, then give your best answer. Ask only what only the user can decide.");
});

test('the end-of-turn plan takes the highest level and lists each Goal with its meaning',()=>{
  assert.equal(turnPlan({goals:tree({1:1,2:1,3:1}),owns,recent:['1','2']}),null,'nothing at 2 or higher');
  const plan=turnPlan({goals:tree({1:1,2:3,3:2}),owns,recent:['3','2','1']});
  assert.equal(plan.level,3);assert.equal(plan.goalId,'2');assert.equal(plan.rootId,'1');
  assert.deepEqual(plan.goals.map(g=>[g.id,g.level]),[['3',2],['2',3]],'Goals at 1 are not listed');
  assert.deepEqual(plan.trees,[]);
  const lines=autonomyLines(plan);
  assert.match(lines,/Goal #3 “Goal 3”, Lv 2 Thorough: Is there anything in this reply/);assert.match(lines,/Goal #2 “Goal 2”, Lv 3 Continue: After each turn/);
  const drive=turnPlan({goals:tree({1:4,2:1,3:1}),owns,recent:['1'],held:new Set(['3'])});
  assert.deepEqual(drive.trees,[{rootId:'1',title:'Goal 1',open:[{id:'1',title:'Goal 1'},{id:'2',title:'Goal 2'}],taken:[{id:'3',title:'Goal 3'}]}]);
  assert.match(autonomyLines(drive),/Taken by other live conversations, so leave them: #3 “Goal 3”/);
});

for(const storage of ['json','sqlite']){
  test(`AutoContinue On moves its Root's Goals to 3 once and leaves no switch behind (${storage})`,async t=>{
    const root=await mkdtemp(join(tmpdir(),'chill-autonomy-migration-'));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
    const env={...process.env,CHILL_AGENT_DATA_DIR:root,CHILL_AGENT_STORAGE:storage,CHILL_AGENT_CODEX_PATH:'/missing/codex'};
    const run=async(...args)=>JSON.parse((await execute(process.execPath,[cli,...args],{env})).stdout);
    const stored=async()=>{
      if(storage==='json')return Object.fromEntries(await Promise.all(['1','2','3','4','5'].map(async id=>[id,JSON.parse(await readFile(join(root,'workspace','goals',id,'goal.json'),'utf8').catch(()=>'{}')).autonomy])));
      const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(join(root,'workspace','workspace.sqlite'));
      try{return Object.fromEntries(db.prepare('SELECT id,body FROM goals').all().map(row=>[String(row.id),JSON.parse(row.body).autonomy]));}finally{db.close();}
    };
    await run('create','--title','On');await run('create','--title','Child','--parent','1');await run('create','--title','Off');await run('create','--title','None');
    // A Goal saved before Autonomy existed has no value of its own.
    if(storage==='json')for(const id of ['1','2','3','4']){const path=join(root,'workspace','goals',id,'goal.json');const {autonomy,...old}=JSON.parse(await readFile(path,'utf8'));await writeFile(path,JSON.stringify(old));}
    else {
      const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(join(root,'workspace','workspace.sqlite'));
      for(const row of db.prepare('SELECT id,body FROM goals').all()){const {autonomy,...old}=JSON.parse(row.body);db.prepare('UPDATE goals SET body=? WHERE id=?').run(JSON.stringify(old),row.id);}
      db.close();
    }
    const journal=id=>join(root,'workspace','continuation',`${id}.json`);
    await mkdir(join(root,'workspace','continuation'),{recursive:true});
    await writeFile(journal('1'),JSON.stringify({rootId:'1',enabled:true,paused:false,revision:'r',attempts:[{id:'a'}]}));
    await writeFile(journal('3'),JSON.stringify({rootId:'3',enabled:false,attempts:[]}));
    await run('tree','--id','1');
    const goals=await stored();
    assert.deepEqual([goals[1],goals[2],goals[3],goals[4]],[3,3,undefined,undefined],'Off and no journal read as 1');
    const after=JSON.parse(await readFile(journal('1'),'utf8'));
    assert.deepEqual(after,{rootId:'1',revision:'r',attempts:[{id:'a'}]},'the attempts and revision stay; the switch is gone');
    assert.equal('enabled' in JSON.parse(await readFile(journal('3'),'utf8')),false);
    // Only Goals without a level of their own are moved; a switch written again by an older runtime is removed again.
    await writeFile(journal('3'),JSON.stringify({rootId:'3',enabled:true,attempts:[]}));
    await run('create','--title','Fresh','--parent','1');
    assert.equal((await stored())[3],3);assert.equal('enabled' in JSON.parse(await readFile(journal('3'),'utf8')),false);
    assert.equal((await stored())[5],3,'a new Goal copies its parent');
  });
}
