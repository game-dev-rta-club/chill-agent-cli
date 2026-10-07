#!/usr/bin/env node
// Qualify native idle wake in a disposable stream-mode process, never a user chat.
import {spawn,execFile} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm,writeFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseArgs,promisify} from 'node:util';
import {authNames,probeAuthSettings} from './claude-probe-auth.mjs';
import {readClaudeConnectionStatus} from '../lib/claude-status.mjs';
import {maxClaudeIdleMs} from '../lib/claude-idle-duration.mjs';
const {values}=parseArgs({options:{run:{type:'boolean'},claude:{type:'string',default:'claude'},'auth-settings':{type:'string'},'feedback-delay-ms':{type:'string',default:'6200'},'watch-ms':{type:'string',default:'30000'},help:{type:'boolean'}}});
if(values.help||!values.run){console.log('Usage: node scripts/probe-claude-idle.mjs --run [--claude /path/to/claude] [--auth-settings /path/to/native-settings.json] [--feedback-delay-ms 660000 --watch-ms 43200000]\nTests one bounded Stop asyncRewake with feedback added after the first response ends. One disposable stream-mode session, $0.75 budget. Default 6.2s delay and 30s watch; explicit delays can qualify a configured watch up to 24 hours (only the actual elapsed wait is measured). Overall deadline is the delay plus 120 seconds. No production data, normal settings, channels or permission modes are changed.');process.exit(0);}
const feedbackDelayMs=Number(values['feedback-delay-ms']),watchMs=Number(values['watch-ms']);
if(!Number.isSafeInteger(feedbackDelayMs)||feedbackDelayMs<6200||!Number.isSafeInteger(watchMs)||watchMs<feedbackDelayMs+10000||watchMs>maxClaudeIdleMs)throw Error('Use a delay >=6200 ms and a watch >=delay+10000 ms, up to 86400000 ms.');
const deadlineMs=feedbackDelayMs+120000;
const base=await mkdtemp(join(tmpdir(),'chill-claude-idle-')),cwd=join(base,'project'),config=join(base,'config'),data=join(base,'data');
const entry=new URL('../bin/chill-connection.mjs',import.meta.url).pathname,store=new URL('../lib/goal-store.mjs',import.meta.url).href;
const hook=join(base,'hook.mjs'),watcher=join(base,'watcher.mjs'),runner=join(base,'runner.mjs'),trace=join(base,'trace.jsonl'),settings=join(base,'settings.json');
const memory=randomUUID(),token=randomUUID(),report={feedbackDelayMs,watchMs,deadlineMs,checkedAt:new Date().toISOString(),scope:'Disposable stream-mode process; not an existing interactive user conversation or production idle adapter.'};
const env={};for(const key of ['PATH','HOME','TMPDIR','USER','LOGNAME','SHELL','LANG','LC_ALL',...(values['auth-settings']?[]:authNames)])if(process.env[key]!==undefined)env[key]=process.env[key];
Object.assign(env,{CLAUDE_CONFIG_DIR:config,CHILL_AGENT_DATA_DIR:data,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL:'1'});
const execute=promisify(execFile),results=[],messages=[];let child,timer,wakeTimer,phase='prepare',exit,lines='',stderrBytes=0,firstResultAt,feedbackAt,streamError,inputCount=0;
try {
 const auth=values['auth-settings']?await probeAuthSettings(values['auth-settings']):null;if(auth)Object.assign(env,auth.env);
 await mkdir(cwd);await mkdir(config);
 await writeFile(runner,`import {execFileSync} from 'node:child_process';
const action=process.argv[2];
const args=action==='create'?['create-goal','--title','Disposable idle probe']:action==='inbox'?['inbox']:['working','completed'].includes(action)?['activity','--event','1','--state',action]:null;
if(!args)throw Error('Unknown probe action');
process.stdout.write(execFileSync(process.execPath,[${JSON.stringify(entry)},...args],{encoding:'utf8',timeout:10000}));\n`);
 await writeFile(hook,`import {execFileSync} from 'node:child_process';import {appendFileSync} from 'node:fs';
const chunks=[];for await(const c of process.stdin)chunks.push(c);const raw=Buffer.concat(chunks).toString(),input=JSON.parse(raw);let out='',failed=false;
try{out=execFileSync(process.execPath,[${JSON.stringify(entry)},'claude-hook'],{input:raw,encoding:'utf8',timeout:10000});}catch{failed=true;}
appendFileSync(${JSON.stringify(trace)},JSON.stringify({at:Date.now(),event:input.hook_event_name,sessionId:input.session_id,promptId:input.prompt_id||null,main:input.agent_id==null,context:!!out,failed})+'\\n',{mode:0o600});
if(failed)process.exitCode=1;else process.stdout.write(out);\n`);
 const q=s=>`'${s.replaceAll("'","'\\''")}'`,call=a=>`${q(process.execPath)} ${q(runner)} ${a}`;
 await writeFile(watcher,`import {spawn} from 'node:child_process';import {appendFile,readFile} from 'node:fs/promises';
const chunks=[];for await(const c of process.stdin)chunks.push(c);const raw=Buffer.concat(chunks).toString(),input=JSON.parse(raw);
// The final response can arm another watch before EOF. Bound that cleanup
// watch to one second; only the first watch qualifies the requested duration.
const previous=(await readFile(${JSON.stringify(trace)},'utf8').catch(e=>{if(e.code==='ENOENT')return '';throw e;})).split('\\n').filter(Boolean).map(JSON.parse);
const timeoutMs=previous.some(e=>e.event==='watch-wake')?1000:${watchMs};
await appendFile(${JSON.stringify(trace)},JSON.stringify({at:Date.now(),event:'watch-start',timeoutMs,sessionId:input.session_id,promptId:input.prompt_id||null})+'\\n');
const child=spawn(process.execPath,[${JSON.stringify(entry)},'claude-watch','--timeout-ms',String(timeoutMs)],{stdio:['pipe','ignore','pipe']});let output='';child.stderr.on('data',c=>{output+=c;});child.stdin.end(raw);const code=await new Promise(resolve=>{child.on('error',()=>resolve(1));child.on('exit',resolve);});
await appendFile(${JSON.stringify(trace)},JSON.stringify({at:Date.now(),event:code===2?'watch-wake':code===0?'watch-ended':'watch-error',sessionId:input.session_id})+'\\n');
if(code===2){process.stderr.write(output);process.exitCode=2;}else if(code!==0)process.exitCode=1;\n`);
 const command={type:'command',command:process.execPath,args:[hook],timeout:12};
 await writeFile(settings,JSON.stringify({hooks:{SessionStart:[{hooks:[command]}],UserPromptSubmit:[{hooks:[command]}],SessionEnd:[{hooks:[command]}],PostToolUse:[{hooks:[command]}],Stop:[{hooks:[command,{type:'command',command:process.execPath,args:[watcher],asyncRewake:true,timeout:Math.ceil(watchMs/1000)+5}]}]}}));
 report.version=(await execute(values.claude,['--version'],{env,cwd,timeout:10000})).stdout.trim();
 phase='conversation';
 const args=['--print','--verbose','--input-format','stream-json','--output-format','stream-json','--max-budget-usd','0.75',...(auth?.model?['--model',auth.model]:[]),'--no-session-persistence','--setting-sources','','--settings',settings,'--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--tools','Bash','--allowedTools',`Bash(${process.execPath} ${runner} *)`,'--no-chrome'];
 child=spawn(values.claude,args,{env,cwd,stdio:['pipe','pipe','pipe'],detached:true});
 const ended=new Promise(resolve=>{child.on('error',()=>resolve({spawnError:true}));child.on('exit',(code,signal)=>resolve({code,signal}));});
 child.stderr.on('data',c=>{stderrBytes+=c.length;});
 let firstResolve,secondResolve;const first=new Promise(r=>firstResolve=r),second=new Promise(r=>secondResolve=r);
 child.stdout.on('data',chunk=>{lines+=chunk.toString();if(lines.length>1024*1024){streamError='oversized-line';child.kill();return;}let index;while((index=lines.indexOf('\n'))>=0){const line=lines.slice(0,index);lines=lines.slice(index+1);if(!line.trim())continue;try{const message=JSON.parse(line);if(message.type==='result'){results.push(message);if(results.length===1){firstResultAt=Date.now();firstResolve(true);}else secondResolve(true);}if(message.type==='assistant'){const text=(message.message?.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');messages.push(text);}}catch{streamError='invalid-stream';}}});
 timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGTERM');}catch{}},deadlineMs);
 child.stdin.on('error',()=>{streamError='stdin-closed';});
 inputCount+=1;child.stdin.write(JSON.stringify({type:'user',message:{role:'user',content:`This is a disposable integration probe. Remember ${memory}. Run exactly one Bash call: ${call('create')}. Read the hook, then reply READY and the memory token and finish. Do not wait or run more tools now. If saved user feedback later arrives from a hook, process it using exactly ${call('working')} and then ${call('completed')} separately, rather than other commands. Then report both the initial memory token and the feedback token, and finish.`}})+'\n');
 const initial=await Promise.race([first,ended.then(()=>false)]);if(!initial)throw Error('First native response unavailable');
 phase='idle-feedback';const waitStartedAt=Date.now();
 while(Date.now()-waitStartedAt<feedbackDelayMs){if(child.exitCode!==null||child.signalCode!==null)throw Error('Native process ended during wait');await new Promise(r=>setTimeout(r,Math.min(1000,feedbackDelayMs-(Date.now()-waitStartedAt))));}
 report.idleWaitMs=Date.now()-firstResultAt;
 const waitingGoal=JSON.parse(await readFile(join(data,'workspace/goals/1/goal.json'),'utf8'));
 report.waiting=await readClaudeConnectionStatus(waitingGoal.connection,{directory:data});
 // A separate process is the Web producer, not a second user prompt to Claude.
 const producer=join(base,'producer.mjs');await writeFile(producer,`import {listGoals,appendFeedback} from ${JSON.stringify(store)};const goals=await listGoals();if(goals.length!==1)throw Error('Unexpected Roots');await appendFeedback({goalId:goals[0].id,text:${JSON.stringify(`Probe reply token: ${token}`)}});console.log(JSON.stringify({sessionId:goals[0].connection.sessionId}));`);
 feedbackAt=Date.now();await execute(process.execPath,[producer],{env,cwd,timeout:10000});
 phase='wake';const woke=await Promise.race([second,ended.then(()=>false),new Promise(r=>{wakeTimer=setTimeout(()=>r(false),40000);})]);
 if(!woke)throw Error('No second response after bounded wake');
 child.stdin.end();exit=await ended;phase='verify';
 const events=(await readFile(trace,'utf8')).trim().split('\n').map(JSON.parse),goal=JSON.parse(await readFile(join(data,'workspace/goals/1/goal.json'),'utf8')),delivery=JSON.parse(await readFile(join(data,'workspace/deliveries/1.json'),'utf8'));
 report.hooks=events;report.nativeResults=results.map(r=>({sessionId:r.session_id,isError:r.is_error===true,subtype:r.subtype,costUSD:r.total_cost_usd}));
 const final=messages.join('\n'),wakeAt=events.find(e=>e.event==='watch-wake')?.at;
 report.checks={requestedWatch:events.find(e=>e.event==='watch-start')?.timeoutMs===watchMs,requestedWaitObserved:report.idleWaitMs>=feedbackDelayMs,oneGoal:(await readdir(join(data,'workspace/goals'))).length===1,oneInitialInput:inputCount===1,responseBeforeFeedback:feedbackAt>firstResultAt,feedbackBeforeWake:wakeAt>feedbackAt,oneWake:events.filter(e=>e.event==='watch-wake').length===1,sameNativeSession:results.length===2&&results.every(r=>r.session_id===goal.connection.sessionId),completedReceipt:delivery.status==='completed'&&delivery.agentReported===true,feedbackRead:final.includes(token),initialContextRetained:messages.slice(1).join('\n').includes(memory),nativeSuccess:results.every(r=>!r.is_error)&&exit.code===0&&!streamError,mainHooks:events.filter(e=>e.main!==undefined).every(e=>e.main&&!e.failed&&e.sessionId===goal.connection.sessionId),newNativePrompt:new Set(events.filter(e=>e.event==='PostToolUse').map(e=>e.promptId)).size===2,sessionEnded:events.some(e=>e.event==='SessionEnd'&&!e.failed)};
 report.sessionEndObserved=report.checks.sessionEnded;delete report.checks.sessionEnded;
 report.ended=await readClaudeConnectionStatus(goal.connection,{directory:data});
 report.checks.watchChecksContinue=report.waiting.state==='watching'&&Date.parse(report.waiting.watchCheckedAt)>firstResultAt+4000;
 // EOF can finish a print-mode process without a SessionEnd callback. Report
 // that observation separately instead of requiring a hook the host did not emit.
 report.checks.exitEvidenceHonest=report.sessionEndObserved?report.ended.state==='ended':['expired','unconfirmed','stopped'].includes(report.ended.state);
 report.passed=Object.values(report.checks).every(Boolean);
}catch(error){report.passed=false;report.failure={phase,code:error.code??null,signal:error.signal??null,message:['First native response unavailable','No second response after bounded wake'].includes(error.message)?error.message:'Probe failed; raw native output withheld.'};try{report.hooks=(await readFile(trace,'utf8')).trim().split('\n').map(JSON.parse);}catch{}report.nativeResults=results.map(r=>({sessionId:r.session_id,isError:r.is_error===true,subtype:r.subtype,costUSD:r.total_cost_usd}));}
finally{clearTimeout(timer);clearTimeout(wakeTimer);if(child?.pid){try{process.kill(-child.pid,'SIGTERM');}catch{}}await new Promise(r=>setTimeout(r,300));await rm(base,{recursive:true,force:true});}
report.streamError=streamError??null;report.stderrBytes=stderrBytes;console.log(JSON.stringify(report,null,2));if(!report.passed)process.exitCode=1;
