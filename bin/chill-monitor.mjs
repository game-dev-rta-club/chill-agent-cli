#!/usr/bin/env node
import '../lib/quiet-sqlite-warning.mjs';
import {configureMonitor,readMonitor,tickMonitor} from '../lib/continuation-monitor.mjs';
import {agentContinuation} from '../lib/agents/index.mjs';
import {monitorService} from '../lib/continuation-service.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {touch as hostTouch,workspacePort,resolveWorkspacePort,readGoalContext} from '../lib/extension-api.mjs';
const [command,...args]=process.argv.slice(2);
let continuation;
const usage='Optional continuation checks with durable attempt limits.\nUsage: chill monitor <start|stop|enable|disable|status|tick|watch|result> --id <ROOT>\nOpt-in continuation: at most 1 combined continuation and stopping-review nudge per user/Goal/Deliverable revision. The hosted extension checks every 30s, without fixed idle/cooldown delays. start runs monitoring inside the Web server; stop disables only this Root monitor. Web remains available. watch is retired; use start. CLI-only servers may disable extensions with CHILL_AGENT_EXTENSIONS=none. Unknown/paused/queued states never send. enable preserves attempts. disable stops future sends, not a message already queued.\nResult: chill monitor result --id <ROOT> --attempt <UUID> --outcome <worked|no-work>. Saves internal results only; requires the assigned Codex thread or experimental native main-hook confirmation.\nExperimental Claude: enable/disable and result use main-hook actions. pause/resume hold only future continuations, not native execution. A verified main Stop drives checking; start/tick/watch are unsupported. Native tool permissions remain unchanged.';
try{
 if(!command||command==='--help'||args.includes('--help'))console.log(usage);
 else if(!/^[1-9][0-9]*$/.test(args[1]||''))throw Error(usage);
 else if(command==='status'&&args.length===2&&args[0]==='--id')console.log(JSON.stringify(await readMonitor(args[1]),null,2));
 else if((continuation=agentContinuation((await readGoalContext(args[1]).catch(()=>null))?.root||{}))?.confirmed){
  // This agent records monitor commands for its own conversation.
  let input;
  if(command==='result'){
   if(args.length!==6||args[0]!=='--id'||args[2]!=='--attempt'||args[4]!=='--outcome')throw Error(usage);
   input={rootId:args[1],attemptId:args[3],outcome:args[5]};
  }else {
   if(args.length!==2||args[0]!=='--id')throw Error(usage);
   input={rootId:args[1]};
  }
  console.log((await continuation.confirmed(command,input)).text);
 }
 else if(command==='result'){
  if(args.length!==6||args[0]!=='--id'||args[2]!=='--attempt'||args[4]!=='--outcome')throw Error(usage);
  if(!continuation?.report)throw Error('Result must come from the assigned chat.');
  console.log(JSON.stringify(await continuation.report(args[3],args[5]),null,2));
 }
 else{
  if(args.length!==2||args[0]!=='--id'||! /^[1-9][0-9]*$/.test(args[1])||!['start','stop','enable','disable','status','tick','watch'].includes(command))throw Error(usage);
  const id=args[1];
  if(command==='start'){
   await resolveWorkspacePort();
   const url=()=>`http://127.0.0.1:${workspacePort()}/api/goals/${id}/extensions`;
   let response;try{response=await fetch(url(),{signal:AbortSignal.timeout(2000)});}catch{
    await promisify(execFile)(process.execPath,[fileURLToPath(new URL('./chill-server.mjs',import.meta.url)),'start']);
    response=await fetch(url(),{signal:AbortSignal.timeout(5000)});
   }
   if(!response.ok||!(await response.json()).some(e=>e.id==='continuation'))throw Error('This Web server does not host the continuation extension. Update/restart it first.');
   if(process.platform==='darwin')await monitorService(id,'stop');
   await configureMonitor(id,true);await hostTouch();console.log(JSON.stringify({enabled:true,host:'web-server'},null,2));
  }
  else if(command==='stop'){await configureMonitor(id,false);if(process.platform==='darwin')await monitorService(id,'stop');console.log(JSON.stringify({enabled:false,host:'web-server'},null,2));}
  else if(['enable','disable'].includes(command))console.log(JSON.stringify(await configureMonitor(id,command==='enable'),null,2));
  else if(command==='status')console.log(JSON.stringify(await readMonitor(id),null,2));
  else if(command==='tick')console.log(JSON.stringify(await tickMonitor(id),null,2));
  else throw Error('Standalone watch is retired. Use monitor start to run in the Web server.');

 }
}catch(error){console.error(error.message);process.exitCode=1;}
