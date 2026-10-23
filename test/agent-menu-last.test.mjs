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

test('Approve all sits at the bottom of the Agent menu after AutoContinue, with the same switch',()=>{
 const controls=[{id:'continuation',label:'Auto-continue',enabled:false,placement:'header',icon:'repeat',activity:{label:'AutoContinue',entries:[]}},
  {id:'approve-all',label:'Approve all',enabled:true,placement:'header',icon:'shield',activity:{label:'Approve all',entries:[]}}];
 const markup=agentMarkup({goalId:'2',rootId:'1',connected:true,agent:{name:'A'},capabilities:{approveAll:true},approveAll:true,work:{status:'idle'},queue:{items:[],truncated:false},extensions:controls});
 assert.ok(markup.indexOf('<h3>Queue')<markup.indexOf('<h3>AutoContinue')&&markup.indexOf('<h3>AutoContinue')<markup.indexOf('<h3>Approve all'));
 assert.match(markup,/data-agent-extension="approve-all"[^>]*aria-pressed="true"[\s\S]*?<span>On<\/span>/);
 assert.doesNotMatch(markup,/data-agent-approve-all/,'no separate switch in the agent header');
});

test('Activity lists recent Goals once each instead of a single Last link',()=>{
 const base={goalId:'2',rootId:'1',rootTitle:'Root',connected:true,agent:{name:'Claude Code',status:{label:'Waiting'}},capabilities:{},extensions:[]};
 const html=agentMarkup({...base,work:{status:'idle',goalId:null,last:{goalId:'2',title:'Tune',eventId:115}},recent:[{goalId:'3',title:'New <b>'},{goalId:'2',title:'Tune'}]});
 assert.match(html,/Recent/);assert.match(html,/href="#\/goal\/3"[^>]*><span class="agent-recent-id">#3<\/span><span class="agent-recent-title">New &lt;b&gt;<\/span>/);assert.match(html,/href="#\/goal\/2"/);
 assert.doesNotMatch(html,/Last ·/);
});
