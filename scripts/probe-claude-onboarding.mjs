#!/usr/bin/env node
// Opt-in interactive qualification: earlier chat -> explicit setup -> same-chat
// resume -> packaged skill -> native permissions -> idle feedback and receipts.
import {spawn,execFile} from 'node:child_process';
import {mkdtemp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {parseArgs,promisify} from 'node:util';
import {authNames,probeAuthSettings} from './claude-probe-auth.mjs';
import {returnedDocument} from './claude-probe-evidence.mjs';
const {values}=parseArgs({options:{run:{type:'boolean'},plugin:{type:'string'},claude:{type:'string',default:'claude'},'auth-settings':{type:'string'},report:{type:'string'},help:{type:'boolean'}}});
if(values.help||!values.run){console.log('Usage: node scripts/probe-claude-onboarding.mjs --run --plugin /path/to/native/plugin --report /path/to/report.json [--claude /path/to/claude] [--auth-settings /path/to/native-settings.json]\nDisposable native interactive session, default permissions and no tool pre-grants. After READY, submit /exit. The probe installs project hooks and resumes the same chat with its real Skill. Complete native permission prompts for the stated test only. After COMPLETE, submit /exit again. Eight-minute wall deadline; native interactive mode has no dollar budget. Normal settings, production Goals and permission policy remain untouched.');process.exit(0);}
if(!process.stdin.isTTY||!process.stdout.isTTY||!values.plugin||!values.report)throw Error('Use a terminal, built native plugin and explicit report path.');
const plugin=resolve(values.plugin),base=await mkdtemp(join(tmpdir(),'chill-native-onboarding-')),cwd=join(base,'project'),config=join(base,'config'),data=join(base,'data');
const sessionId=randomUUID(),memory=randomUUID(),feedbackToken=randomUUID(),trace=join(base,'hook-trace.jsonl'),observer=join(base,'observer.mjs');
const execute=promisify(execFile),q=s=>`'${s.replaceAll("'","'\\''")}'`;
const env={};for(const k of ['PATH','HOME','TMPDIR','USER','LOGNAME','SHELL','LANG','LC_ALL','TERM','COLORTERM',...(values['auth-settings']?[]:authNames)])if(process.env[k]!==undefined)env[k]=process.env[k];
Object.assign(env,{CLAUDE_CONFIG_DIR:config,CHILL_AGENT_DATA_DIR:data,CHILL_AGENT_CODEX_PATH:'/never/call/codex',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL:'1'});
const report={checkedAt:new Date().toISOString(),scope:'Disposable interactive conversation; explicit project setup between native exit and same-session resume. Real packaged Skill and native default permission prompts. Not hot-installation or overnight reception.'};
let child,deadline,poll,timedOut=false,injecting=false,pollFailure=false,feedbackAt=null,phase='prepare';
const text=m=>typeof m.message?.content==='string'?m.message.content:(m.message?.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');
async function findTranscript(dir){for(const e of await readdir(dir,{withFileTypes:true})){const path=join(dir,e.name);if(e.isFile()&&e.name===sessionId+'.jsonl')return path;if(e.isDirectory()){const found=await findTranscript(path);if(found)return found;}}}
async function transcript(){const path=await findTranscript(join(config,'projects'));if(!path)throw Error('No native transcript');return (await readFile(path,'utf8')).split('\n').filter(Boolean).map(JSON.parse);}
async function hooks(){try{return (await readFile(trace,'utf8')).split('\n').filter(Boolean).map(JSON.parse);}catch{return [];}}
async function native(args){child=spawn(values.claude,args,{env,cwd,stdio:'inherit'});return new Promise(resolve=>{child.on('error',()=>resolve({spawnError:true}));child.on('exit',(code,signal)=>resolve({code,signal}));});}
try{
 const auth=values['auth-settings']?await probeAuthSettings(values['auth-settings']):null;if(auth)Object.assign(env,auth.env);
 await mkdir(cwd);await mkdir(config);
 report.version=(await execute(values.claude,['--version'],{env,cwd,timeout:10000})).stdout.trim();
 const common=['--ax-screen-reader',...(auth?.model?['--model',auth.model]:[]),'--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--no-chrome','--permission-mode','default'];
 deadline=setTimeout(()=>{timedOut=true;child?.kill('SIGTERM');},480000);
 phase='earlier-conversation';console.log('Phase 1: complete native onboarding. After READY, submit /exit. No tools or chill hooks are installed yet.');
 report.firstExit=await native([...common,'--session-id',sessionId,'--setting-sources','','--tools','','--no-chrome',`Remember this private test token for our later conversation: ${memory}. Do not use tools. Reply exactly READY and finish.`]);
 const earlier=await transcript();report.earlierReady=earlier.some(m=>m.type==='assistant'&&text(m).trim()==='READY');
 if(report.firstExit.code!==0||!report.earlierReady||timedOut)throw Error('Earlier conversation failed');
 phase='setup';
 await writeFile(observer,`import {appendFile} from 'node:fs/promises';const parts=[];for await(const c of process.stdin)parts.push(c);const e=JSON.parse(Buffer.concat(parts).toString());await appendFile(${JSON.stringify(trace)},JSON.stringify({at:Date.now(),event:e.hook_event_name,sessionId:e.session_id,promptId:e.prompt_id||null,main:e.agent_id==null,tool:e.tool_name||null,permissionMode:e.permission_mode||null})+'\\n',{mode:0o600});`);
 const group={hooks:[{type:'command',command:`${q(process.execPath)} ${q(observer)}`,timeout:10}]};
 await mkdir(join(cwd,'.claude'));await writeFile(join(cwd,'.claude/settings.local.json'),JSON.stringify({spinnerTipsEnabled:false,hooks:Object.fromEntries(['SessionStart','UserPromptSubmit','PermissionRequest','PostToolUse','Stop','SessionEnd'].map(e=>[e,[group]]))}));
 const setup=JSON.parse((await execute(process.execPath,[join(plugin,'bin/chill-setup.mjs'),'prepare','--harness','claude-code','--project',cwd,'--idle-watch-ms','60000'],{env,cwd,timeout:30000,maxBuffer:1024*1024})).stdout);
 report.setupConfigured=setup.hook.configured;if(!report.setupConfigured)throw Error('Setup unconfirmed');
 const producer=join(base,'feedback.mjs');await writeFile(producer,`import {appendFeedback} from ${JSON.stringify(new URL('../lib/goal-store.mjs',import.meta.url).href)};await appendFeedback({goalId:'1',text:${JSON.stringify('Test reply token: '+feedbackToken+'. Record working and completed receipts using the native connection. Then reply COMPLETE with the memory token from our earlier conversation and this reply token. Finish without new Goals, work or settings.')}});`);
 poll=setInterval(async()=>{if(injecting||feedbackAt||pollFailure)return;injecting=true;try{
  let goal;try{goal=JSON.parse(await readFile(join(data,'workspace/goals/1/goal.json'),'utf8'));}catch{return;}
  const history=await hooks(),lastStop=history.findLast(e=>e.event==='Stop');
  if(goal.connection?.sessionId!==sessionId||!lastStop||!history.some(e=>e.event==='PostToolUse'&&e.at<lastStop.at)||Date.now()-lastStop.at<1500)return;
  feedbackAt=Date.now();await execute(process.execPath,[producer],{env,cwd,timeout:10000});
 }catch{pollFailure=true;}finally{injecting=false;}},250);
 phase='resume';console.log('\nPhase 2: hooks prepared. Resuming the original conversation with the plugin and default native permissions. After COMPLETE, submit /exit.');
 const prompt=`Use the chill-agent skill to record this agreed outcome in this original Claude conversation: a one-page draft that a reviewer can read without staying at the screen. Scope for this test is only to create one Root with a concrete criterion, then reply WAITING and finish. Do not write a draft, create children, start Web, change settings, enable Auto mode or contact anyone. Project hooks were explicitly prepared after our earlier conversation; the stable command prefix is ${setup.command}. Use the native connection and its main-hook confirmation. When saved Web feedback arrives later, handle it using the native connection and its receipts, then follow that feedback's instructions. Keep our earlier conversation context.`;
 report.secondExit=await native([...common,'--resume',sessionId,'--setting-sources','local','--plugin-dir',plugin,'--tools','Bash,Read,Skill','--no-chrome',prompt]);
 clearInterval(poll);while(injecting)await new Promise(r=>setTimeout(r,100));
 phase='verify';await new Promise(r=>setTimeout(r,300));
 const history=await hooks(),messages=await transcript(),goalIds=await readdir(join(data,'workspace/goals'));
 const goal=JSON.parse(await readFile(join(data,'workspace/goals/1/goal.json'),'utf8')),delivery=JSON.parse(await readFile(join(data,'workspace/deliveries/1.json'),'utf8'));
 const recordFiles=(await readdir(join(data,'workspace/connections/claude-code'))).filter(f=>f.endsWith('.json'));
 const record=JSON.parse(await readFile(join(data,'workspace/connections/claude-code',recordFiles[0]),'utf8'));
 const settings=JSON.parse(await readFile(join(cwd,'.claude/settings.local.json'),'utf8'));
 const toolUses=messages.flatMap(m=>Array.isArray(m.message?.content)?m.message.content.filter(c=>c.type==='tool_use'):[]);
 const nativeGuide=await readFile(join(plugin,'skills/chill-agent/references/workspace/claude-code.md'),'utf8');
 let enabled=false;try{enabled=JSON.parse(await readFile(join(data,'workspace/continuation/1.json'),'utf8')).enabled===true;}catch{}
 const permissions=history.filter(e=>e.event==='PermissionRequest'),assistants=messages.filter(m=>m.type==='assistant').map(text);
 report.checks={nativeSuccess:report.firstExit.code===0&&report.secondExit.code===0&&!timedOut&&!pollFailure,priorConversation:report.earlierReady,nativeResume:record.source==='resume'&&record.sessionId===sessionId,sameOriginalConversation:goal.connection?.sessionId===sessionId&&history.every(e=>e.sessionId===sessionId),skillInvoked:toolUses.some(t=>t.name==='Skill'&&t.input?.skill==='chill-agent:chill-agent'),nativeGuideRead:returnedDocument(messages,nativeGuide),stableCommand:toolUses.filter(t=>t.name==='Bash'&&/ connection (show|create-goal|activity)/.test(t.input?.command||'')).every(t=>t.input.command.startsWith(setup.command+' connection ')),nativePermissionRequested:permissions.some(e=>e.tool==='Bash'),defaultPermissions:history.every(e=>e.permissionMode==null||e.permissionMode==='default')&&!settings.permissions,oneNativeRoot:goalIds.length===1&&goal.threadId===null&&goal.connection?.harnessId==='claude-code',criterionRecorded:goal.criteria.trim().length>10,afterResponse:history.some(e=>e.event==='Stop'&&e.at<feedbackAt),receiptCompleted:delivery.status==='completed'&&delivery.agentReported===true,earlierContextRetained:assistants.some(s=>s.includes('COMPLETE')&&s.includes(memory)&&s.includes(feedbackToken)),noCodexOperations:!toolUses.some(t=>t.name==='Bash'&&/goal (assign|work)/.test(t.input?.command||'')),noAutoEnable:!enabled,settingsPreserved:settings.spinnerTipsEnabled===false&&settings.hooks.Stop.length===3,mainHooks:history.every(e=>e.main),sessionEnded:history.some(e=>e.event==='SessionEnd')};
 report.permissionRequests=permissions.map(e=>({tool:e.tool,mode:e.permissionMode}));report.hooks=history;report.passed=Object.values(report.checks).every(Boolean);
}catch(error){report.passed=false;report.failure={phase,code:error.code||null,message:'Probe incomplete; raw native output withheld.'};report.hooks=await hooks();}
finally{clearTimeout(deadline);clearInterval(poll);if(child?.pid&&child.exitCode==null){child.kill('SIGTERM');await new Promise(r=>setTimeout(r,500));}await rm(base,{recursive:true,force:true});}
report.timedOut=timedOut;await writeFile(values.report,JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(`\nOnboarding probe ${report.passed?'passed':'failed'}. Report: ${values.report}`);if(!report.passed)process.exitCode=1;
