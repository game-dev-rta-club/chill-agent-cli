// Every conversation in a project with chill's hooks runs them, including the
// many that never use chill. A conversation that has never owned a Root Goal
// is marked quiet; the shell launcher (runtime-package) then ends each of its
// later hooks before Node starts, as if chill were not installed.
//
// Any doubt keeps the hooks running: no marker, an ID the launcher cannot read,
// or a SessionStart, which always runs and decides again. Owning a Goal is
// decided and changed under the conversation's lock (create-goal and adopt
// clear the marker in it), so an owner is never left quiet.
import {mkdir,rm,stat,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {dataDirectory} from './data-directory.mjs';
import {claudeEntryPaths} from './claude-entry.mjs';
import {listGoals} from './goal-store.mjs';
import {readJson,withStoreLock,writeJsonAtomically} from './storage.mjs';

// The launcher reads the ID with the same pattern; another ID is never quiet.
const quietId=/^[A-Za-z0-9-]{1,128}$/;
export const claudeQuietPath=(directory,sessionId)=>quietId.test(sessionId)?join(directory,'workspace','connections','quiet',sessionId):null;

// Ever owned: as the owner of a Root, archived ones included, or as its earlier
// owner before another conversation took it over.
const everOwned=async sessionId=>(await listGoals({includeArchived:true})).some(goal=>!goal.parentId&&[goal.owner,...(goal.previousOwners||[])].some(o=>o?.agent==='claude-code'&&o.id===sessionId));

// Called with the conversation's lock held. Returns whether it is quiet now.
// Ownership never ends, so a record keeps it and an owner's hooks skip the
// Goal list.
async function decide(directory,path,sessionId) {
  const record=await readJson(claudeEntryPaths(directory,sessionId).record);
  if(record?.owned)return false;
  if(await everOwned(sessionId)){await markOwned(directory,sessionId,record);return false;}
  await mkdir(join(path,'..'),{recursive:true});
  await writeFile(path,'');
  return true;
}

// For every main hook before it is handled: true when the hook has nothing to
// do for this conversation. A SessionStart is still handled, so a conversation
// can start using chill at any time.
export async function quietClaudeHook(input,{directory=dataDirectory()}={}) {
  if(!input||input.agent_id!=null||typeof input.session_id!=='string')return false;
  const path=claudeQuietPath(directory,input.session_id);
  if(!path)return false;
  if(input.hook_event_name!=='SessionStart'&&await stat(path).then(()=>true,()=>false))return true;
  const quiet=await withStoreLock(claudeEntryPaths(directory,input.session_id).lock,()=>decide(directory,path,input.session_id));
  return input.hook_event_name!=='SessionStart'&&quiet;
}

async function markOwned(directory,sessionId,record) {
  const path=claudeQuietPath(directory,sessionId);
  if(path)await rm(path,{force:true});
  if(record&&!record.owned)await writeJsonAtomically(claudeEntryPaths(directory,sessionId).record,{...record,owned:true});
}
// The conversation owns a Goal from now on (create-goal, adopt); the caller
// holds its lock.
export async function ownClaudeHooks(sessionId,{directory=dataDirectory()}={}) {
  await markOwned(directory,sessionId,await readJson(claudeEntryPaths(directory,sessionId).record));
}
