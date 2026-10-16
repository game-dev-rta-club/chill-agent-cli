import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {harnessGuidance} from '../extensions/harnesses/index.mjs';
import {startSession} from '../lib/harness-session.mjs';
test('selected interfaces preserve different receipt and completion semantics',()=>{
 const a=harnessGuidance('codex-desktop'),b=harnessGuidance('claude-code');
 assert(a.operations.receipt.states.includes('deferred'));assert(a.operations.selectWork);
 assert(!b.operations.receipt.states.includes('deferred'));assert.match(b.operations.selectWork.command,/goal work/);
 assert.match(b.operations.createRoot.confirmation,/at once/);
 a.operations.receipt.states.push('invented');assert(!harnessGuidance('codex-desktop').operations.receipt.states.includes('invented'));
 assert.throws(()=>harnessGuidance('unknown'),/no fallback/);
});
for(const harness of ['codex-desktop','claude-code'])for(const running of [true,false])test(`session prepares ${harness}; existing Web=${running}`,async()=>{
 const project=await mkdtemp(join(tmpdir(),'chill-session-')),calls=[];
 try{
  const result=await startSession({project,harness},{runtime:project,env:{PORT:'4174',CHILL_AGENT_DATA_DIR:'/foreign',KEEP:'yes'},execute:async(node,args,options)=>{
   calls.push(args);assert.equal(options.cwd,await realpath(project));assert.equal(options.env.PORT,undefined);assert.equal(options.env.KEEP,'yes');
   if(args[0].endsWith('chill-setup.mjs')){
    assert.equal(options.env.CHILL_AGENT_DATA_DIR,undefined);
    assert.deepEqual(args.slice(1),['prepare','--isolated','--project',await realpath(project),'--harness',harness]);
    return {stdout:JSON.stringify({launcher:'stable',dataDirectory:'/selected',command:'stable-prefix',url:'http://127.0.0.1:51234',next:'legacy setup instructions'})};
   }
   assert.equal(options.env.CHILL_AGENT_DATA_DIR,'/selected');
   return {stdout:args[2]==='status'?(running?'Running (PID 10): http://localhost':'Stopped'):'Started'};
  }});
  assert.equal(result.connectionVerified,false);assert.equal(result.interface.harnessId,harness);
  assert.equal(result.url,'http://127.0.0.1:51234');assert.equal(result.command,'stable-prefix');
  assert.notEqual(result.next,'legacy setup instructions');
  assert(result.interface.activation.beforeCreate);assert(result.interface.onboarding.initialGoal.welcome);
  assert.equal(calls.some(args=>args[2]==='start'),!running);
 }finally{await rm(project,{recursive:true,force:true});}
});
test('guide is read-only and returns independent welcome data for each caller',()=>{
 const a=harnessGuidance('codex-desktop'),b=harnessGuidance('claude-code');
 assert.deepEqual(a.onboarding,b.onboarding);
 assert.notDeepEqual(a.activation,b.activation);
 a.onboarding.initialGoal.title='changed';
 assert.notEqual(harnessGuidance('codex-desktop').onboarding.initialGoal.title,'changed');
 assert.equal(b.onboarding.initialGoal.title,harnessGuidance('claude-code').onboarding.initialGoal.title);
});
test('unknown harness fails before performing setup',async()=>{
 let calls=0;await assert.rejects(startSession({project:'/absent',harness:'unknown'},{execute:async()=>{calls++;}}),/Unknown harness/);assert.equal(calls,0);
});
