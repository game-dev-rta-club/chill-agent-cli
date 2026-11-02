// A Claude conversation that waits for something outside chill (CI, a build)
// schedules a check. Each check is added to the conversation's list (`wakes`,
// in due order); none replaces another. The watcher wakes the conversation for
// one due check at a time, the earliest first, the same way saved Web feedback
// does.
import {dataDirectory} from './data-directory.mjs';
import {claudeEntryPaths,identifyClaudeCaller} from './claude-entry.mjs';
import {readJson,withStoreLock,writeJsonAtomically} from './storage.mjs';

// The checks still to come, earliest first, as agent show lists them.
export const pendingWakes=record=>(Array.isArray(record?.wakes)?record.wakes:[]).map(({at,reason})=>({at,reason:reason||''}));

export async function scheduleClaudeWake({minutes,reason='',env=process.env,directory=dataDirectory(),now=Date.now}={}){
  if(!Number.isSafeInteger(minutes)||minutes<1)throw Error('--in must be whole minutes, at least 1.');
  if(typeof reason!=='string')throw Error('--reason must be text.');
  const caller=await identifyClaudeCaller({env,directory});
  const location=claudeEntryPaths(directory,caller.identity.sessionId);
  return withStoreLock(location.lock,async()=>{
    const record=await readJson(location.record);
    if(record?.contextId!==caller.contextId)throw Error('This conversation context changed. Schedule the check from the current conversation.');
    const wake={at:new Date(now()+minutes*60000).toISOString(),reason:reason.trim(),setAt:new Date(now()).toISOString()};
    // After the checks due at or before it, so equal times keep the order they were scheduled in.
    const wakes=Array.isArray(record.wakes)?[...record.wakes]:[],index=wakes.findIndex(w=>Date.parse(w.at)>Date.parse(wake.at));
    wakes.splice(index<0?wakes.length:index,0,wake);
    const next={...record,wakes};
    await writeJsonAtomically(location.record,next);
    return {wake,wakes:pendingWakes(next),note:'The watcher wakes this conversation for each check when it is due, one at a time.'};
  });
}
// Removes the check due at `at` (as the lists print it), or every check with
// 'all': only the agent knows which it still needs, for example after the user
// lowered its Autonomy.
export async function cancelClaudeWake({at,env=process.env,directory=dataDirectory()}={}){
  if(typeof at!=='string'||!at)throw Error('--cancel needs the time of a check, as agent show prints it, or all.');
  const caller=await identifyClaudeCaller({env,directory});
  const location=claudeEntryPaths(directory,caller.identity.sessionId);
  return withStoreLock(location.lock,async()=>{
    const record=await readJson(location.record);
    if(record?.contextId!==caller.contextId)throw Error('This conversation context changed. Cancel the check from the current conversation.');
    const wakes=Array.isArray(record.wakes)?record.wakes:[];
    const left=at==='all'?[]:wakes.filter(w=>w.at!==at);
    if(left.length===wakes.length&&at!=='all')throw Error(`No check is scheduled at ${at}. Scheduled: ${pendingWakes(record).map(w=>w.at).join(', ')||'none'}.`);
    const next={...record,wakes:left};if(!left.length)delete next.wakes;
    await writeJsonAtomically(location.record,next);
    return {cancelled:wakes.length-left.length,wakes:pendingWakes(next)};
  });
}
// The earliest check, and whether it is due.
export const nextWake=record=>Array.isArray(record?.wakes)?record.wakes[0]??null:null;
export const wakeDue=(record,now=Date.now())=>{const wake=nextWake(record);return Boolean(wake&&Date.parse(wake.at)<=now);};
