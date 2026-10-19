// A Claude conversation that waits for something outside chill (CI, a build)
// schedules a check. The reply waiter ends at that time, which wakes the
// conversation the same way saved Web feedback does.
import {dataDirectory} from './data-directory.mjs';
import {claudeEntryPaths,identifyClaudeCaller} from './claude-entry.mjs';
import {readJson,withStoreLock,writeJsonAtomically} from './storage.mjs';

export async function scheduleClaudeWake({minutes,reason='',cancel=false,env=process.env,directory=dataDirectory(),now=Date.now}={}){
  if(!cancel&&(!Number.isSafeInteger(minutes)||minutes<1))throw Error('--in must be whole minutes, at least 1.');
  if(typeof reason!=='string')throw Error('--reason must be text.');
  const caller=await identifyClaudeCaller({env,directory});
  const location=claudeEntryPaths(directory,caller.identity.sessionId);
  return withStoreLock(location.lock,async()=>{
    const record=await readJson(location.record);
    if(record?.contextId!==caller.contextId)throw Error('This conversation context changed. Schedule the check from the current conversation.');
    const next={...record};
    if(cancel)delete next.wake;
    else next.wake={at:new Date(now()+minutes*60000).toISOString(),reason:reason.trim(),setAt:new Date(now()).toISOString()};
    await writeJsonAtomically(location.record,next);
    return next.wake?{wake:next.wake,note:'The reply waiter wakes this conversation at that time. Keep it running as a background task.'}:{wake:null};
  });
}
export const wakeDue=(record,now=Date.now())=>Boolean(record?.wake&&Date.parse(record.wake.at)<=now);
