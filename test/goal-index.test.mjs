import test from 'node:test';
import assert from 'node:assert/strict';
import {createGoalView} from '../public/goal-view.js';

test('the Goals index lists Root Goals newest first',()=>{
 const goal=(id,parentId=null)=>({id,parentId,title:`Goal ${id}`,children:[],briefs:[],conversation:[],state:'idle',progress:0});
 const goals={1:goal('1'),2:goal('2','1'),8:goal('8'),23:goal('23')};goals[1].children=['2'];
 const html=createGoalView(goals,null,new Set()).index();
 const order=[...html.matchAll(/#(\d+)/g)].map(m=>m[1]).filter((id,i,all)=>all.indexOf(id)===i);
 assert.deepEqual(order.filter(id=>['1','8','23'].includes(id)),['23','8','1']);
});
