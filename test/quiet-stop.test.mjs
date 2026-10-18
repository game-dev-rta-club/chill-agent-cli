import test from 'node:test';
import assert from 'node:assert/strict';
import {quietFeedback} from '../lib/quiet-stop.mjs';

// Feedback #5 on Goal 1 was taken; the agent last stopped at change 7.
const taken=[{eventId:5,goalId:'1'}];
const stop=patch=>quietFeedback({taken,agentEvents:[],since:7,running:0,held:false,...patch});

test('a stop is held only for taken feedback the user heard nothing about, with nothing left running',()=>{
  const cases=[
    ['nothing said since the last stop, nothing running',{},[5]],
    ['background work keeps running',{running:1},[]],
    ['a progress comment since the last stop',{agentEvents:[{id:8,goalId:'1'}]},[]],
    ['a comment before the last stop',{agentEvents:[{id:6,goalId:'1'}]},[5]],
    ['a comment on another Goal',{agentEvents:[{id:8,goalId:'2'}]},[5]],
    ['a comment older than the feedback, before any stop',{since:0,agentEvents:[{id:3,goalId:'1'}]},[5]],
    ['a comment after the feedback, before any stop',{since:0,agentEvents:[{id:6,goalId:'1'}]},[]],
    ['the reply completed it, so it is no longer taken',{taken:[]},[]],
    ['the stop right after a hold',{held:true},[]],
    ['a later stop, with still nothing said',{held:false},[5]],
  ];
  for(const [name,patch,held] of cases)assert.deepEqual(stop(patch).map(f=>f.eventId),held,name);
});

test('a comment on one Goal answers only that Goal\'s feedback',()=>{
  const quiet=quietFeedback({taken:[{eventId:5,goalId:'1'},{eventId:6,goalId:'2'}],agentEvents:[{id:9,goalId:'2'}],since:7,running:0,held:false});
  assert.deepEqual(quiet,[{eventId:5,goalId:'1'}]);
});
