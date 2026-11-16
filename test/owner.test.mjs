import test from 'node:test';
import assert from 'node:assert/strict';
import {ownsRoot,rootOwners} from '../lib/owner.mjs';
import {claudeOwner,codexOwner} from '../lib/agents/owners.mjs';

test('ownsRoot picks the Roots one conversation holds, whatever its agent', () => {
  const claude = claudeOwner({sessionId:'s1', contextId:'00000000-0000-4000-8000-000000000001'});
  const goals = [
    {id:'1', owner:claude},
    {id:'2', owner:{...claude, context:'00000000-0000-4000-8000-000000000002'}},
    {id:'3', parentId:'1', owner:claude},
    {id:'4', owner:codexOwner('t1')},
    {id:'5'},
  ];
  assert.deepEqual(goals.filter(ownsRoot(claude)).map(g => g.id), ['1'], 'a cleared context, a child Goal and another agent are not its Roots');
  assert.deepEqual(goals.filter(ownsRoot(codexOwner('t1'))).map(g => g.id), ['4']);
  assert.equal(ownsRoot(claude)(undefined), false);
});

test('rootOwners lists each conversation holding a Root once', () => {
  const claude = claudeOwner({sessionId:'s1', contextId:'00000000-0000-4000-8000-000000000001'});
  const goals = [{id:'1', owner:claude}, {id:'2', owner:{...claude}}, {id:'3', parentId:'1', owner:codexOwner('t2')}, {id:'4', owner:codexOwner('t1')}, {id:'5'}];
  assert.deepEqual(rootOwners(goals), [claude, codexOwner('t1')]);
});
