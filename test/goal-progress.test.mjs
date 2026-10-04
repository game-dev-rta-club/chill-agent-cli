import assert from 'node:assert/strict';
import test from 'node:test';
import {ownGoalProgress,progressPercent} from '../public/goal-progress.js';
import {createGoalView} from '../public/goal-view.js';
import {workspaceTree} from '../lib/goal-store.mjs';

const goal=(id,parentId=null,extra={})=>({id,parentId,title:`Goal ${id}`,state:'idle',started:false,briefs:[],conversation:[],...extra});
const note=(goalId,version,type='notice')=>({goalId,version,type,title:`Note ${version}`});

test('progress is completion only, independent of Notes, answers, reopens and live work',()=>{
  const g=goal('1');
  assert.equal(ownGoalProgress(g),0);
  g.started=true;g.execution={status:'working'};
  g.briefs.push(note('1',1),note('1',2,'letter'));
  g.conversation.push({id:1,goalId:'1',version:2,author:'user'});
  for(const state of ['idle','waiting'])assert.equal(ownGoalProgress({...g,state}),0);
  g.state='done';assert.equal(ownGoalProgress(g),1);
  g.briefs.push(note('1',3,'letter'));
  g.conversation.push({id:2,goalId:'1',version:2,author:'agent'});
  assert.equal(ownGoalProgress(g),1,'new requests do not silently reopen the Goal');
  assert.equal(ownGoalProgress(goal('2',null,{state:'done'})),1,'Done needs no Note');
  g.state='idle';assert.equal(ownGoalProgress(g),0,'explicitly resuming work resets completion');
});

test('CLI and Web count leaves equally in an uneven tree and render one continuous bar',()=>{
  const goals=[
    goal('1',null,{briefs:[note('1',1)]}),
    goal('2','1',{state:'done',briefs:Array.from({length:10},(_,i)=>note('2',i+1))}),
    goal('3','1'),
    goal('4','3',{state:'done'}),
    goal('5','3',{started:true,briefs:[note('5',1)]}),
  ];
  const tree=workspaceTree(goals,'1')[0];
  assert.equal(tree.progress,67,'two of three leaves; parent state and branch depth add no weight');
  assert.equal(tree.state,'idle','parent completion is recorded separately');
  assert.equal(tree.children[1].progress,50);
  const web=Object.fromEntries(goals.map(g=>[g.id,{...g,children:goals.filter(c=>c.parentId===g.id).map(c=>c.id)}]));
  const html=createGoalView(web,'1',new Set()).brief('1');
  assert.match(html,/aria-valuenow="67"/);assert.match(html,/>67%<\/span>/);
  assert.match(html,/2\/3 leaf Goals done/);
  const track=html.match(/<svg class="progress-track"[^>]*>(.*?)<\/svg>/)[1];
  assert.match(track,/<rect class="progress-fill" width="67" height="10"\/>/);
  assert.equal((track.match(/<rect/g)||[]).length,1);
  assert.doesNotMatch(html,/progress-segment|style=/,'the strict page CSP does not allow inline styles');
  assert.doesNotMatch(JSON.stringify(tree),/goalScores|leafProgress/);
});

test('Open caps at 99% including rounding; Done never overwrites the measured ratio',()=>{
  assert.equal(progressPercent([1,1],goal('1')),99);
  assert.equal(progressPercent([1,1],goal('1',null,{state:'waiting'})),99);
  assert.equal(progressPercent([...Array(300).fill(1),0],goal('1')),99);
  assert.equal(progressPercent([1,0],goal('1',null,{state:'done'})),50);
  assert.equal(progressPercent([1,1],goal('1',null,{state:'done'})),100);
});
