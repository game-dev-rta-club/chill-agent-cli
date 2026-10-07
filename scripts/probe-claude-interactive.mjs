#!/usr/bin/env node
// Run only in a terminal. Native onboarding and trust remain interactive.
import {spawn,execFile} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseArgs,promisify} from 'node:util';
import {authNames,probeAuthSettings} from './claude-probe-auth.mjs';

const {values}=parseArgs({options:{run:{type:'boolean'},channel:{type:'boolean'},claude:{type:'string',default:'claude'},'auth-settings':{type:'string'},report:{type:'string'},help:{type:'boolean'}}});
if(values.help||!values.run){console.log('Usage: node scripts/probe-claude-interactive.mjs --run --report /path/to/report.json [--channel] [--claude /path/to/claude] [--auth-settings /path/to/native-settings.json]\nUses a disposable interactive terminal and native permissions. After READY, submit: Start the probe now. The producer adds synthetic Web feedback after the response ends. Exit with /exit after COMPLETE (twice with --channel). --channel opts a local test MCP server into native development-channel consent, without permission relay or an idle watcher. Five-minute wall-time limit; interactive Claude does not support a dollar budget. No production data or normal settings are changed.');process.exit(0);}
if(!process.stdin.isTTY||!process.stdout.isTTY||!values.report)throw Error('Use an interactive terminal and an explicit report path.');
const base=await mkdtemp(join(tmpdir(),'chill-claude-interactive-')),cwd=join(base,'project'),config=join(base,'config'),data=join(base,'data');
const entry=new URL('../bin/chill-connection.mjs',import.meta.url).pathname,store=new URL('../lib/goal-store.mjs',import.meta.url).href;
const hook=join(base,'hook.mjs'),watcher=join(base,'watcher.mjs'),runner=join(base,'runner.mjs'),trace=join(base,'trace.jsonl'),settings=join(base,'settings.json');
const memory=randomUUID(),tokens=[randomUUID(),randomUUID()],report={checkedAt:new Date().toISOString(),transport:values.channel?'channel-fixture':'finite-stop-watcher',scope:'Disposable interactive terminal with context before Goal creation; hooks configured at launch, not hot-installed into a user session.'};
const channelDir=join(base,'channel'),channelFixture=new URL('./fixtures/claude-channel.mjs',import.meta.url).pathname;
const env={};for(const key of ['PATH','HOME','TMPDIR','USER','LOGNAME','SHELL','LANG','LC_ALL','TERM','COLORTERM',...(values['auth-settings']?[]:authNames)])if(process.env[key]!==undefined)env[key]=process.env[key];
Object.assign(env,{CLAUDE_CONFIG_DIR:config,CHILL_AGENT_DATA_DIR:data,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL:'1'});
const execute=promisify(execFile),q=s=>`'${s.replaceAll("'","'\\''")}'`,call=a=>`${q(process.execPath)} ${q(runner)} ${a}`;
let child,deadline,poll,injecting=false,timedOut=false,pollError=false,exit;
const feedbackTimes=[],stopTimes=[],rounds=values.channel?2:1;
async function events(){try{return (await readFile(trace,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch{return [];}}
try {
 const auth=values['auth-settings']?await probeAuthSettings(values['auth-settings']):null;if(auth)Object.assign(env,auth.env);
 await mkdir(cwd);await mkdir(config);await mkdir(channelDir);
 await writeFile(runner,`import {execFileSync} from 'node:child_process';\nconst action=process.argv[2],event=process.argv[3]||'1';if(!['1','2'].includes(event))throw Error('Invalid test event');const args=action==='create'?['create-goal','--title','Disposable interactive probe']:['working','completed'].includes(action)?['activity','--event',event,'--state',action]:null;\nif(!args)throw Error('Unknown probe action');\nprocess.stdout.write(execFileSync(process.execPath,[${JSON.stringify(entry)},...args],{encoding:'utf8',timeout:10000}));\n`);
 await writeFile(hook,`import {execFileSync} from 'node:child_process';import {appendFileSync} from 'node:fs';\nconst chunks=[];for await(const c of process.stdin)chunks.push(c);const raw=Buffer.concat(chunks).toString(),input=JSON.parse(raw);let out='',failed=false;\ntry{out=execFileSync(process.execPath,[${JSON.stringify(entry)},'claude-hook'],{input:raw,encoding:'utf8',timeout:10000});}catch{failed=true;}\nappendFileSync(${JSON.stringify(trace)},JSON.stringify({at:Date.now(),event:input.hook_event_name,sessionId:input.session_id,promptId:input.prompt_id||null,main:input.agent_id==null,context:!!out,failed,transcript:input.transcript_path||null})+'\\n',{mode:0o600});\nif(failed)process.exitCode=1;else process.stdout.write(out);\n`);
 await writeFile(watcher,`import {spawn} from 'node:child_process';import {appendFile} from 'node:fs/promises';\nconst chunks=[];for await(const c of process.stdin)chunks.push(c);const raw=Buffer.concat(chunks).toString(),input=JSON.parse(raw);\nconst child=spawn(process.execPath,[${JSON.stringify(entry)},'claude-watch','--timeout-ms','30000'],{stdio:['pipe','ignore','pipe']});let output='';child.stderr.on('data',c=>{output+=c;});child.stdin.end(raw);const code=await new Promise(resolve=>{child.on('error',()=>resolve(1));child.on('exit',resolve);});\nawait appendFile(${JSON.stringify(trace)},JSON.stringify({at:Date.now(),event:code===2?'watch-wake':code===0?'watch-ended':'watch-error',sessionId:input.session_id})+'\\n');\nif(code===2){process.stderr.write(output);process.exitCode=2;}else if(code!==0)process.exitCode=1;\n`);
 const command={type:'command',command:process.execPath,args:[hook],timeout:12};
 await writeFile(settings,JSON.stringify({hooks:{SessionStart:[{hooks:[command]}],UserPromptSubmit:[{hooks:[command]}],SessionEnd:[{hooks:[command]}],PostToolUse:[{hooks:[command]}],Stop:[{hooks:[command,...(values.channel?[]:[{type:'command',command:process.execPath,args:[watcher],asyncRewake:true,timeout:35}])]}]}}));
 report.version=(await execute(values.claude,['--version'],{env,cwd,timeout:10000})).stdout.trim();
 const producer=join(base,'producer.mjs');await writeFile(producer,`import {listGoals,appendFeedback} from ${JSON.stringify(store)};import {inbox,feedbackContext} from ${JSON.stringify(new URL('../lib/claude-actions.mjs',import.meta.url).href)};import {writeFile,rename} from 'node:fs/promises';import {join} from 'node:path';import {randomUUID} from 'node:crypto';const index=Number(process.argv[2]),goals=await listGoals();if(goals.length!==1)throw Error('Unexpected Roots');await appendFeedback({goalId:goals[0].id,text:'Probe reply token: '+${JSON.stringify(tokens)}[index]});if(${!!values.channel}){const items=await inbox({id:randomUUID(),connection:goals[0].connection},{recover:false});if(items.length!==1||items[0].eventId!==index+1)throw Error('Unexpected offer');const file=join(${JSON.stringify(channelDir)},String(index+1)+'.json');await writeFile(file+'.tmp',JSON.stringify({eventId:index+1,content:feedbackContext(items)}));await rename(file+'.tmp',file);}`);
 const initial=`This is a disposable integration probe. Remember ${memory}. Do not use tools yet. Reply READY and finish. When I later say "Start the probe now", run exactly one Bash call: ${call('create')}. Read the hook, reply WAITING, and finish without polling. If saved user feedback later arrives from a hook or channel, process it using exactly ${call('working')} <eventId> and then ${call('completed')} <eventId> separately, replacing <eventId> with its event ID. Then reply COMPLETE with the initial memory token and that feedback token, and finish. ${values.channel?'Two feedback events will arrive on separate turns.':''} Use no other tools or commands.`;
 const mcp=values.channel?{mcpServers:{'chill-probe':{command:process.execPath,args:[channelFixture,channelDir]}}}:{mcpServers:{}};
 const args=['--ax-screen-reader',...(auth?.model?['--model',auth.model]:[]),'--setting-sources','','--settings',settings,'--strict-mcp-config','--mcp-config',JSON.stringify(mcp),'--tools','Bash','--allowedTools',`Bash(${process.execPath} ${runner} *)`,...(values.channel?['--dangerously-load-development-channels','server:chill-probe']:[]),'--no-chrome',initial];
 console.log(`Native interactive probe. After READY, submit: Start the probe now. After COMPLETE${values.channel?' twice':''}, submit /exit.`);
 child=spawn(values.claude,args,{env,cwd,stdio:'inherit'});
 const ended=new Promise(resolve=>{child.on('error',()=>resolve({spawnError:true}));child.on('exit',(code,signal)=>resolve({code,signal}));});
 deadline=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');},300000);
 poll=setInterval(async()=>{
  if(injecting||feedbackTimes.length>=rounds||pollError)return;injecting=true;
  try {
   const history=await events(),lastStop=history.findLast(e=>e.event==='Stop');
   const tool=history.find(e=>e.event==='PostToolUse'&&e.context&&!e.failed);
   if(!lastStop||!tool||lastStop.at<=tool.at)return;
   const index=feedbackTimes.length;
   if(index>0){const previous=JSON.parse(await readFile(join(data,'workspace/deliveries',`${index}.json`),'utf8'));if(previous.status!=='completed'||lastStop.at<=feedbackTimes[index-1])return;}
   if(Date.now()-lastStop.at<1500)return;
   stopTimes.push(lastStop.at);feedbackTimes.push(Date.now());await execute(process.execPath,[producer,String(index)],{env,cwd,timeout:10000});
  }catch{pollError=true;}finally{injecting=false;}
 },250);
 exit=await ended;clearInterval(poll);
 // Hooks may still be finishing their final writes.
 await new Promise(r=>setTimeout(r,300));
 const history=await events(),start=history.find(e=>e.event==='SessionStart');
 const transcript=start?.transcript?await readFile(start.transcript,'utf8'):'';
 const messages=transcript.split('\n').filter(Boolean).map(JSON.parse);
 const assistants=messages.filter(m=>m.type==='assistant').map(m=>(m.message?.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n'));
 const users=messages.filter(m=>m.type==='user'&&typeof m.message?.content==='string').map(m=>m.message.content);
 const goal=JSON.parse(await readFile(join(data,'workspace/goals/1/goal.json'),'utf8')),deliveries=await Promise.all(Array.from({length:rounds},async(_,i)=>JSON.parse(await readFile(join(data,'workspace/deliveries',`${i+1}.json`),'utf8'))));
 const prompts=history.filter(e=>e.event==='UserPromptSubmit'),tools=history.filter(e=>e.event==='PostToolUse'),wake=history.find(e=>e.event==='watch-wake');
 report.checks={nativeSuccess:exit.code===0&&!timedOut&&!pollError,priorConversation:assistants.some(t=>t.trim()==='READY')&&prompts.length===rounds+2,manualStartOnce:users.filter(t=>t.trim()==='Start the probe now').length===1,afterEachResponse:feedbackTimes.length===rounds&&feedbackTimes.every((at,i)=>at>stopTimes[i]),sameNativeSession:history.every(e=>e.sessionId===goal.connection.sessionId),newNativePrompt:new Set(tools.map(e=>e.promptId)).size===rounds+1,receiptsCompleted:deliveries.every(d=>d.status==='completed'&&d.agentReported===true),priorContextRetained:tokens.slice(0,rounds).every(token=>assistants.some(t=>t.includes('COMPLETE')&&t.includes(memory)&&t.includes(token))),mainHooks:history.filter(e=>e.main!==undefined).every(e=>e.main&&!e.failed),sessionEnded:history.some(e=>e.event==='SessionEnd'&&!e.failed)};
 if(values.channel){report.channel=(await readFile(join(channelDir,'trace.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);report.checks.singleChannelProcess=report.channel.filter(e=>e.event==='start').length===1;report.checks.twoChannelWrites=report.channel.filter(e=>e.event==='write').length===2;report.checks.noStopWatcher=!history.some(e=>e.event.startsWith('watch-'));}
 else {report.checks.oneWake=history.filter(e=>e.event==='watch-wake').length===1;report.checks.wakeAfterFeedback=wake?.at>feedbackTimes[0];}
 report.hooks=history.map(({transcript,...e})=>e);report.passed=Object.values(report.checks).every(Boolean);
}catch{report.passed=false;report.failure='Interactive probe did not establish all required evidence; raw native output withheld.';report.hooks=(await events()).map(({transcript,...e})=>e);if(values.channel){try{report.channel=(await readFile(join(channelDir,'trace.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch{}}}
finally{clearTimeout(deadline);clearInterval(poll);if(child?.pid&&child.exitCode==null){child.kill('SIGTERM');await new Promise(r=>setTimeout(r,500));}await rm(base,{recursive:true,force:true});}
report.timedOut=timedOut;report.nativeExit=exit??null;await writeFile(values.report,JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(`\nInteractive probe ${report.passed?'passed':'failed'}. Report: ${values.report}`);if(!report.passed)process.exitCode=1;
