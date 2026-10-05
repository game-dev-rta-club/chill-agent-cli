import test from 'node:test';
import assert from 'node:assert/strict';
import {agentPresence} from '../lib/agent-presence.mjs';
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
