#!/usr/bin/env node
// An opt-in, bounded model conversation in disposable config/data. This is a
// protocol probe, never a user's session, production Goal or hook installation.
import {execFile} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm,writeFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseArgs,promisify} from 'node:util';
import {authNames,probeAuthSettings} from './claude-probe-auth.mjs';

const {values}=parseArgs({options:{claude:{type:'string',default:'claude'},'auth-settings':{type:'string'},automatic:{type:'boolean',default:false},run:{type:'boolean',default:false},help:{type:'boolean',default:false}}});
if(values.help||!values.run){console.log('Usage: node scripts/probe-claude-roundtrip.mjs --run [--claude /path/to/claude] [--auth-settings /path/to/settings.json] [--automatic]\nUses available native authentication for one temporary print-mode conversation (budget $0.75, timeout 120 seconds). --auth-settings explicitly reuses only API auth/endpoint environment and the model preference, in memory. No settings file or credentials are copied to the temporary config or printed. --automatic replaces the inbox command with ordinary work to exercise automatic tool-hook delivery. The probe runner is allowed as Bash; native permission policy still applies. Does not install hooks or touch production data. Without --run, performs no work.');process.exit(0);}
const execute=promisify(execFile),base=await mkdtemp(join(tmpdir(),'chill-claude-roundtrip-'));
const cwd=join(base,'project'),config=join(base,'config'),data=join(base,'data');
const runner=join(base,'runner.mjs'),hook=join(base,'hook.mjs'),trace=join(base,'trace.jsonl'),settings=join(base,'settings.json');
const entry=new URL('../bin/chill-connection.mjs',import.meta.url).pathname;
const store=new URL('../lib/goal-store.mjs',import.meta.url).href;
const feedbackToken=randomUUID(),memoryToken=randomUUID();
const env={};for(const key of ['PATH','HOME','TMPDIR','USER','LOGNAME','SHELL','LANG','LC_ALL',...(values['auth-settings']?[]:authNames)])if(process.env[key]!==undefined)env[key]=process.env[key];
Object.assign(env,{CLAUDE_CONFIG_DIR:config,CHILL_AGENT_DATA_DIR:data,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL:'1'});
const report={checkedAt:new Date().toISOString(),scope:'Disposable authenticated print-mode main-hook roundtrip. No existing user chat, interactive idle wake, controls or Auto mode qualification.'};
report.feedbackMode=values.automatic?'automatic-tool-hook':'explicit-inbox';
let phase='prepare';
try {
  phase='auth-settings';
  const nativeSettings=values['auth-settings']?await probeAuthSettings(values['auth-settings']):null;
  if(nativeSettings)Object.assign(env,nativeSettings.env);
  report.authenticationSource=nativeSettings?'explicit-native-settings':'process-environment';
  const modelArgs=nativeSettings?.model?['--model',nativeSettings.model]:[];
  phase='prepare';
  await mkdir(cwd);await mkdir(config);
  await writeFile(runner,`import {execFileSync} from 'node:child_process';
import {listGoals,appendFeedback} from ${JSON.stringify(store)};
const action=process.argv[2];
let args;
if(action==='create')args=['create-goal','--title','Disposable native roundtrip','--scope','Probe only','--criteria','Receipt completed'];
else if(action==='inbox'||action==='work'){
 const goals=await listGoals();if(goals.length!==1)throw Error('Expected one main-hook-created Goal.');
 await appendFeedback({goalId:goals[0].id,text:${JSON.stringify(`Probe feedback. Remember this token for your final reply: ${feedbackToken}`)}});
 if(action==='work'){console.log('Probe work complete.');process.exit(0);}
 args=['inbox'];
}else if(['working','completed'].includes(action))args=['activity','--event','1','--state',action];
else throw Error('Invalid probe action');
process.stdout.write(execFileSync(process.execPath,[${JSON.stringify(entry)},...args],{encoding:'utf8',timeout:10000}));
`);
  await writeFile(hook,`import {execFileSync} from 'node:child_process';
import {appendFileSync} from 'node:fs';
const chunks=[];for await(const c of process.stdin)chunks.push(c);
const input=Buffer.concat(chunks).toString('utf8'),event=JSON.parse(input);
let output='',failed=false;
try{output=execFileSync(process.execPath,[${JSON.stringify(entry)},'claude-hook'],{input,encoding:'utf8',timeout:10000});}
catch{failed=true;}
appendFileSync(${JSON.stringify(trace)},JSON.stringify({event:event.hook_event_name,sessionId:event.session_id,promptId:event.prompt_id||null,main:event.agent_id==null,tool:event.tool_name||null,context:output.length>0,failed})+'\\n',{mode:0o600});
if(failed)process.exitCode=1;else process.stdout.write(output);
`);
  const command={type:'command',command:process.execPath,args:[hook],timeout:12};
  await writeFile(settings,JSON.stringify({hooks:{SessionStart:[{hooks:[command]}],PostToolUse:[{hooks:[command]}],Stop:[{hooks:[command]}]}}));
  report.version=(await execute(values.claude,['--version'],{env,cwd,timeout:10000})).stdout.trim();
  phase='authentication';
  let authOutput;
  try{authOutput=(await execute(values.claude,['auth','status','--json'],{env,cwd,timeout:10000})).stdout;}
  catch(error){if(error.code!==1||!error.stdout)throw error;authOutput=error.stdout;}
  const auth=JSON.parse(authOutput);
  report.auth={loggedIn:auth.loggedIn===true,method:auth.authMethod||null};
  if(!report.auth.loggedIn)throw Error('No authentication in the isolated native configuration.');
  const q=s=>`'${s.replaceAll("'","'\\''")}'`,call=action=>`${q(process.execPath)} ${q(runner)} ${action}`;
  const prompt=`This is a disposable integration probe. Keep memory token ${memoryToken} for your final reply. Run exactly these four Bash calls, separately and in this order: ${call('create')}; ${call(values.automatic?'work':'inbox')}; ${call('working')}; ${call('completed')}. After each call read its hook additionalContext. Do not read any files, run other commands, or perform user work. If a call fails stop and report failure. At the end report both the memory token and the token contained only in the saved user feedback from the hook, and say roundtrip complete.`;
  phase='conversation';
  const result=await execute(values.claude,['--print','--output-format','json','--max-budget-usd','0.75',...modelArgs,'--no-session-persistence','--setting-sources','','--settings',settings,'--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--tools','Bash','--allowedTools',`Bash(${process.execPath} ${runner} *)`,'--no-chrome',prompt],{env,cwd,timeout:120000,maxBuffer:1024*1024});
  phase='verify';
  const native=JSON.parse(result.stdout),events=(await readFile(trace,'utf8')).trim().split('\n').map(JSON.parse);
  const goals=await readdir(join(data,'workspace/goals'));
  const goal=JSON.parse(await readFile(join(data,'workspace/goals',goals[0],'goal.json'),'utf8'));
  const delivery=JSON.parse(await readFile(join(data,'workspace/deliveries/1.json'),'utf8'));
  report.native={isError:native.is_error===true,subtype:native.subtype,numTurns:native.num_turns,costUSD:native.total_cost_usd};
  report.hooks=events;
  report.checks={oneGoal:goals.length===1,mainSession:events.every(e=>e.main&&e.sessionId===goal.connection.sessionId),startup:events.some(e=>e.event==='SessionStart'&&!e.failed),fourMainContexts:events.filter(e=>e.event==='PostToolUse'&&e.context&&!e.failed).length===4,
    completedReceipt:delivery.status==='completed'&&delivery.agentReported===true&&delivery.connection.sessionId===goal.connection.sessionId,
    feedbackRead:String(native.result).includes(feedbackToken),initialContextRetained:String(native.result).includes(memoryToken),nativeSuccess:!native.is_error};
  if(values.automatic){
    const toolEvents=events.filter(e=>e.event==='PostToolUse');
    report.checks.sameNativePrompt=toolEvents.length>=4&&toolEvents.every(e=>e.promptId&&e.promptId===toolEvents[0].promptId);
    report.checks.stopObserved=events.some(e=>e.event==='Stop'&&!e.failed);
  }
  report.passed=Object.values(report.checks).every(Boolean);
}catch(error){
  report.passed=false;report.failure={phase,code:error.code??null,signal:error.signal??null,killed:error.killed===true};
  try{report.hooks=(await readFile(trace,'utf8')).trim().split('\n').map(JSON.parse);}catch{}
}finally{await rm(base,{recursive:true,force:true});}
console.log(JSON.stringify(report,null,2));if(!report.passed)process.exitCode=1;
