import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {approvesTools,turnPlan,autonomyLines} from '../lib/autonomy.mjs';
import {journalOwnership,journalAutonomy,withAutonomy} from '../lib/continuation-owner.mjs';
import {autonomyLevels,autonomyOf} from '../public/autonomy.js';
import {expectHidden} from './hidden-failures.mjs';
const execute=promisify(execFile),cli=fileURLToPath(new URL('../bin/chill-agent.mjs',import.meta.url));

const goal=(id,patch={})=>({id,title:`Goal ${id}`,parentId:null,state:'idle',...patch});
// Root 1 with 2 and 3 under it, and Root 4.
const tree=()=>[goal('1'),goal('2',{parentId:'1'}),goal('3',{parentId:'1'}),goal('4')];
const at=(goals,levels)=>Object.entries(levels).map(([id,level])=>({root:goals.find(g=>g.id===id),level}));

test('the three levels go by name, with their descriptions',()=>{
  assert.deepEqual(autonomyLevels.map(l=>[l.level,l.name]),[[1,'Normal'],[2,'Auto Continue'],[3,'Ultra Continue']]);
  assert.deepEqual(autonomyLevels.map(l=>l.description),[
    'Does what each comment asks, then waits for you.',
    'Keeps working on what you\'ve agreed, across the whole Root Goal. Questions come as Letters. No tool prompts.',
    'Plans its own way to the Root Goal\'s success criteria and moves every Goal under it forward. Letters only for your decisions. No tool prompts.',
  ]);
  assert.equal(autonomyOf({}),1,'a record without a level reads as Normal');assert.equal(autonomyOf({autonomy:4}),1,'4 is not a level');
});

test('the journal record is the Root agent\'s: the same or a continued one keeps it, another starts over, a record with no owner goes to the first',()=>{
  const claude=id=>({harnessId:'claude-code',sessionId:id,contextId:`c-${id}`});
  const root={id:'1',connection:claude('a'),previousConnections:[claude('old')]};
  const record=patch=>({rootId:'1',attempts:[{id:'x',at:'t'}],autonomy:3,...patch});
  assert.equal(journalOwnership(root,null),'none');
  assert.equal(journalOwnership(root,record({connection:claude('a')})),'same');
  assert.equal(journalOwnership(root,record({connection:claude('old')})),'adopted','a continued session');
  assert.equal(journalOwnership(root,record({})),'adopted','a record written before any agent');
  assert.equal(journalOwnership(root,record({connection:claude('b')})),'other');
  assert.equal(journalOwnership(root,record({threadId:'t'})),'other');
  assert.deepEqual([claude('a'),claude('old'),undefined,claude('b')].map(connection=>journalAutonomy(root,record(connection?{connection}:{}))),[3,3,3,1]);
  const codex={id:'1',threadId:'t'};
  assert.deepEqual([{threadId:'t'},{threadId:'u'},{},{connection:claude('a')}].map(owner=>journalOwnership(codex,record(owner))),['same','other','adopted','other']);
  const unowned={id:'1'};
  assert.deepEqual([{},{threadId:'t'}].map(owner=>journalAutonomy(unowned,record(owner))),[3,1],'a Root without an agent keeps only a record without one');
  // Setting the level.
  assert.deepEqual(withAutonomy(unowned,null,2,'now'),{rootId:'1',attempts:[],autonomy:2,updatedAt:'now'});
  assert.deepEqual(withAutonomy(codex,null,2,'now'),{rootId:'1',threadId:'t',attempts:[],autonomy:2,updatedAt:'now'});
  assert.equal(withAutonomy(root,record({connection:claude('a')}),3),null,'unchanged');
  assert.deepEqual(withAutonomy(root,record({connection:claude('old'),revision:'r'}),2,'now'),record({connection:claude('old'),revision:'r',autonomy:2,updatedAt:'now'}),'a record to take over keeps its owner until the agent writes it');
  assert.deepEqual(withAutonomy(codex,record({threadId:'u',revision:'r',history:[{id:'h'}]}),2,'now'),
    {rootId:'1',threadId:'t',history:[{id:'h'},{id:'x',at:'t',phase:'assignment-changed',completedAt:'now'}],attempts:[],autonomy:2,updatedAt:'now'},'another agent\'s record starts over');
  assert.throws(()=>withAutonomy(root,null,4),/Normal, Auto Continue or Ultra Continue/);
});

