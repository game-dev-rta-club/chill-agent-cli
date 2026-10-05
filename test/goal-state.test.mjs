import assert from 'node:assert/strict';
import test from 'node:test';
import {workspaceTree} from '../lib/goal-store.mjs';
import {createGoalView} from '../public/goal-view.js';

test('Web and CLI prioritize activity but never infer parent completion from children',()=>{
  const make=(id,parentId)=>({id,parentId,title:`Goal ${id}`,state:'idle',briefs:[],conversation:[]});
  const root=make('1',null),a=make('2','1'),b=make('3','1'),goals=[root,a,b];
  const check=expected=>{
    assert.equal(workspaceTree(goals,'1')[0].state,expected);
    const web=Object.fromEntries(goals.map(g=>[g.id,{...g,children:goals.filter(c=>c.parentId===g.id).map(c=>c.id)}]));
    const html=createGoalView(web,'1',new Set()).brief('1');
    const header=html.split('</header>')[0];
    assert.equal(header.match(/class="status (\w+)/)?.[1],expected==='idle'?undefined:expected);
    assert.doesNotMatch(header,/compact-status|sr-only|>Open<|>Idle</);
    if(expected==='working')assert.match(header,/>Running</);
    if(expected==='waiting')assert.match(header,/>Waiting</);
    if(expected==='done')assert.match(html,/status done[\s\S]*<svg/);
  };
  check('idle');
  a.state='waiting';a.waitReason='Need input';check('idle');
  b.state='waiting';b.waitReason='Need access';check('waiting');
  b.state='idle';b.execution={status:'working',expiresAt:new Date(Date.now()+60000).toISOString()};check('working');
  root.state='waiting';root.waitReason='Final input';check('working');
  b.execution.expiresAt='2000-01-01T00:00:00Z';check('waiting');
  root.state='idle';check('idle');
  a.state='idle';root.briefs=[{goalId:'1',version:1}];check('idle');
  a.state='done';check('idle');
  b.state='waiting';check('waiting');
  b.state='done';check('idle');
  assert.equal(workspaceTree(goals,'1')[0].progress,99);
  root.state='done';check('done');
  assert.equal(workspaceTree(goals,'1')[0].progress,100);
  a.conversation=[{id:1,goalId:'2',author:'agent',type:'letter',title:'Question'}];check('done');
  root.execution={status:'working',expiresAt:new Date(Date.now()+60000).toISOString()};check('working');
  for(const status of ['queued','checking']){root.execution.status=status;check('working');assert.equal(workspaceTree(goals,'1')[0].progress,100);}
  root.execution.expiresAt='2000-01-01T00:00:00Z';check('done');
});
