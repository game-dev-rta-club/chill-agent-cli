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

test('the Approve all switch appears only when the agent can answer prompts',()=>{
 const able=agentMarkup({goalId:'2',rootId:'1',connected:true,agent:{name:'A'},capabilities:{approveAll:true},approveAll:true,work:{status:'idle'},queue:{items:[],truncated:false},extensions:[]});
 assert.match(able,/data-agent-approve-all[^>]*checked/);assert.match(able,/<h3>Queue/);
 const other=agentMarkup({goalId:'2',rootId:'1',connected:true,agent:{name:'B'},capabilities:{},settings:{},models:[],work:{status:'idle'},queue:null,extensions:[]});
 assert.doesNotMatch(other,/data-agent-approve-all/);
});

test('Activity lists recent Goals once each instead of a single Last link',()=>{
 const base={goalId:'2',rootId:'1',rootTitle:'Root',connected:true,agent:{name:'Claude Code',status:{label:'Waiting'}},capabilities:{},extensions:[]};
 const html=agentMarkup({...base,work:{status:'idle',goalId:null,last:{goalId:'2',title:'Tune',eventId:115}},recent:[{goalId:'3',title:'New <b>'},{goalId:'2',title:'Tune'}]});
 assert.match(html,/Recent/);assert.match(html,/href="#\/goal\/3"[^>]*><span>#3<\/span>New &lt;b&gt;/);assert.match(html,/href="#\/goal\/2"/);
 assert.doesNotMatch(html,/Last ·/);
});
