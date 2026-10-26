import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {approvesTools,conversationGoals,turnPlan,autonomyLines} from '../lib/autonomy.mjs';
import {autonomyLevels,autonomyOf} from '../public/autonomy.js';
const execute=promisify(execFile),cli=fileURLToPath(new URL('../bin/chill-agent.mjs',import.meta.url));

const goal=(id,patch={})=>({id,title:`Goal ${id}`,parentId:null,state:'idle',...patch});
// Root 1 (this conversation) with 2 and 3 under it; Root 4 belongs to another conversation.
const tree=levels=>[goal('1',{autonomy:levels[1]}),goal('2',{parentId:'1',autonomy:levels[2]}),goal('3',{parentId:'1',autonomy:levels[3]}),goal('4',{autonomy:3})];
const owns=g=>['1'].includes(g.id);

test('the three levels and their hover texts',()=>{
  assert.deepEqual(autonomyLevels.map(l=>l.name),['Normal','Continue','Drive']);
  assert.deepEqual(autonomyLevels.map(l=>l.tip),[
    'Work as usual. chill adds nothing.',
    'After each turn, keep working on what we agreed for this Goal. Tool requests are approved.',
    'Drive the whole project under this Root. Move forward everything that doesn\'t need my decision; ask the rest as Letters.',
  ]);
  assert.equal(autonomyOf({}),1,'a Goal saved before Autonomy reads as Normal');assert.equal(autonomyOf({autonomy:4}),1,'4 is not a level');
});

test('the conversation\'s Goals: recorded ones in its Roots, unfinished; else each Root\'s focus',()=>{
  const goals=tree({1:1,2:2,3:2});
  assert.deepEqual(conversationGoals({goals,owns,recent:['2',null,'2','4']}).map(g=>g.id),['2'],'another conversation\'s Root is not this one\'s');
  const events=[{author:'user',goalId:'3'},{author:'agent',goalId:'2'}];
  assert.deepEqual(conversationGoals({goals,events,owns,recent:[]}).map(g=>g.id),['3'],'the Goal with the latest user comment');
  assert.deepEqual(conversationGoals({goals,events:[],owns,recent:[]}).map(g=>g.id),['1'],'or the Root');
  goals[1].state='done';
  assert.deepEqual(conversationGoals({goals,events,owns,recent:['2']}).map(g=>g.id),['3'],'a Done Goal does not count');
});

test('approvals: any Goal at 3, or all at 2 or higher; no Goals, no decision',()=>{
  const at=(...levels)=>levels.map((autonomy,i)=>goal(String(i+1),{autonomy}));
  assert.equal(approvesTools([]),false);
  assert.equal(approvesTools(at(1)),false);
  assert.equal(approvesTools(at(2)),true);assert.equal(approvesTools(at(2,3)),true);
  assert.equal(approvesTools(at(2,1)),false,'the lowest decides');assert.equal(approvesTools(at(1,3)),true,'Drive overrides');
});

