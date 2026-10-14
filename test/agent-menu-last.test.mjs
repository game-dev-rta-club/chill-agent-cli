import test from 'node:test';
import assert from 'node:assert/strict';
import {agentMarkup} from '../public/agent-menu.js';

test('Activity keeps a link to the last Goal after the agent stops',()=>{
 const base={goalId:'2',rootId:'1',rootTitle:'Root',nativeConnection:{harnessId:'claude-code',status:{state:'waiting',label:'Waiting'}},extensions:[]};
 const idle=agentMarkup({...base,work:{status:'idle',goalId:null,last:{goalId:'2',title:'Tune',eventId:115}}});
 assert.match(idle,/href="#\/goal\/2\/activity\/115">Last · #2 Tune →/);
 const running=agentMarkup({...base,work:{status:'working',goalId:'2',title:'Tune',eventId:115,last:{goalId:'2',title:'Tune',eventId:115}}});
 assert.doesNotMatch(running,/Last ·/,'while running, the current link is enough');
 assert.doesNotMatch(agentMarkup({...base,work:{status:'idle',goalId:null,last:null}}),/agent-work-link/);
});

test('only Claude connections show the Approve all switch',()=>{
 const claude=agentMarkup({goalId:'2',rootId:'1',nativeConnection:{harnessId:'claude-code',status:{state:'waiting',label:'Waiting'},approveAll:true},work:{status:'idle'},queue:{items:[],truncated:false},extensions:[]});
 assert.match(claude,/data-agent-approve-all[^>]*checked/);assert.match(claude,/<h3>Queue/);
 const codex=agentMarkup({goalId:'2',rootId:'1',connected:true,capabilities:{},settings:{},models:[],work:{status:'idle'},queue:null,extensions:[]});
 assert.doesNotMatch(codex,/data-agent-approve-all/);
});
