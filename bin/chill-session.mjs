#!/usr/bin/env node
import '../lib/quiet-sqlite-warning.mjs';
import {harnessGuidance,supportedHarnesses} from '../extensions/harnesses/index.mjs';
import {startSession} from '../lib/harness-session.mjs';
const [action,...args]=process.argv.slice(2);
try{
 if(!action||action==='--help'||args.includes('--help'))console.log('Supported harness IDs: '+supportedHarnesses().join(', ')+'\nchill session guide --harness <id> | chill session start --harness <id> --project <native project directory>. Guide returns the selected connection operations and confirmation rules without connecting or mutating state.');
 else{
  if(!['guide','start'].includes(action))throw Error('Unknown session action. Use --help.');
  const values={};for(let i=0;i<args.length;i+=2){const key=args[i];if(!['--harness',...(action==='start'?['--project']:[])].includes(key)||!args[i+1]||values[key])throw Error('Invalid session arguments. Use --help.');values[key]=args[i+1];}
  const result=action==='guide'?harnessGuidance(values['--harness']):await startSession({project:values['--project'],harness:values['--harness']});
  console.log(JSON.stringify(result,null,2));
 }
}catch(error){console.error(error.stderr||error.message);process.exitCode=1;}
