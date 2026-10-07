import {lstat,mkdir,readFile,realpath} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {dataDirectory} from './data-directory.mjs';
import {readJson,writeJsonAtomically,withStoreLock} from './storage.mjs';
import {validateClaudeIdleDuration} from './claude-idle-duration.mjs';

const quote=s=>`'${String(s).replaceAll("'","'\\''")}'`;
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const events=['SessionStart','UserPromptSubmit','PostToolUse','Stop','SessionEnd'];
async function paths(project,directory){
 const root=await realpath(resolve(project)),id=createHash('sha256').update(root).digest('hex');
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
export function claudeHookGroups({launcher,node=process.execPath,directory=dataDirectory(),idleWatchMs=null}){
 if(idleWatchMs!==null)validateClaudeIdleDuration(idleWatchMs);
 const command=`CHILL_AGENT_DATA_DIR=${quote(directory)} ${quote(node)} ${quote(launcher)} connection`;
 const entries=events.map(event=>({event,group:{...(event==='PostToolUse'?{matcher:'*'}:{}),hooks:[{type:'command',command:`${command} claude-hook`,timeout:15,statusMessage:'chill-agent: Claude conversation'}]}}));
 if(idleWatchMs!==null)for(const event of ['Stop','SessionStart'])entries.push({event,group:{...(event==='SessionStart'?{matcher:'resume'}:{}),hooks:[{type:'command',command:`${command} claude-watch --timeout-ms ${idleWatchMs}`,asyncRewake:true,timeout:Math.ceil(idleWatchMs/1000)+5,statusMessage:'chill-agent: Wait for Web feedback'}]}});
 return entries;
}
const looksOwned=group=>group.hooks.some(h=>typeof h.command==='string'&&/ connection claude-(hook|watch)(?: |$)/.test(h.command));

// Only our exact recorded groups are replaced. Native permissions, other hooks
// and disableAllHooks remain user-owned, including when they prevent activation.
export async function configureClaudeHooks(project,{launcher,node=process.execPath,directory=dataDirectory(),idleWatchMs=null,remove=false}={}){
 const p=await paths(project,directory);
 const wanted=remove?[]:claudeHookGroups({launcher,node,directory,idleWatchMs});
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
  await writeJsonAtomically(p.record,{project:p.project,owned:wanted,pending:false,idleWatchMs:remove?null:idleWatchMs,updatedAt:new Date().toISOString()});
  return {...await claudeSetupStatus(p.project,{directory}),changed};
 });
}
export async function claudeSetupStatus(project,{directory=dataDirectory()}={}){
 const p=await paths(project,directory),{config}=await settings(p.path),record=await readJson(p.record),owned=record?.owned||[];
 const count=owned.reduce((n,e)=>n+(config.hooks?.[e.event]||[]).filter(g=>same(g,e.group)).length,0);
 const untracked=Object.entries(config.hooks||{}).some(([event,groups])=>groups.some(g=>looksOwned(g)&&!owned.some(e=>e.event===event&&same(e.group,g))));
 return {harnessId:'claude-code',stage:'experimental',project:p.project,settingsPath:p.path,configured:owned.length>0&&count===owned.length&&!untracked&&!record.pending,
  pending:record?.pending===true,locallyDisabled:config.disableAllHooks===true,conflict:untracked,idleWatchMs:record?.idleWatchMs??null,
  activation:'Not verified by settings inspection. Use the current conversation after native hook review and a SessionStart/resume handshake. Settings never prove a live return path.'};
}