test('the end-of-turn plan takes the highest level and lists each Goal with its action',()=>{
  assert.equal(turnPlan({goals:tree({1:1,2:1,3:1}),owns,recent:['1','2']}),null,'nothing at 2 or higher');
  const plan=turnPlan({goals:tree({1:1,2:3,3:2}),owns,recent:['3','2','1']});
  assert.equal(plan.level,3);assert.equal(plan.goalId,'2');assert.equal(plan.rootId,'1');
  assert.deepEqual(plan.goals.map(g=>[g.id,g.level]),[['3',2],['2',3]],'Goals at 1 are not listed');
  assert.deepEqual(plan.trees.map(t=>t.rootId),['1']);
  const lines=autonomyLines(plan);
  assert.match(lines,/Goal #3 “Goal 3”, Lv 2 Continue: After each turn, keep working on what was agreed for this Goal/);
  assert.match(lines,/Goal #2 “Goal 2”, Lv 3 Drive: Drive the whole project under Root #1/);
  const drive=turnPlan({goals:tree({1:3,2:1,3:1}),owns,recent:['1'],held:new Set(['3'])});
  assert.deepEqual(drive.trees,[{rootId:'1',title:'Goal 1',open:[{id:'1',title:'Goal 1'},{id:'2',title:'Goal 2'}],taken:[{id:'3',title:'Goal 3'}]}]);
  assert.match(autonomyLines(drive),/Taken by other live conversations, so leave them: #3 “Goal 3”/);
  assert.deepEqual(turnPlan({goals:tree({1:2,2:1,3:1}),owns,recent:['1']}).trees,[],'Continue keeps to its Goal');
});

// A disposable workspace driven through the CLI, with its stored records and
// continuation journals read and written directly, as an older runtime left them.
async function workspace(t,storage) {
  const root=await mkdtemp(join(tmpdir(),'chill-autonomy-migration-'));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  const env={...process.env,CHILL_AGENT_DATA_DIR:root,CHILL_AGENT_STORAGE:storage,CHILL_AGENT_CODEX_PATH:'/missing/codex'};
  const run=async(...args)=>JSON.parse((await execute(process.execPath,[cli,...args],{env})).stdout);
  const sqlite=async edit=>{const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(join(root,'workspace','workspace.sqlite'));try{return edit(db);}finally{db.close();}};
  const goalFile=id=>join(root,'workspace','goals',id,'goal.json');
  const stored=async()=>storage==='json'
    ?Object.fromEntries(await Promise.all(['1','2','3','4','5','6'].map(async id=>[id,JSON.parse(await readFile(goalFile(id),'utf8').catch(()=>'{}')).autonomy])))
    :sqlite(db=>Object.fromEntries(db.prepare('SELECT id,body FROM goals').all().map(row=>[String(row.id),JSON.parse(row.body).autonomy])));
  // Write each Goal's stored level as given (undefined: no level of its own).
  const seed=async levels=>{
    const set=body=>{const {autonomy,...old}=body;return levels[body.id]===undefined?old:{...old,autonomy:levels[body.id]};};
    if(storage==='json')for(const id of Object.keys(levels))await writeFile(goalFile(id),JSON.stringify(set(JSON.parse(await readFile(goalFile(id),'utf8')))));
    else await sqlite(db=>{for(const row of db.prepare('SELECT id,body FROM goals').all())if(Object.hasOwn(levels,String(row.id)))db.prepare('UPDATE goals SET body=? WHERE id=?').run(JSON.stringify(set(JSON.parse(row.body))),row.id);});
  };
  const scale=join(root,'workspace','autonomy-scale.json');
  // A workspace the renumbering has not reached yet.
  const unrenumbered=()=>rm(scale,{force:true});
  const journal=id=>join(root,'workspace','continuation',`${id}.json`);
  const writeJournal=async(id,value)=>{await mkdir(join(root,'workspace','continuation'),{recursive:true});await writeFile(journal(id),JSON.stringify(value));};
  return {run,stored,seed,scale,unrenumbered,journal,writeJournal};
}

for(const storage of ['json','sqlite']){
  test(`a workspace from before Autonomy: AutoContinue On becomes Continue, 2, once, and leaves no switch behind (${storage})`,async t=>{
    const w=await workspace(t,storage);
    await w.run('create','--title','On');await w.run('create','--title','Child','--parent','1');await w.run('create','--title','Off');await w.run('create','--title','None');
    // Goals saved before Autonomy existed have no level of their own.
    await w.seed({1:undefined,2:undefined,3:undefined,4:undefined});await w.unrenumbered();
    await w.writeJournal('1',{rootId:'1',enabled:true,paused:false,revision:'r',attempts:[{id:'a'}]});
    await w.writeJournal('3',{rootId:'3',enabled:false,attempts:[]});
    await w.run('tree','--id','1');
    const goals=await w.stored();
    assert.deepEqual([goals[1],goals[2],goals[3],goals[4]],[2,2,undefined,undefined],'the AutoContinue move runs first, then the renumbering; Off and no journal read as 1');
    assert.deepEqual(JSON.parse(await readFile(w.journal('1'),'utf8')),{rootId:'1',revision:'r',attempts:[{id:'a'}]},'the attempts and revision stay; the switch is gone');
    assert.equal('enabled' in JSON.parse(await readFile(w.journal('3'),'utf8')),false);
    assert.deepEqual(JSON.parse(await readFile(w.scale,'utf8')),{levels:3});
    // A switch written again by an older runtime is removed again; its Goals without a level move to Continue on the new scale.
    await w.writeJournal('3',{rootId:'3',enabled:true,attempts:[]});
    await w.run('create','--title','Fresh','--parent','1');
    assert.equal((await w.stored())[3],2);assert.equal('enabled' in JSON.parse(await readFile(w.journal('3'),'utf8')),false);
    assert.equal((await w.stored())[5],2,'a new Goal copies its parent');
    assert.deepEqual([(await w.stored())[1],(await w.stored())[2]],[2,2],'the renumbering ran once');
  });

  test(`four stored levels move to three once: 2 to 1, 3 to 2, 4 to 3 (${storage})`,async t=>{
    const w=await workspace(t,storage);
    for(const title of ['Normal','Thorough','Continue','Drive','None'])await w.run('create','--title',title);
    await w.seed({1:1,2:2,3:3,4:4,5:undefined});await w.unrenumbered();
    // A journal the AutoContinue move has not reached yet: it runs first, writing 3 on the old scale.
    await w.run('create','--title','Under On','--parent','5');await w.seed({6:undefined});
    await w.writeJournal('5',{rootId:'5',enabled:true,attempts:[]});
    await w.run('tree','--id','1');
    assert.deepEqual(await w.stored(),{1:1,2:1,3:2,4:3,5:2,6:2});
    assert.deepEqual(JSON.parse(await readFile(w.scale,'utf8')),{levels:3});
    await w.run('tree','--id','1');
    assert.deepEqual(await w.stored(),{1:1,2:1,3:2,4:3,5:2,6:2},'never twice');
  });

  test(`a renumbering cut short repeats the recorded writes instead of moving a Goal twice (${storage})`,async t=>{
    const w=await workspace(t,storage);
    for(const title of ['A','B','C'])await w.run('create','--title',title);
    // Recorded with the old levels 4, 3 and 2; only Goal 1 was written before the run stopped.
    await w.seed({1:3,2:3,3:2});await writeFile(w.scale,JSON.stringify({from:{1:4,2:3,3:2}}));
    await w.run('tree','--id','1');
    assert.deepEqual([(await w.stored())[1],(await w.stored())[2],(await w.stored())[3]],[3,2,1]);
    assert.deepEqual(JSON.parse(await readFile(w.scale,'utf8')),{levels:3});
  });

  test(`a fresh workspace starts on the three-level scale (${storage})`,async t=>{
    const w=await workspace(t,storage);
    await w.run('create','--title','Root');
    assert.deepEqual(JSON.parse(await readFile(w.scale,'utf8')),{levels:3},'marked done before any Goal exists');
    await w.seed({1:3});await w.run('create','--title','Child','--parent','1');
    assert.deepEqual([(await w.stored())[1],(await w.stored())[2]],[3,3],'levels written on the new scale stay');
  });
}
