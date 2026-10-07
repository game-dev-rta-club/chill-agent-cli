#!/usr/bin/env node
// Qualify an optional product policy through a native Stop, in an isolated runtime.
import {spawn,execFile} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm,writeFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseArgs,promisify} from 'node:util';
import {prepareRuntime} from '../lib/runtime-package.mjs';
import {authNames,probeAuthSettings} from './claude-probe-auth.mjs';
const {values}=parseArgs({options:{run:{type:'boolean'},runtime:{type:'string'},claude:{type:'string',default:'claude'},'auth-settings':{type:'string'},'setup-resume':{type:'boolean'},help:{type:'boolean'}}});
if(values.help||!values.run){console.log('Usage: node scripts/probe-claude-auto.mjs --run --runtime /path/to/composed/runtime [--claude /path/to/claude] [--auth-settings /path/to/native-settings.json] [--setup-resume]\nOne disposable native print-mode session, $0.75 budget, 120-second timeout. --setup-resume first persists a $0.15/45-second conversation, installs project hooks, then resumes it. Tests an optional continuation policy through the packaged launcher and native main hooks. No normal settings, production data, permission modes or Channels are changed.');process.exit(0);}
if(!values.runtime)throw Error('A composed runtime is required.');
const base=await mkdtemp(join(tmpdir(),'chill-claude-auto-')),cwd=join(base,'project'),config=join(base,'config'),data=join(base,'data');
const hook=join(base,'hook.mjs'),runner=join(base,'runner.mjs'),trace=join(base,'trace.jsonl'),settings=join(base,'settings.json');
const memory=randomUUID(),report={checkedAt:new Date().toISOString(),scope:values['setup-resume']?'Isolated project setup after a persisted conversation; resume of that same native conversation, not hot-installation or production setup.':'Disposable native print-mode session and composed runtime; not production setup or permanent idle delivery.'};
const env={};for(const key of ['PATH','HOME','TMPDIR','USER','LOGNAME','SHELL','LANG','LC_ALL',...(values['auth-settings']?[]:authNames)])if(process.env[key]!==undefined)env[key]=process.env[key];
Object.assign(env,{CLAUDE_CONFIG_DIR:config,CHILL_AGENT_DATA_DIR:data,CHILL_AGENT_CODEX_PATH:'/never/call/codex',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL:'1'});
const execute=promisify(execFile),results=[],messages=[],toolCalls=[];let child,timer,phase='prepare',exit,lines='',stderrBytes=0,streamError,earlier,setup;
try {
 const auth=values['auth-settings']?await probeAuthSettings(values['auth-settings']):null;if(auth)Object.assign(env,auth.env);
 await mkdir(cwd);await mkdir(config);
 const runtime=await prepareRuntime(resolve(values.runtime),data),entry=runtime.launcher;
 await writeFile(runner,`import {execFileSync} from 'node:child_process';
const action=process.argv[2],attempt=process.argv[3];
const args=action==='create'?['connection','create-goal','--title','Disposable Auto mode probe']:action==='enable'?['monitor','enable','--id','1']:action==='review'?['goal','review','--id','1','--state','unfinished']:action==='show'?['goal','show','--id','1','--format','text','--section','context']:action==='result'&&/^[a-f0-9-]{36}$/.test(attempt)?['monitor','result','--id','1','--attempt',attempt,'--outcome','no-work']:null;
if(!args)throw Error('Unknown probe action');
try{process.stdout.write(execFileSync(process.execPath,[${JSON.stringify(entry)},...args],{encoding:'utf8',timeout:10000}));}catch(error){console.error('Probe action failed:',action);throw error;}\n`);
 await writeFile(hook,`import {execFileSync} from 'node:child_process';import {appendFileSync} from 'node:fs';
const chunks=[];for await(const c of process.stdin)chunks.push(c);const raw=Buffer.concat(chunks).toString(),input=JSON.parse(raw);let out='',failed=false;
try{if(!${Boolean(values['setup-resume'])})out=execFileSync(process.execPath,[${JSON.stringify(entry)},'connection','claude-hook'],{input:raw,encoding:'utf8',timeout:10000});}catch{failed=true;}
let decision=null;try{decision=JSON.parse(out).decision||null;}catch{}
appendFileSync(${JSON.stringify(trace)},JSON.stringify({at:Date.now(),event:input.hook_event_name,sessionId:input.session_id,promptId:input.prompt_id||null,main:input.agent_id==null,envFile:!!process.env.CLAUDE_ENV_FILE,decision,context:!!out,failed})+'\\n',{mode:0o600});
if(failed)process.exitCode=1;else process.stdout.write(out);\n`);
 const command={type:'command',command:process.execPath,args:[hook],timeout:12};
 await writeFile(settings,JSON.stringify({hooks:Object.fromEntries(['SessionStart','UserPromptSubmit','PostToolUse','Stop','SessionEnd'].map(name=>[name,[{hooks:[command]}]]))}));
 report.version=(await execute(values.claude,['--version'],{env,cwd,timeout:10000})).stdout.trim();
 if(values['setup-resume']){
  phase='earlier-conversation';
  const first=await execute(values.claude,['--print','--output-format','json','--max-budget-usd','0.15',...(auth?.model?['--model',auth.model]:[]),'--setting-sources','','--settings','{}','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--tools','','--no-chrome',`Remember this token for later: ${memory}. Reply READY. Do not call tools.`],{env,cwd,timeout:45000,maxBuffer:1024*1024});
  earlier=JSON.parse(first.stdout);if(earlier.is_error||!earlier.session_id)throw Error('Initial native conversation failed.');
  report.earlier={sessionId:earlier.session_id,costUSD:earlier.total_cost_usd};
  phase='native-setup';await mkdir(join(cwd,'.claude'));
  // An unrelated observer makes it possible to verify additive native settings
  // without wrapping, replacing or simulating the installed chill hooks.
  await writeFile(join(cwd,'.claude/settings.local.json'),JSON.stringify({...JSON.parse(await readFile(settings,'utf8')),spinnerTipsEnabled:false}));
  setup=JSON.parse((await execute(process.execPath,[entry,'setup','prepare','--harness','claude-code','--project',cwd],{env,cwd,timeout:15000,maxBuffer:1024*1024})).stdout);
  if(!setup.hook.configured)throw Error('Native settings were not configured.');
 }
 const q=s=>/^[A-Za-z0-9_/.:-]+$/.test(s)?s:`'${s.replaceAll("'","'\\''")}'`,call=a=>`${q(process.execPath)} ${q(runner)} ${a}`;
 const prompt=`This is a disposable integration probe. ${earlier?'Keep the token from our earlier conversation; it is not repeated here.':`Remember ${memory}.`} Run two separate Bash calls, first ${call('create')}, then ${call('enable')}. Read their native hooks, then reply READY and the memory token and finish. Do not run more tools unless a native Stop hook asks you to continue. If Auto mode then asks for a next action, the agreed scope is only this probe: run ${call('review')} and ${call('show')} separately, then return its exact attempt ID using ${call('result')} <attempt-uuid>. The helper calls the same packaged commands printed by the hook. Do not change the Goal or write comments, there is no actual project work here. Finally say COMPLETE and the original memory token, and finish. Use only this helper; do not create more work or call other tools.`;
 const args=['--print','--verbose','--output-format','stream-json','--max-budget-usd','0.75',...(auth?.model?['--model',auth.model]:[]),...(earlier?['--resume',earlier.session_id,'--setting-sources','local']:['--no-session-persistence','--setting-sources','','--settings',settings]),'--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--tools','Bash','--allowedTools',`Bash(${process.execPath} ${runner} *)`,'--no-chrome',prompt];
 phase='conversation';child=spawn(values.claude,args,{env,cwd,stdio:['ignore','pipe','pipe'],detached:true});
 const ended=new Promise(r=>{child.on('error',()=>r({spawnError:true}));child.on('exit',(code,signal)=>r({code,signal}));});
 child.stderr.on('data',c=>{stderrBytes+=c.length;});
 child.stdout.on('data',chunk=>{lines+=chunk.toString();if(lines.length>1024*1024){streamError='oversized-line';child.kill();return;}let i;while((i=lines.indexOf('\n'))>=0){const line=lines.slice(0,i);lines=lines.slice(i+1);if(!line.trim())continue;try{const m=JSON.parse(line);if(m.type==='result')results.push(m);if(m.type==='assistant')toolCalls.push(...(m.message?.content||[]).filter(c=>c.type==='tool_use').map(c=>({name:c.name,helper:c.input?.command?.includes(runner)||false,action:['create','enable','review','show','result'].find(a=>c.input?.command?.includes(runner)&&new RegExp('\\b'+a+'\\b').test(c.input.command))||null,quotedExecutable:c.input?.command?.startsWith("'")||false})));if(m.type==='assistant')messages.push((m.message?.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n'));}catch{streamError='invalid-stream';}}});
 timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGTERM');}catch{}},120000);
 exit=await ended;phase='verify';
 const events=(await readFile(trace,'utf8')).trim().split('\n').map(JSON.parse),goal=JSON.parse(await readFile(join(data,'workspace/goals/1/goal.json'),'utf8')),state=JSON.parse(await readFile(join(data,'workspace/continuation/1.json'),'utf8'));
 const attempt=state.attempts[0],blocks=events.filter(e=>e.decision==='block'),final=messages.filter(m=>m.includes('COMPLETE'));
 report.hooks=events;report.nativeResults=results.map(r=>({sessionId:r.session_id,isError:r.is_error===true,subtype:r.subtype,costUSD:r.total_cost_usd}));
 report.continuation={enabled:state.enabled,status:state.status,attempts:state.attempts.length,phase:attempt?.phase,outcome:attempt?.result?.outcome,completed:!!attempt?.completedAt};
 report.checks={oneGoal:(await readdir(join(data,'workspace/goals'))).length===1,oneInitialInput:events.filter(e=>e.event==='UserPromptSubmit').length===1,oneContinuation:blocks.length===1&&state.attempts.length===1,savedBeforeOutput:Date.parse(attempt?.at)<=blocks[0]?.at,oneNativeSession:results.length===1&&results[0].session_id===goal.connection.sessionId,mainHooks:events.every(e=>e.main&&!e.failed&&e.sessionId===goal.connection.sessionId),contextRetained:final.some(m=>m.includes(memory)),resultConfirmed:attempt?.result?.outcome==='no-work'&&attempt.phase==='completed',matchingFinalStop:events.some(e=>e.event==='Stop'&&e.decision===null&&e.promptId===attempt?.nativePromptId&&e.at>=Date.parse(attempt?.completedAt)),allowanceConsumed:state.status==='exhausted',noCodexBinding:goal.threadId===null&&goal.connection.harnessId==='claude-code',nativeSuccess:exit.code===0&&results.length===1&&!results[0].is_error&&!streamError,sessionEnded:events.some(e=>e.event==='SessionEnd'&&!e.failed)};
 if(earlier){
  report.scope='Explicit native project setup after an earlier persisted conversation; native resume of the same conversation, not hot-installation into a running process.';
  const config=JSON.parse(await readFile(join(cwd,'.claude/settings.local.json'),'utf8'));
  const records=join(data,'workspace/connections/claude-code'),file=(await readdir(records)).find(p=>p.endsWith('.json')),record=JSON.parse(await readFile(join(records,file),'utf8'));
  delete report.checks.savedBeforeOutput;delete report.checks.matchingFinalStop;
  Object.assign(report.checks,{oneContinuation:state.attempts.length===1&&events.filter(e=>e.event==='Stop').length===2,nativeResume:record.source==='resume'&&record.sessionId===earlier.session_id,sameEarlierConversation:goal.connection.sessionId===earlier.session_id,settingsPreserved:config.spinnerTipsEnabled===false&&config.hooks.Stop.length===2,setupUsed:setup.hook.configured&&setup.codex===undefined});
 }
 report.passed=Object.values(report.checks).every(Boolean);
}catch(error){report.passed=false;report.failure={phase,code:error.code??null,signal:error.signal??null,resource:error.path?relative(base,error.path):null,message:'Probe failed; raw native output withheld.'};try{report.hooks=(await readFile(trace,'utf8')).trim().split('\n').map(JSON.parse);}catch{}report.nativeResults=results.map(r=>({sessionId:r.session_id,isError:r.is_error===true,subtype:r.subtype,costUSD:r.total_cost_usd}));report.diagnosticCategories=['No Claude entry handshake','generation','permission','not allowed','not permitted','stale','missing','failed','hook','environment'].filter(term=>messages.some(m=>m.toLowerCase().includes(term.toLowerCase())));try{report.connectionRecords=(await readdir(join(data,'workspace/connections/claude-code'))).filter(p=>p.endsWith('.json')).length;}catch{report.connectionRecords=0;}}
finally{report.toolCalls=toolCalls;report.permissionDenials=results.flatMap(r=>(r.permission_denials||[]).map(d=>({tool:d.tool_name,helper:d.tool_input?.command?.includes(runner)||false,quotedExecutable:d.tool_input?.command?.startsWith("'")||false})));try{report.stagedRequests=(await readdir(join(data,'workspace/connections/claude-code/requests'))).length;}catch{report.stagedRequests=0;}clearTimeout(timer);if(child?.pid){try{process.kill(-child.pid,'SIGTERM');}catch{}}await new Promise(r=>setTimeout(r,300));await rm(base,{recursive:true,force:true});}
report.streamError=streamError??null;report.stderrBytes=stderrBytes;console.log(JSON.stringify(report,null,2));if(!report.passed)process.exitCode=1;
