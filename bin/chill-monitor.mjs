#!/usr/bin/env node
import '../lib/quiet-sqlite-warning.mjs';
import {readMonitor} from '../lib/continuation-monitor.mjs';
import {agentContinuation} from '../lib/agents/index.mjs';
import {readGoalContext} from '../lib/extension-api.mjs';
const [command,...args]=process.argv.slice(2);
const usage=`End-of-turn checks that Autonomy asks for, with durable attempt limits.
Usage: chill monitor <status|tick> --id <ROOT>
Autonomy is set per agent (per Root) in any of its Goals' comment boxes on the Web: at Auto Continue or Ultra Continue, the agent gets one end-of-turn check per user/Goal/Deliverable/Autonomy revision. A Claude conversation is checked at its own Stop; the Web server checks a Codex chat every 30s. Unknown/paused/queued states never send.
status prints the Root's check record. tick runs one check now for a Codex chat; the Web server runs the same check itself.
chill records the result of each check itself; there is nothing to report.`;
try{
 if(!command||command==='--help'||args.includes('--help'))console.log(usage);
 else if(!['status','tick'].includes(command)||args.length!==2||args[0]!=='--id'||!/^[1-9][0-9]*$/.test(args[1]))throw Error(usage);
 else if(command==='status')console.log(JSON.stringify(await readMonitor(args[1]),null,2));
 else{
  const continuation=agentContinuation((await readGoalContext(args[1])).root);
  if(!continuation?.tick)throw Error('This Root\'s agent is checked at its own Stop, not by tick.');
  console.log(JSON.stringify(await continuation.tick(),null,2));
 }
}catch(error){console.error(error.message);process.exitCode=1;}
