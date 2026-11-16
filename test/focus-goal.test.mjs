import test from 'node:test';
import assert from 'node:assert/strict';
import {focusGoal,workingElsewhere} from '../lib/hand-off.mjs';

// One conversation owning Roots 1 and 5, working on Goal 2 (under 1) and Goal 7 (under 6, under 5).
const goals=[{id:'1'},{id:'2',parentId:'1'},{id:'5'},{id:'6',parentId:'5'},{id:'7',parentId:'6'}];
const view=running=>({goals,running,roots:[{root:{id:'1'},goals:goals.slice(0,2)},{root:{id:'5'},goals:goals.slice(2)}]});

test('the Goal shown as worked on now comes from the viewed Root when the work is in it',()=>{
 assert.equal(focusGoal(view(['2','6','7']),'5'),'7','the deepest running Goal in the viewed Root');
 assert.equal(focusGoal(view(['2','6','7']),'1'),'2');
 assert.equal(focusGoal(view(['6','7']),'1'),'7','work only in another Root is still shown');
 assert.equal(focusGoal(view([])),null);
});
test('work only in the agent\'s other Roots is elsewhere for this one',()=>{
 assert.equal(workingElsewhere(view(['6','7']),'1'),true);
 assert.equal(workingElsewhere(view(['2','7']),'1'),false);
 assert.equal(workingElsewhere(view([]),'1'),false,'no running Goal says nothing about where');
});
