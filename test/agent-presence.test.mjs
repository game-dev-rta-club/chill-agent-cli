import test from 'node:test';
import assert from 'node:assert/strict';
import {agentPresence,readPresenceSnapshot} from '../lib/agent-presence.mjs';
import {activityMarkup} from '../public/agent-menu.js';

test('presence covers runs without feedback, manual pauses, idle, and unavailable evidence',()=>{
 const now=1000000;
 assert.equal(agentPresence({threadState:'active'}),'working');
 assert.equal(agentPresence({threadState:'notLoaded',turn:{id:'auto',completedAt:null,status:'inProgress'}}),'working');
 assert.equal(agentPresence({threadState:'idle',turn:{id:'auto',completedAt:null,status:'inProgress'}}),'unknown','conflicting native evidence is not Running');
 const interrupted={threadState:'notLoaded',turn:{id:'a',completedAt:null,status:'interrupted'}};
 assert.equal(agentPresence(interrupted,now),'unknown');
 assert.equal(agentPresence({...interrupted,selection:{turnId:'a',heartbeatAt:new Date(now).toISOString()}},now),'working');
 assert.equal(agentPresence({...interrupted,selection:{turnId:'old',heartbeatAt:new Date(now).toISOString()}},now),'unknown');
 assert.equal(agentPresence({threadState:'notLoaded',turn:{status:'completed',completedAt:1}}),'idle');
 assert.equal(agentPresence({threadState:'notLoaded',turn:{status:'interrupted',completedAt:1}}),'paused');
 assert.equal(agentPresence({threadState:'idle',holds:[{phase:'paused'}]}),'paused');
 assert.equal(agentPresence({threadState:'active',holds:[{phase:'paused'}]}),'working','independent active work takes precedence over an old held Goal');
 assert.equal(agentPresence({view:{status:'unknown'},threadState:'active'}),'unknown','a pending stop is not confirmed');
 assert.equal(agentPresence({threadState:'systemError',turn:{status:'completed',completedAt:1}}),'unknown');
 assert.equal(agentPresence({threadState:'notLoaded'}),'unknown');
 assert.equal(agentPresence({threadState:'idle'}),'idle');
});
test('extension messages render as escaped text; missing old snapshots are not reconstructed',()=>{
 const html=activityMarkup([{id:'test',label:'Policy',activity:{label:'AutoContinue',status:'Off',entries:[{id:'1',summary:'<img src=x>',message:'<script>alert(1)</script>\nnext line',result:{label:'No work reported'}},{id:'2',summary:'Old check',message:null,status:'Run ended'}],total:2}}]);
 assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>|<img/);assert.match(html,/next line/);
 assert.match(html,/Message not saved/);assert.match(html,/No work reported/);assert.match(html,/History/);
});

test('presence collects turn and thread state with one native connection and retains pending pause evidence',async()=>{
 let connects=0;const calls=[];
 const options={readControl:async()=>({action:'stop',turnId:'t',target:{goalId:'2'}}),connect:async run=>{connects++;return run({request:async method=>{calls.push(method);return method==='thread/read'?{thread:{status:{type:'active'}}}:{data:[{id:'t',completedAt:null,status:'inProgress'}]};}});}};
 const snapshot=await readPresenceSnapshot('chat',options);
 assert.equal(connects,1);assert.deepEqual(calls.sort(),['thread/read','thread/turns/list']);
 assert.equal(agentPresence(snapshot),'unknown','an unconfirmed pause is not presented as Running');
 assert.equal(agentPresence({...snapshot,view:null}),'working');
});
test('AutoContinue count reflects active work while completed history stays available',()=>{
 const data={label:'AutoContinue',total:14,activeCount:0,entries:[{id:'done',status:'Run ended',message:'done'}]};
 const markup=activeCount=>activityMarkup([{id:'test',enabled:false,activity:{...data,activeCount}}]);
 assert.match(markup(0),/title="Active checks">0</);assert.match(markup(0),/>Empty</);assert.match(markup(0),/>History/);
 assert.match(markup(1),/title="Active checks">1</);assert.doesNotMatch(markup(1),/>Empty</);
 assert.doesNotMatch(markup(undefined),/class="agent-count"/,'older extensions do not mislabel a history total as current work');
});

test('hooks confirm a live chat before selecting a Goal, but cannot outlive its turn',()=>{
 const now=Date.now(),turn={id:'new',status:'interrupted',completedAt:null},heartbeat={turnId:'new',heartbeatAt:new Date(now).toISOString()};
 const snapshot={threadState:'notLoaded',turn,heartbeat};
 assert.equal(agentPresence(snapshot,now),'working');
 assert.equal(agentPresence({...snapshot,selection:{turnId:'old',heartbeatAt:new Date(now).toISOString()}},now),'working');
 assert.equal(agentPresence({...snapshot,turn:{...turn,completedAt:1,status:'completed'}},now),'idle');
 assert.equal(agentPresence({...snapshot,turn:{...turn,completedAt:1}},now),'paused');
 assert.equal(agentPresence({...snapshot,turn:{...turn,id:'next'}},now),'unknown');
 assert.equal(agentPresence(snapshot,now+120001),'unknown');
});
