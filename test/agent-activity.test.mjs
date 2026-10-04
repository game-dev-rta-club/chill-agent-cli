import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {activityOwner,activityOwnerFromInput,overlayPausedGoals,invalidateActivity} from '../lib/agent-activity.mjs';
import {goalState} from '../public/goal-state.js';
import {createGoalView} from '../public/goal-view.js';
const thread='00000000-0000-0000-0000-000000000001';
test('a started turn is controllable from its input before receipt; queued siblings and output mentions are excluded',()=>{
 const deliveries=[{eventId:1,messageId:'started',status:'queued'},{eventId:2,messageId:'waiting',status:'queued'}];
 assert.equal(activityOwnerFromInput(deliveries,[{type:'userMessage',content:[{type:'text',text:'[chill-agent:started]'}]},{type:'agentMessage',content:[{type:'text',text:'[chill-agent:waiting]'}]}]),1);
 assert.equal(activityOwnerFromInput(deliveries,[{type:'userMessage',content:[{type:'text',text:'unrelated input'}]}]),null);
});
test('one activity owns merged feedback; continuation retains its original anchor',()=>{
 const record={resumedTurnId:'new',activity:{eventId:2}};
 assert.equal(activityOwner([{eventId:1,work:{turnId:'old'}},{eventId:2,hookTurnId:'old'},{eventId:3,turnId:'different'}],'old',null,null),2);
 assert.equal(activityOwner([],'new',record,{status:'working'}),2);
 assert.equal(activityOwner([],'new',record,null),2,'completed continuation still has an owner');
 assert.equal(activityOwner([],'other',record,null),null);
 assert.equal(activityOwner([{eventId:4,turnId:'new'}],'new',record,{status:'working'}),4);
});
test('Paused overlays only the stopped Goal and disappears on a new Desktop turn without changing Goal state',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'chill-activity-'));
 const old={data:process.env.CHILL_AGENT_DATA_DIR,codex:process.env.CHILL_AGENT_CODEX_PATH};
 process.env.CHILL_AGENT_DATA_DIR=dir;process.env.CHILL_AGENT_CODEX_PATH=new URL('./fake-codex.mjs',import.meta.url).pathname;
 try{
  await mkdir(join(dir,'workspace/agent-controls'),{recursive:true});
  const record={action:'stop',turnId:'turn',target:{goalId:'2'},activity:{goalId:'1',eventId:9}};
  await writeFile(join(dir,'workspace/agent-controls',thread+'.json'),JSON.stringify(record));
  const goals=[{id:'1',parentId:null,threadId:thread},{id:'2',parentId:'1',state:'idle'},{id:'3',parentId:'1',state:'waiting'}];
  const check=async turn=>{await writeFile(join(dir,'fake-history.json'),JSON.stringify({turns:[turn]}));invalidateActivity(thread);return overlayPausedGoals(goals,new Map());};
  assert.equal((await check({id:'turn',status:'interrupted',completedAt:null})).size,0);
  const map=await check({id:'turn',status:'interrupted',completedAt:1});assert.equal(map.size,1);assert.equal(map.get('2').status,'paused');assert.deepEqual(map.get('2').activity,record.activity);
  assert.equal(goals[1].state,'idle');assert.equal(goals[2].state,'waiting');
  assert.equal((await check({id:'next',completedAt:null})).size,0);
  await writeFile(join(dir,'workspace/agent-controls',thread+'.json'),JSON.stringify({...record,action:'resume',resumedTurnId:'next'}));
  assert.equal((await check({id:'next',completedAt:null})).get('2').status,'working');
  await mkdir(join(dir,'workspace/executions'),{recursive:true});
  await writeFile(join(dir,'workspace/executions',thread+'.json'),JSON.stringify({goalId:'3',turnId:'next'}));
  const moved=await check({id:'next',completedAt:null});assert.equal(moved.has('2'),false);assert.equal(moved.get('3').status,'working','a new work selection follows the current execution');
  assert.equal((await check({id:'next',completedAt:2,status:'completed'})).size,0);
 }finally{invalidateActivity(thread);for(const [key,value] of [['CHILL_AGENT_DATA_DIR',old.data],['CHILL_AGENT_CODEX_PATH',old.codex]])value===undefined?delete process.env[key]:process.env[key]=value;await rm(dir,{recursive:true,force:true});}
});
test('Paused is an execution badge with a route to the controls, not Goal completion or sibling waiting',()=>{
 const g={id:'1',state:'done',execution:{status:'paused',activity:{goalId:'2',eventId:9}},children:[],briefs:[],conversation:[],title:'Paused goal'};
 assert.equal(goalState(g),'paused');
 const html=createGoalView({'1':g},'1',new Set()).brief('1');assert.match(html,/href="#\/goal\/2\/activity\/9" class="status paused"/);assert.match(html,/>Paused</);
 assert.equal(goalState({state:'idle'},['paused']),'idle');assert.equal(goalState({state:'waiting'},['paused']),'waiting');
});
