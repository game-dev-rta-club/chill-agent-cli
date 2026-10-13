import {existsSync} from 'node:fs';
import {lstat,mkdir,readFile} from 'node:fs/promises';
import {join,win32} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {dataDirectory} from './data-directory.mjs';
import {readJson,writeJsonAtomically,withStoreLock} from './storage.mjs';
import {projectRoot} from './project-root.mjs';

const quote=s=>`'${String(s).replaceAll("'","'\\''")}'`;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const events=['SessionStart','UserPromptSubmit','PostToolUse','Stop','SessionEnd'];
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
 for(const groups of Object.values(config.hooks||{}))if(!Array.isArray(groups)||groups.some(g=>!object(g)||!Array.isArray(g.hooks)))throw Error('Invalid Claude hook groups. Existing settings were left unchanged.');
 return {raw,config};
}
// One shell command on every platform; Claude Code runs it in Git Bash on Windows.
export function claudeHookGroups({entry}){
 const command=`${quote(entry)} connection claude-hook`;
 return events.map(event=>({event,group:{...(event==='PostToolUse'?{matcher:'*'}:{}),hooks:[{type:'command',command,timeout:15,statusMessage:'chill-agent: Claude conversation'}]}}));
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
export async function configureClaudeHooks(project,{entry,directory=dataDirectory(),remove=false}={}){
 const p=await paths(project,directory);
 const wanted=remove?[]:claudeHookGroups({entry});
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
  return {...await claudeSetupStatus(p.project,{directory}),changed};
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