test('approvals: every owned Root at Auto Continue or higher; owning none means asking',()=>{
  assert.equal(approvesTools([]),false,'no owned Root');
  assert.equal(approvesTools([1]),false);
  assert.equal(approvesTools([2]),true);assert.equal(approvesTools([3]),true);assert.equal(approvesTools([2,3]),true);
  assert.equal(approvesTools([2,1]),false,'one Root at Normal keeps prompts asking');assert.equal(approvesTools([3,1]),false,'so does Ultra Continue beside it');
});

test('the end-of-turn plan lists each owned Root above Normal by name, with its tree at Ultra Continue',()=>{
  const goals=tree();
  assert.equal(turnPlan({goals,levels:at(goals,{1:1,4:1})}),null,'nothing above Normal');
  assert.equal(turnPlan({goals,levels:[]}),null,'no owned Root');
  const plan=turnPlan({goals,levels:at(goals,{1:2,4:3})});
  assert.equal(plan.level,3);assert.equal(plan.rootId,'4');assert.equal(plan.goalId,'4');
  assert.deepEqual(plan.roots.map(r=>[r.id,r.level]),[['1',2],['4',3]]);
  const lines=autonomyLines(plan);
  assert.match(lines,/^- Root Goal #1 “Goal 1”, Auto Continue: After each turn, keep carrying out what you and the user clearly see the same way, in any Goal under Root Goal #1: work they asked for and plans you settled together\. Do not start what they have not agreed to; suggest it in its Goal instead\. When something only the user can decide blocks you, such as a choice they would care about or a step that is irreversible or leaves this workspace, ask it in a Letter \(a reply with --ask\) and carry on with the rest\.$/m);
  assert.match(lines,/^- Root Goal #4 “Goal 4”, Ultra Continue: Root Goal #4 is delegated to you: its success criteria are fixed, and how to reach them is your call\. The user will not follow each step or review as you go, so do not wait for them\. Find what is still missing, plan it, split it into SubGoals, choose the order and carry it all out across its tree, writing each decision into its Goal so the user can catch up later\. Ask in a Letter for what is the user's alone: changing the success criteria, matters of taste the criteria leave open, and anything irreversible or beyond this workspace, such as merging to a shared branch, deleting data or publishing\. Meanwhile keep working on the rest of the tree\.$/m);
  assert.doesNotMatch(lines,/Lv|Drive|Level/,'levels go by name');
  const ultra=turnPlan({goals,levels:at(goals,{1:3}),held:new Set(['3'])});
  assert.deepEqual(ultra.roots,[{id:'1',title:'Goal 1',level:3,open:[{id:'1',title:'Goal 1'},{id:'2',title:'Goal 2'}],taken:[{id:'3',title:'Goal 3'}]}]);
  assert.match(autonomyLines(ultra),/\n  Unfinished in that tree: #1 “Goal 1”, #2 “Goal 2”\.\n  Taken by other live conversations, so leave them: #3 “Goal 3”\./);
  assert.deepEqual(turnPlan({goals,levels:at(goals,{1:2})}).roots,[{id:'1',title:'Goal 1',level:2}],'Auto Continue lists no tree');
  goals[0].state='done';assert.equal(turnPlan({goals,levels:at(goals,{1:3})}),null,'a Done Root asks for nothing');
});

// A disposable workspace driven through the CLI, with its stored records and
// continuation journals read and written directly, as an older runtime left them.
async function workspace(t,storage) {
  const root=await mkdtemp(join(tmpdir(),'chill-autonomy-migration-'));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  const env={...process.env,CHILL_AGENT_DATA_DIR:root,CHILL_AGENT_STORAGE:storage,CHILL_AGENT_CODEX_PATH:'/missing/codex'};
  const run=async(...args)=>JSON.parse((await execute(process.execPath,[cli,...args],{env})).stdout);
  const sqlite=async edit=>{const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(join(root,'workspace','workspace.sqlite'));try{return edit(db);}finally{db.close();}};
  const goalFile=id=>join(root,'workspace','goals',id,'goal.json');
  const ids=['1','2','3','4','5','6'];
  const bodies=async()=>storage==='json'
    ?Object.fromEntries((await Promise.all(ids.map(async id=>[id,JSON.parse(await readFile(goalFile(id),'utf8').catch(()=>'null'))]))).filter(([,body])=>body))
    :sqlite(db=>Object.fromEntries(db.prepare('SELECT id,body FROM goals').all().map(row=>[String(row.id),JSON.parse(row.body)])));
  // Each Goal's own stored level (none since the move to Roots).
  const stored=async()=>Object.fromEntries(Object.entries(await bodies()).map(([id,body])=>[id,body.autonomy]));
  // Edit stored Goals: fields to set, undefined removing one.
  const patch=async changes=>{
    const set=body=>{const next={...body};for(const [key,value] of Object.entries(changes[body.id]))if(value===undefined)delete next[key];else next[key]=value;return next;};
    if(storage==='json')for(const id of Object.keys(changes))await writeFile(goalFile(id),JSON.stringify(set(JSON.parse(await readFile(goalFile(id),'utf8')))));
    else await sqlite(db=>{for(const row of db.prepare('SELECT id,body FROM goals').all())if(Object.hasOwn(changes,String(row.id)))db.prepare('UPDATE goals SET body=? WHERE id=?').run(JSON.stringify(set(JSON.parse(row.body))),row.id);});
  };
  // Write each Goal's stored level as an older runtime did (undefined: no level of its own).
  const seed=levels=>patch(Object.fromEntries(Object.entries(levels).map(([id,autonomy])=>[id,{autonomy}])));
  const scale=join(root,'workspace','autonomy-scale.json');
  // A workspace the renumbering has not reached yet.
  const unrenumbered=()=>rm(scale,{force:true});
  const journal=id=>join(root,'workspace','continuation',`${id}.json`);
  const readJournal=async id=>JSON.parse(await readFile(journal(id),'utf8').catch(()=>'null'));
  const writeJournal=async(id,value)=>{await mkdir(join(root,'workspace','continuation'),{recursive:true});await writeFile(journal(id),JSON.stringify(value));};
  // Each Root's level, as its journal keeps it.
  const levels=async()=>Object.fromEntries(await Promise.all(Object.entries(await bodies()).filter(([,body])=>!body.parentId).map(async([id])=>[id,(await readJournal(id))?.autonomy])));
  const without=({updatedAt,...rest})=>rest;
  return {run,stored,patch,seed,scale,unrenumbered,journal,readJournal,writeJournal,levels,without};
}
const none=(...ids)=>Object.fromEntries(ids.map(id=>[id,undefined]));

for(const storage of ['json','sqlite']){
  test(`a workspace from before Autonomy: AutoContinue On becomes Auto Continue on its Root, once, and leaves no switch behind (${storage})`,async t=>{
    const w=await workspace(t,storage);
    await w.run('create','--title','On');await w.run('create','--title','Child','--parent','1');await w.run('create','--title','Off');await w.run('create','--title','None');
    // Goals saved before Autonomy existed have no level of their own.
    await w.seed(none('1','2','3','4'));await w.unrenumbered();
    await w.writeJournal('1',{rootId:'1',enabled:true,paused:false,revision:'r',attempts:[{id:'a'}]});
    await w.writeJournal('3',{rootId:'3',enabled:false,attempts:[]});
    await w.run('tree','--id','1');
    assert.deepEqual(await w.stored(),none('1','2','3','4'),'no Goal keeps a level');
    assert.deepEqual(await w.levels(),{1:2,3:undefined,4:undefined},'the AutoContinue move, the renumbering, then the move to the Root; Off and no journal read as Normal');
    assert.deepEqual(w.without(await w.readJournal('1')),{rootId:'1',revision:'r',attempts:[{id:'a'}],autonomy:2},'the attempts and revision stay; the switch is gone');
    assert.equal('enabled' in await w.readJournal('3'),false);
    assert.deepEqual(JSON.parse(await readFile(w.scale,'utf8')),{levels:3});
    // A switch written again by an older runtime is removed again; its Root moves to Auto Continue.
    await w.writeJournal('3',{rootId:'3',enabled:true,attempts:[]});
    await w.run('create','--title','Fresh','--parent','1');
    assert.deepEqual(await w.levels(),{1:2,3:2,4:undefined});assert.equal('enabled' in await w.readJournal('3'),false);
    assert.deepEqual(await w.stored(),none('1','2','3','4','5'),'a new Goal copies nothing');
  });

  test(`four stored levels move to three once, then to their Roots: 2 to Normal, 3 to Auto Continue, 4 to Ultra Continue (${storage})`,async t=>{
    const w=await workspace(t,storage);
    for(const title of ['Normal','Thorough','Continue','Drive','None'])await w.run('create','--title',title);
    await w.seed({1:1,2:2,3:3,4:4,5:undefined});await w.unrenumbered();
    // A journal the AutoContinue move has not reached yet: it runs first, writing 3 on the old scale.
    await w.run('create','--title','Under On','--parent','5');await w.seed({6:undefined});
    await w.writeJournal('5',{rootId:'5',enabled:true,attempts:[]});
    await w.run('tree','--id','1');
    assert.deepEqual(await w.levels(),{1:undefined,2:undefined,3:2,4:3,5:2});
    assert.deepEqual(await w.stored(),none('1','2','3','4','5','6'));
    assert.deepEqual(JSON.parse(await readFile(w.scale,'utf8')),{levels:3});
    await w.run('tree','--id','1');
    assert.deepEqual(await w.levels(),{1:undefined,2:undefined,3:2,4:3,5:2},'never twice');
  });

  test(`a renumbering cut short repeats the recorded writes instead of moving a Goal twice (${storage})`,async t=>{
    const w=await workspace(t,storage);
    for(const title of ['A','B','C'])await w.run('create','--title',title);
    // Recorded with the old levels 4, 3 and 2; only Goal 1 was written before the run stopped.
    await w.seed({1:3,2:3,3:2});await writeFile(w.scale,JSON.stringify({from:{1:4,2:3,3:2}}));
    await w.run('tree','--id','1');
    assert.deepEqual(await w.levels(),{1:3,2:2,3:undefined});
    assert.deepEqual(JSON.parse(await readFile(w.scale,'utf8')),{levels:3});
  });

  test(`each Root's level moves into its journal for the Root's current agent, and the field leaves every Goal (${storage})`,async t=>{
    // The CLI looks for the Codex chat the second Root names; there is none here.
    expectHidden(t,'codex-work.observe');
    const w=await workspace(t,storage);
    for(const title of ['Claude','Codex','Unowned'])await w.run('create','--title',title);
    await w.run('create','--title','Child','--parent','1');
    const claude={harnessId:'claude-code',sessionId:'s',contextId:'00000000-0000-4000-8000-000000000001'},threadId='00000000-0000-4000-8000-000000000002';
    await w.patch({1:{connection:claude,autonomy:2},2:{threadId,autonomy:3},3:{autonomy:2},4:{autonomy:1}});
    await w.writeJournal('1',{rootId:'1',connection:claude,revision:'r',attempts:[{id:'kept',completedAt:'t'}]});
    await w.writeJournal('2',{rootId:'2',threadId:'00000000-0000-4000-8000-000000000003',attempts:[{id:'earlier'}]});
    await w.run('tree','--id','3');
    assert.deepEqual(w.without(await w.readJournal('1')),{rootId:'1',connection:claude,revision:'r',attempts:[{id:'kept',completedAt:'t'}],autonomy:2},'the same agent keeps its record');
    const codex=await w.readJournal('2');
    assert.deepEqual([codex.threadId,codex.autonomy,codex.attempts,codex.history.map(a=>[a.id,a.phase])],[threadId,3,[],[['earlier','assignment-changed']]],'another agent\'s record starts over for the current one');
    assert.deepEqual(w.without(await w.readJournal('3')),{rootId:'3',attempts:[],autonomy:2},'a Root without an agent keeps it for the first one');
    assert.deepEqual(await w.stored(),none('1','2','3','4'));
    // A run cut short after the journals were written repeats them unchanged.
    const before=await w.readJournal('1');await w.seed({1:2,4:3});
    await w.run('tree','--id','1');
    assert.deepEqual(await w.readJournal('1'),before);assert.deepEqual(await w.stored(),none('1','2','3','4'),'a child\'s level is dropped');
  });

  test(`a fresh workspace starts on the three-level scale (${storage})`,async t=>{
    const w=await workspace(t,storage);
    await w.run('create','--title','Root');
    assert.deepEqual(JSON.parse(await readFile(w.scale,'utf8')),{levels:3},'marked done before any Goal exists');
    assert.equal(await w.readJournal('1'),null,'a new Root has no journal and reads as Normal');
    await w.seed({1:3});await w.run('create','--title','Child','--parent','1');
    assert.deepEqual(await w.levels(),{1:3},'a level an older runtime wrote on the new scale moves to the Root as it is');
    assert.deepEqual(await w.stored(),none('1','2'));
  });
}
