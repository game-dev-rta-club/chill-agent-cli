import test from 'node:test';
import assert from 'node:assert/strict';
import {agentMarkup} from '../public/agent-menu.js';

test('Activity keeps a link to the last Goal after the agent stops',()=>{
 const base={goalId:'2',rootId:'1',rootTitle:'Root',connected:true,agent:{name:'Claude Code',status:{label:'Waiting'}},capabilities:{},extensions:[]};
 const idle=agentMarkup({...base,work:{status:'idle',goalId:null,last:{goalId:'2',title:'Tune',eventId:115}}});
 assert.match(idle,/href="#\/goal\/2\/activity\/115">Last · #2 Tune →/);
 const running=agentMarkup({...base,work:{status:'working',goalId:'2',title:'Tune',eventId:115,last:{goalId:'2',title:'Tune',eventId:115}}});
 assert.doesNotMatch(running,/Last ·/,'while running, the current link is enough');
 assert.doesNotMatch(agentMarkup({...base,work:{status:'idle',goalId:null,last:null}}),/agent-work-link/);
});

test('extension sections sit at the bottom of the Agent menu with their switch; Autonomy is not among them',()=>{
 const controls=[{id:'notifications',label:'Notifications',enabled:true,placement:'header',icon:'bell',activity:{label:'Notifications',entries:[]}}];
 const markup=agentMarkup({goalId:'2',rootId:'1',connected:true,agent:{name:'A'},capabilities:{},work:{status:'idle'},queue:{items:[],truncated:false},extensions:controls});
 assert.ok(markup.indexOf('<h3>Queue')<markup.indexOf('<h3>Notifications'));
 assert.match(markup,/data-agent-extension="notifications"[^>]*aria-pressed="true"[\s\S]*?<span>On<\/span>/);
 assert.doesNotMatch(markup,/AutoContinue|Approve all|Autonomy/,'Autonomy is set in the comment box');
});

test('Activity lists recent Goals once each instead of a single Last link',()=>{
 const base={goalId:'2',rootId:'1',rootTitle:'Root',connected:true,agent:{name:'Claude Code',status:{label:'Waiting'}},capabilities:{},extensions:[]};
 const html=agentMarkup({...base,work:{status:'idle',goalId:null,last:{goalId:'2',title:'Tune',eventId:115}},recent:[{goalId:'3',title:'New <b>'},{goalId:'2',title:'Tune'}]});
 assert.match(html,/Recent/);assert.match(html,/href="#\/goal\/3"[^>]*><span class="agent-recent-id">#3<\/span><span class="agent-recent-title">New &lt;b&gt;<\/span>/);assert.match(html,/href="#\/goal\/2"/);
 assert.doesNotMatch(html,/Last ·/);
});

test('Activity shows what a waiting agent waits for and when it checks again',()=>{
 const base={goalId:'2',rootId:'1',connected:true,agent:{name:'Claude Code'},capabilities:{},extensions:[]};
 const at=new Date(Date.now()+10*60000).toISOString();
 const html=agentMarkup({...base,work:{status:'idle',goalId:null,wake:{at,reason:'CI on <PR>'}}});
 assert.match(html,/Waiting<\/span><p class="agent-wait">CI on &lt;PR&gt;<\/p><p class="agent-muted">Checks again · <time datetime="/);
 assert.doesNotMatch(html,/>Idle</);
 const late=agentMarkup({...base,work:{status:'idle',goalId:null,wake:{at:new Date(Date.now()-10*60000).toISOString(),reason:''}}});
 assert.match(late,/Check overdue<\/span><p class="agent-wait">No reason given\.<\/p><p class="agent-muted">The check was due ·/);
 assert.match(agentMarkup({...base,work:{status:'working',goalId:null,wake:{at,reason:'x'}}}),/Running/,'a running agent is not waiting');
});
