import assert from 'node:assert/strict';
import test from 'node:test';
import {createGoalView} from '../public/goal-view.js';

const goal=(id,parentId,children,letters=[])=>({id,parentId,children,title:`Goal ${id}`,state:'idle',briefs:[],conversation:letters});
const letter=(goalId,version)=>({goalId,id:Number(goalId)*100+version,author:'agent',type:'letter',title:`Letter ${goalId}/${version}`});
const goals=()=>({
  '1':goal('1',null,['2'],[letter('1',1)]),
  '2':goal('2','1',['3']),
  '3':goal('3','2',[],[letter('3',1)]),
  '4':goal('4',null,[]),
});

test('the brand returns to the current root, then to the index; Goals is a plain breadcrumb label',()=>{
  const data=goals();
  for(const id of [null,'1','4','missing'])assert.equal(createGoalView(data,id,new Set()).brandTarget().href,'#/goals');
  for(const id of ['2','3']){
    const view=createGoalView(data,id,new Set());
    assert.deepEqual(view.brandTarget(),{href:'#/goal/1',label:'chill — Root Goal: Goal 1'});
    assert.match(view.brief(id),/<strong class="breadcrumb-label">Goals<\/strong>/);
    assert.doesNotMatch(view.brief(id),/<a[^>]+href="#\/goals"/);
  }
});

test('Split Goal titles navigate separately from background/disclosure toggles, including leaves',()=>{
  const data=goals(),html=createGoalView(data,'1',new Set(['2','3'])).brief('1');
  assert.match(html,/<div class="tree-row" data-row-toggle="2">/);
  assert.match(html,/<button[^>]+aria-expanded="true"[^>]+data-toggle="2"/);
  assert.match(html,/<a class="tree-name" href="#\/goal\/2"[^>]*>Goal 2<\/a>/);
  assert.match(html,/<a class="tree-name" href="#\/goal\/3"[^>]*>Goal 3<\/a>/);
  assert.doesNotMatch(html,/class="goal-open"/);
  data['3'].conversation=[];
  const leaf=createGoalView(data,'2',new Set()).brief('2');
  assert.match(leaf,/tree-leaf-dot/);assert.doesNotMatch(leaf,/data-row-toggle="3"|data-toggle="3"/);
  assert.match(leaf,/<a class="tree-name" href="#\/goal\/3"/);
});

test('index Letter counts include descendants and new Letters, exclude answers, and display zero',()=>{
  const data=goals();
  const index=()=>createGoalView(data,null,new Set()).index();
  assert.match(index(),/aria-label="2 unanswered Letters under Goal 1"/);
  assert.match(index(),/class="letters-count is-empty" aria-label="0 unanswered Letters under Goal 4"/);
  data['3'].conversation.push({id:500,goalId:'3',author:'user',annotations:[{kind:'letter',source:{kind:'comment',eventId:301},text:'A'}]});
  assert.match(index(),/aria-label="1 unanswered Letters under Goal 1"/);
  data['3'].conversation.push(letter('3',2));
  assert.match(index(),/aria-label="2 unanswered Letters under Goal 1"/);
});
