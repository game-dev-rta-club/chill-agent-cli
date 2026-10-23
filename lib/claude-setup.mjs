import {existsSync} from 'node:fs';
import {cp,lstat,mkdir,readFile,readdir,rename,rm} from 'node:fs/promises';
import {join,win32} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {dataDirectory} from './data-directory.mjs';
import {readJson,writeJsonAtomically,withStoreLock} from './storage.mjs';
import {projectRoot} from './project-root.mjs';

const quote=s=>`'${String(s).replaceAll("'","'\\''")}'`;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
// StopFailure reports a response that an API error ended, which Stop never sees.
// SubagentStart and SubagentStop mark each subagent's start and end, so the Web
// knows which subagents still run after the response ends (claude-agent-work).
const events=['SessionStart','UserPromptSubmit','PreToolUse','PermissionRequest','PostToolUse','Stop','StopFailure','SessionEnd','SubagentStart','SubagentStop'];
async function paths(project,directory){
 // Claude loads the main checkout's local settings in its linked worktrees too.
 const root=await projectRoot(project),id=createHash('sha256').update(root).digest('hex');
 return {project:root,path:join(root,'.claude/settings.local.json'),record:join(directory,'settings/claude-projects',`${id}.json`),lock:join(tmpdir(),'chill-claude-setup',String(process.getuid?.()??'user'),id)};
}
async function settings(path){
 for(const p of [join(path,'..'),path]){try{if((await lstat(p)).isSymbolicLink())throw Error('Claude local settings must not be a symlink.');}catch(e){if(e.code!=='ENOENT')throw e;}}
 let raw=null;try{raw=await readFile(path,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
 const config=raw===null?{}:JSON.parse(raw);
 if(!object(config)||config.hooks!==undefined&&!object(config.hooks))throw Error('Claude settings must contain an object with valid hooks.');
 if(config.enabledPlugins!==undefined&&!object(config.enabledPlugins))throw Error('Claude settings must contain valid enabledPlugins.');
 for(const groups of Object.values(config.hooks||{}))if(!Array.isArray(groups)||groups.some(g=>!object(g)||!Array.isArray(g.hooks)))throw Error('Invalid Claude hook groups. Existing settings were left unchanged.');
 return {raw,config};
}
// Cache Keep (claude-mods/chill-agent-cache-keep) is a Claude Code mod that
// keeps an idle chill conversation's prompt cache. Claude Code loads a mod from
// the user's skills folder without an install step. chill turns it off for the
// user and on in each project it sets up, so other folders never load it.
export const cacheKeepPlugin='chill-agent-cache-keep@skills-dir';
const cacheKeepSource=fileURLToPath(new URL('../claude-mods/chill-agent-cache-keep',import.meta.url));
export const claudeDirectory=(env=process.env)=>env.CLAUDE_CONFIG_DIR||join(homedir(),'.claude');
export async function placeCacheKeep({claude=claudeDirectory()}={}){
 // Off for the user first: a mod placed before this would load in every folder.
 const path=join(claude,'settings.json');
 let raw=null;try{raw=await readFile(path,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
 const config=raw===null?{}:JSON.parse(raw);
 if(!object(config)||config.enabledPlugins!==undefined&&!object(config.enabledPlugins))throw Error('Claude user settings must contain an object with valid enabledPlugins.');
 if(config.enabledPlugins?.[cacheKeepPlugin]===undefined)await writeJsonAtomically(path,{...config,enabledPlugins:{...config.enabledPlugins,[cacheKeepPlugin]:false}});
 // Claude Code never adopts a dot-prefixed folder, so a half-copied mod is not loaded.
 const skills=join(claude,'skills'),id=randomUUID(),staging=join(skills,`.chill-agent-cache-keep-${id}`),old=join(skills,`.chill-agent-cache-keep-old-${id}`),target=join(skills,'chill-agent-cache-keep');
 await mkdir(skills,{recursive:true});
 try{
  await cp(cacheKeepSource,staging,{recursive:true,filter:source=>!source.endsWith('.test.ts')});
  // Moved aside whole, so a setup running at the same time never deletes inside the folder it placed.
  try{await rename(target,old);}catch(e){if(e.code!=='ENOENT')throw e;}
  // A setup running at the same time may have just placed the same mod.
  try{await rename(staging,target);}catch(e){if(!['EEXIST','ENOTEMPTY','EPERM'].includes(e.code))throw e;}
 }finally{await Promise.all([rm(staging,{recursive:true,force:true}),rm(old,{recursive:true,force:true})]);}
 return target;
}

// The watcher runs in the background from SessionStart and Stop. Claude Code
// wakes the model with its message when it exits 2 (asyncRewake), so the agent
// never starts, reads or restarts it. It ends itself before this timeout.
export const watcherTimeoutSeconds=7*24*3600;
const watcherHook=entry=>({type:'command',command:`${quote(entry)} connection claude-watch`,asyncRewake:true,timeout:watcherTimeoutSeconds,rewakeMessage:'chill-agent watcher:',rewakeSummary:'chill-agent: Web input'});
// One shell command on every platform; Claude Code runs it in Git Bash on Windows.
export function claudeHookGroups({entry}){
 const command=`${quote(entry)} connection claude-hook`;
 // PreToolUse applies a Web pause to every tool (claude-pause) and checks Bash
 // removals Claude Code would stop for (claude-rm-guard). PermissionRequest
 // answers prompts only while Approve all is on (claude-permissions).
 return events.map(event=>({event,group:{...(event==='PostToolUse'?{matcher:'*'}:['PreToolUse','PermissionRequest'].includes(event)?{matcher:'*'}:{}),hooks:[{type:'command',command,timeout:15,statusMessage:'chill-agent: Claude conversation'},...(['SessionStart','Stop'].includes(event)?[watcherHook(entry)]:[])]}}));
}

// Claude Code on Windows runs Bash commands and shell-form hooks in Git Bash:
// CLAUDE_CODE_GIT_BASH_PATH when set, otherwise bin\bash.exe of the Git for
// Windows installation that provides git on PATH.
export function findGitBash({env=process.env,exists=existsSync}={}){
 if(env.CLAUDE_CODE_GIT_BASH_PATH)return exists(env.CLAUDE_CODE_GIT_BASH_PATH)?env.CLAUDE_CODE_GIT_BASH_PATH:null;
 for(const folder of (env.PATH||env.Path||'').split(';').filter(Boolean)){
  if(!exists(win32.join(folder,'git.exe')))continue;
  for(let dir=win32.dirname(folder);win32.dirname(dir)!==dir;dir=win32.dirname(dir))if(exists(win32.join(dir,'bin','bash.exe')))return win32.join(dir,'bin','bash.exe');
 }
 return null;
}

// Earlier Windows setups wrote exec-form hooks; they are still recognized as ours.
const looksOwned=group=>group.hooks.some(h=>typeof h.command==='string'&&(/ connection claude-hook(?: |$)/.test(h.command)||Array.isArray(h.args)&&h.args.slice(-2).join(' ')==='connection claude-hook'));

// Only our exact recorded groups are replaced. Native permissions, other hooks
// and disableAllHooks remain user-owned, including when they prevent activation.
export async function configureClaudeHooks(project,{entry,directory=dataDirectory(),remove=false,claude=claudeDirectory()}={}){
 const p=await paths(project,directory);
 const wanted=remove?[]:claudeHookGroups({entry});
 // A Cache Keep that cannot be placed leaves the hooks setup to go on without it.
 let cacheKeep={enabled:false};
 if(!remove)try{cacheKeep={enabled:true,path:await placeCacheKeep({claude})};}catch(error){cacheKeep={enabled:false,error:error.message};}
 return withStoreLock(p.lock,async()=>{
  const before=await settings(p.path),old=await readJson(p.record),owned=old?.owned||[];
  const hooks={...before.config.hooks};
  for(const [event,groups] of Object.entries(hooks)){
   for(const group of groups)if(looksOwned(group)&&!owned.some(e=>e.event===event&&same(e.group,group)))throw Error('A Claude chill hook is untracked or edited. Review it before preparing again; no hooks were replaced.');
   hooks[event]=groups.filter(group=>!owned.some(e=>e.event===event&&same(e.group,group)));
   if(!hooks[event].length)delete hooks[event];
  }
  for(const {event,group} of wanted)(hooks[event]||=[]).push(group);
  const config={...before.config};if(Object.keys(hooks).length)config.hooks=hooks;else delete config.hooks;
  // On here unless the person set it themselves; removing chill takes back only chill's on.
  const plugins={...config.enabledPlugins};
  if(cacheKeep.enabled&&plugins[cacheKeepPlugin]===undefined)plugins[cacheKeepPlugin]=true;
  if(remove&&plugins[cacheKeepPlugin]===true)delete plugins[cacheKeepPlugin];
  if(Object.keys(plugins).length)config.enabledPlugins=plugins;else delete config.enabledPlugins;
  const changed=!same(config,before.config);
  if(changed){
   // Union ownership first: either side of an interrupted settings write can
   // be reconciled without duplicate hooks. No credential/config backup is kept.
   const union=[...owned];for(const e of wanted)if(!union.some(v=>same(v,e)))union.push(e);
   await writeJsonAtomically(p.record,{project:p.project,owned:union,pending:true});
   await mkdir(join(p.project,'.claude'),{recursive:true});
   if((await settings(p.path)).raw!==before.raw)throw Error('Claude settings changed during setup. Retry after reviewing the current file.');
   await writeJsonAtomically(p.path,config);
  }
  await writeJsonAtomically(p.record,{project:p.project,owned:wanted,pending:false,updatedAt:new Date().toISOString()});
  return {...await claudeSetupStatus(p.project,{directory}),changed,cacheKeep};
 });
}
export async function claudeSetupStatus(project,{directory=dataDirectory()}={}){
 const p=await paths(project,directory),{config}=await settings(p.path),record=await readJson(p.record),owned=record?.owned||[];
 const count=owned.reduce((n,e)=>n+(config.hooks?.[e.event]||[]).filter(g=>same(g,e.group)).length,0);
 const untracked=Object.entries(config.hooks||{}).some(([event,groups])=>groups.some(g=>looksOwned(g)&&!owned.some(e=>e.event===event&&same(e.group,g))));
 return {harnessId:'claude-code',stage:'experimental',project:p.project,settingsPath:p.path,configured:owned.length>0&&count===owned.length&&!untracked&&!record.pending,
  pending:record?.pending===true,locallyDisabled:config.disableAllHooks===true,conflict:untracked,
  activation:'Not verified by settings inspection. Use the current conversation after native hook review and a SessionStart/resume handshake. Settings never prove a live return path.'};
}

// After a version update, bring every project whose hooks setup installed up to
// the new version's hooks (for example a newly handled event), so a teammate
// only pulls and presses Update. Only chill's own recorded groups are replaced;
// a project whose hooks were removed or edited by hand is left alone.
export async function refreshRecordedClaudeHooks({entry,directory=dataDirectory(),claude=claudeDirectory()}={}){
 const folder=join(directory,'settings/claude-projects');
 let names=[];try{names=(await readdir(folder)).filter(n=>n.endsWith('.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
 const results=[];
 for(const name of names){
  const record=await readJson(join(folder,name)).catch(()=>null);
  if(!record?.project||!record.owned?.length||!existsSync(record.project))continue;
  try{const status=await configureClaudeHooks(record.project,{entry,directory,claude});results.push({project:record.project,changed:status.changed,...status.cacheKeep.error&&{cacheKeepError:status.cacheKeep.error}});}
  catch(error){results.push({project:record.project,error:error.message});}
 }
 return results;
}
// Whether this project's chill hooks include the watcher (read-only).
export async function claudeWatcherInstalled(project){
 try{
  const {config}=await settings((await paths(project,dataDirectory())).path);
  return Object.values(config.hooks||{}).some(groups=>groups.some(g=>g.hooks.some(h=>h.asyncRewake===true&&/ connection claude-watch$/.test(h.command||''))));
 }catch{return false;}
}
