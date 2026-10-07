#!/usr/bin/env node
// Opt-in native plugin exercise. Only disposable settings, conversation and Goals.
import {spawn,execFile} from 'node:child_process';
import {mkdtemp,mkdir,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative} from 'node:path';
import {parseArgs,promisify} from 'node:util';
import {authNames,probeAuthSettings} from './claude-probe-auth.mjs';
const {values}=parseArgs({options:{run:{type:'boolean'},plugin:{type:'string'},claude:{type:'string',default:'claude'},'auth-settings':{type:'string'},help:{type:'boolean'}}});
if(values.help||!values.run){console.log('Usage: node scripts/probe-claude-plugin.mjs --run --plugin /path/to/dist/claude/chill-agent [--claude /path/to/claude] [--auth-settings /path/to/native-settings.json]\nLoads the real native plugin in an isolated print-mode conversation. Prepares only disposable hooks, asks the skill to create one Root and report there, and inspects persisted results. $0.80 budget, 180-second conversation limit. No ordinary settings, production data or permission modes are changed.');process.exit(0);}
if(!values.plugin)throw Error('A built native plugin is required.');
const plugin=resolve(values.plugin),base=await mkdtemp(join(tmpdir(),'chill-native-plugin-')),cwd=join(base,'project'),data=join(base,'data'),config=join(base,'config');
const report={checkedAt:new Date().toISOString(),scope:'Native plugin discovery and shared skill routing in a disposable print-mode conversation; not a production install, cold-start permission UX or indefinite idle test.'};
const env={};for(const k of ['PATH','HOME','TMPDIR','USER','LOGNAME','SHELL','LANG','LC_ALL',...(values['auth-settings']?[]:authNames)])if(process.env[k]!==undefined)env[k]=process.env[k];
Object.assign(env,{CLAUDE_CONFIG_DIR:config,CHILL_AGENT_DATA_DIR:data,CHILL_AGENT_CODEX_PATH:'/never/call/codex',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL:'1'});
const execute=promisify(execFile),calls=[],results=[],reads=[],skills=[],discovered=[],readEvidence=[],toolNames=new Set(),toolsById=new Map(),guideBodies=[];let child,timer,phase='prepare',stream='',stderrBytes=0,exit;
const safeCommand=command=>({usesPreparedLauncher:typeof command==='string'&&command.includes(join(data,'runtime/chill.mjs')),action:['connection create-goal','goal create','goal assign','goal work','goal comment','connection show','setup prepare','server start'].find(a=>command?.includes(a))||null});
try{
 const auth=values['auth-settings']?await probeAuthSettings(values['auth-settings']):null;if(auth)Object.assign(env,auth.env);
 await mkdir(cwd);await mkdir(config);
 for(const file of ['workspace/connect.md','workspace/claude-code.md','goals/create.md','comments/report.md'])guideBodies.push({path:'skills/chill-agent/references/'+file,body:await readFile(join(plugin,'skills/chill-agent/references',file),'utf8')});
 report.version=(await execute(values.claude,['--version'],{env,cwd,timeout:10000})).stdout.trim();
 const prepared=JSON.parse((await execute(process.execPath,[join(plugin,'bin/chill-setup.mjs'),'prepare','--harness','claude-code','--project',cwd],{env,cwd,timeout:15000,maxBuffer:1024*1024})).stdout);
 const prefix=prepared.command;
 const prompt=`Use the chill-agent skill to record this agreed outcome in this Claude conversation: a one-page draft that a reviewer can read without staying at the screen. The current scope is only to create its Root Goal with a concrete criterion and leave one short Comment explaining that drafting is a later step. Do not create the draft or child Goals. Native project hooks are already prepared; the stable command prefix is ${prefix}. Keep the current conversation. Do not start a server, enable Auto mode, change settings, or contact anyone. When the Root and Comment are saved, finish.`;
 const entry=prepared.launcher,q=s=>`'${s.replaceAll("'","'\\''")}'`;
 const allowed=['Skill(chill-agent:chill-agent)',`Read(${plugin}/**)`,`Bash(${prefix} *)`,`Bash(${process.execPath} ${entry} *)`,`Bash(${q(process.execPath)} ${q(entry)} *)`,`Bash(node ${q(entry)} *)`];
 phase='conversation';child=spawn(values.claude,['--print','--verbose','--output-format','stream-json','--max-budget-usd','0.80',...(auth?.model?['--model',auth.model]:[]),'--no-session-persistence','--setting-sources','local','--plugin-dir',plugin,'--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--tools','Bash,Read,Skill','--allowedTools',...allowed,'--no-chrome',prompt],{env,cwd,stdio:['ignore','pipe','pipe'],detached:true});
 const ended=new Promise(r=>{child.on('error',()=>r({spawnError:true}));child.on('exit',(code,signal)=>r({code,signal}));});
 child.stderr.on('data',c=>stderrBytes+=c.length);
 child.stdout.on('data',chunk=>{stream+=chunk.toString();if(stream.length>2*1024*1024){child.kill();return;}let i;while((i=stream.indexOf('\n'))>=0){const line=stream.slice(0,i);stream=stream.slice(i+1);if(!line.trim())continue;let m;try{m=JSON.parse(line);}catch{continue;}
  if(m.type==='result')results.push(m);
  if(m.type==='system'&&m.subtype==='init')discovered.push(...(m.slash_commands||[]).filter(x=>typeof x==='string'&&x.includes('chill-agent')));
  for(const c of m.message?.content||[])if(c.type==='tool_result'&&!c.is_error){
   const returned=typeof c.content==='string'?c.content:(c.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');
   for(const guide of guideBodies)if(returned.includes(guide.body.trim())){reads.push(guide.path);readEvidence.push({path:guide.path,tool:toolsById.get(c.tool_use_id)||'unknown',bytesMatched:true,confirmed:true});}
  }
  for(const c of m.message?.content||[])if(c.type==='tool_use'){
   toolNames.add(c.name);toolsById.set(c.id,c.name);
   if(c.name==='Skill')skills.push(c.input?.skill);
   if(c.name==='Bash'){
    calls.push(safeCommand(c.input?.command));

   }
  }
 }});
 timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGTERM');}catch{}},180000);
 exit=await ended;phase='verify';
 const ids=await readdir(join(data,'workspace/goals')),goal=JSON.parse(await readFile(join(data,'workspace/goals',ids[0],'goal.json'),'utf8'));
 const events=join(data,'workspace/events');const feedback=await Promise.all((await readdir(events)).filter(f=>/^\d+\.json$/.test(f)).map(async f=>JSON.parse(await readFile(join(events,f),'utf8'))));
 let continuation=false;try{continuation=JSON.parse(await readFile(join(data,'workspace/continuation',`${goal.id}.json`),'utf8')).enabled===true;}catch{}
 report.goal={title:goal.title,scope:goal.scope,criteria:goal.criteria};report.comments=feedback.filter(e=>e.author==='agent'&&e.type==='comment').map(e=>e.text);
 report.checks={pluginDiscovered:discovered.includes('chill-agent:chill-agent'),skillInvoked:skills.includes('chill-agent:chill-agent'),nativeGuideRead:readEvidence.some(e=>e.path==='skills/chill-agent/references/workspace/claude-code.md'&&e.confirmed),oneRoot:ids.length===1&&!goal.parentId,agreedCriterion:typeof goal.criteria==='string'&&goal.criteria.trim().length>10,nativeOwnership:goal.connection?.harnessId==='claude-code'&&goal.connection.sessionId===results[0]?.session_id&&goal.threadId===null,oneSavedComment:feedback.filter(e=>e.author==='agent'&&e.goalId===goal.id&&e.type==='comment').length===1,noCodexActions:!calls.some(c=>['goal assign','goal work','goal create'].includes(c.action)),autoRemainsOff:!continuation,noServerStarted:!calls.some(c=>c.action==='server start'),nativeSuccess:exit.code===0&&results.length===1&&!results[0].is_error};
 report.passed=Object.values(report.checks).every(Boolean);
}catch(error){report.passed=false;report.failure={phase,code:error.code??null,resource:error.path?relative(base,error.path):null,message:'Raw native output withheld.'};}
finally{clearTimeout(timer);report.discovered=discovered;report.toolNames=[...toolNames];report.readEvidence=readEvidence;report.skills=skills;report.reads=[...new Set(reads)];report.calls=calls;report.nativeResults=results.map(r=>({isError:r.is_error===true,subtype:r.subtype,sessionId:r.session_id,costUSD:r.total_cost_usd,permissionDenials:(r.permission_denials||[]).map(d=>({tool:d.tool_name,...(d.tool_name==='Bash'?safeCommand(d.tool_input?.command):{})}))}));report.stderrBytes=stderrBytes;if(child?.pid)try{process.kill(-child.pid,'SIGTERM');}catch{}await new Promise(r=>setTimeout(r,300));await rm(base,{recursive:true,force:true});}
console.log(JSON.stringify(report,null,2));if(!report.passed)process.exitCode=1;
