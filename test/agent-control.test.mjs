import test from 'node:test';
import assert from 'node:assert/strict';
import {createControlService,controlView} from '../lib/agent-control.mjs';
import {activityControlMarkup} from '../public/activity-controls.js';
import {agentMarkup} from '../public/agent-menu.js';
const thread='00000000-0000-0000-0000-000000000001',turnId='00000000-0000-0000-0000-000000000002',requestId='00000000-0000-0000-0000-000000000003',next='00000000-0000-0000-0000-000000000004';
function fixture(){let record=null,turn={id:turnId,completedAt:null,status:'interrupted'},calls=[];const service=createControlService({context:async()=>({root:{threadId:thread}}),read:async()=>record,write:async(_,r)=>{record=r},latest:async()=>turn,stop:async(_,id)=>{calls.push(['stop',id]);turn={...turn,completedAt:1};return {ok:true,interruptedTurnId:id}},resume:async(_,text,id)=>{calls.push(['resume',text,id]);turn={id:next,completedAt:null};return {result:{turn:{id:next}}}}});return {service,calls,get record(){return record},get turn(){return turn},set turn(t){turn=t}};}
const input={action:'stop',requestId,threadId:thread,turnId},target={goalId:'23',title:'Work'};
test('targeted stop is confirmed from terminal evidence; resume preserves target and never resends a request',async()=>{
 const f=fixture();await f.service('20',input,target);assert.equal(controlView(f.record,f.turn).status,'paused');
 await f.service('20',input,target);assert.equal(f.calls.length,1);
 await f.service('20',{...input,action:'resume',requestId:next},null);assert.equal(f.calls.length,2);assert.match(f.calls[1][1],/Goal #23/);assert.match(f.calls[1][1],/existing queue/);assert.equal(controlView(f.record,f.turn).status,'working');
 await f.service('20',{...input,action:'resume',requestId:next},null);assert.equal(f.calls.length,2);
 f.turn={id:next,completedAt:2,status:'completed'};assert.equal(controlView(f.record,f.turn),null);
});
test('stale turn, changed assignment and completed work cannot be interrupted',async()=>{
 const f=fixture();await assert.rejects(f.service('20',{...input,threadId:next},target),/Agent/);
 f.turn={id:next};await assert.rejects(f.service('20',input,target),/Run changed/);
 f.turn={id:turnId,completedAt:1};await assert.rejects(f.service('20',input,target),/Run ended/);assert.equal(f.calls.length,0);
});
test('a lost resume response remains uncertain and cannot be retried as another request',async()=>{
 let record={action:'stop',turnId,target},calls=0;
 const t={id:turnId,completedAt:1,status:'interrupted'};
 const service=createControlService({context:async()=>({root:{threadId:thread}}),read:async()=>record,write:async(_,r)=>{record=r},latest:async()=>t,resume:async()=>{calls++;throw Error('disconnect')}});
 await assert.rejects(service('20',{...input,action:'resume'},target),/disconnect/);
 assert.equal(controlView(record,t).status,'unknown');
 await service('20',{...input,action:'resume'},target);
 await assert.rejects(service('20',{...input,action:'resume',requestId:next},target),/Nothing to resume/);assert.equal(calls,1);
 assert.equal(controlView(record,{id:next,completedAt:null}),null,'another live turn supersedes the old stop');
});
test('stop alone never fabricates a paused state; unsupported UI omits controls',()=>{
 const record={action:'stop',turnId,target};assert.equal(controlView(record,{id:turnId,status:'interrupted',completedAt:null}).status,'unknown');
 assert.equal(controlView(record,{id:next}),null);
 const data={connected:true,settings:{},usage:[],queue:{items:[]},work:{status:'paused',...target},control:{status:'paused'},capabilities:{resume:true}};
 assert.match(activityControlMarkup({...data,status:'paused'}),/data-activity-control="resume"/);assert.match(agentMarkup(data),/data-agent-control="resume"/);assert.match(agentMarkup(data),/Paused/);
 assert.doesNotMatch(agentMarkup({...data,capabilities:{}}),/data-agent-control=/);
});

test('Activity shows only current public output and adjacent controls, not run history',()=>{
 const data={connected:true,settings:{},usage:[],queue:{items:[]},work:{status:'working',goalId:'2',title:'Task'},capabilities:{stop:true},currentMessages:[{text:'<update>'}],extensions:[{id:'continuation',activity:{runs:[{id:'old',at:'2026-01-01',status:'completed'}]}}]};
 const html=agentMarkup(data);assert.match(html,/data-agent-control="stop"/);assert.match(html,/&lt;update&gt;/);assert.doesNotMatch(html,/Recent runs|Run log|data-run-id/);
 assert.doesNotMatch(agentMarkup({...data,capabilities:{}}),/data-agent-control=/);
});
