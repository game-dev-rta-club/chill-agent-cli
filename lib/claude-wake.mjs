// A Claude conversation that waits for something outside chill (CI, a build)
// schedules a check. The watcher wakes the conversation at that time, the same
// way saved Web feedback does. A check for a Goal (`goal`) makes it the
// conversation's current Goal when it wakes (agent-messages).
import {dataDirectory} from './data-directory.mjs';
import {claudeEntryPaths,identifyClaudeCaller} from './claude-entry.mjs';
import {readGoalContext} from './goal-store.mjs';
import {readJson,withStoreLock,writeJsonAtomically} from './storage.mjs';

export async function scheduleClaudeWake({minutes,reason='',goal=null,cancel=false,env=process.env,directory=dataDirectory(),now=Date.now}={}){
  if(!cancel&&(!Number.isSafeInteger(minutes)||minutes<1))throw Error('--in must be whole minutes, at least 1.');
  if(typeof reason!=='string')throw Error('--reason must be text.');
  if(goal!=null&&!/^[1-9][0-9]*$/.test(String(goal)))throw Error('--goal must be a Goal ID.');
  const caller=await identifyClaudeCaller({env,directory});
  const location=claudeEntryPaths(directory,caller.identity.sessionId);
  return withStoreLock(location.lock,async()=>{
    const record=await readJson(location.record);
    if(record?.contextId!==caller.contextId)throw Error('This conversation context changed. Schedule the check from the current conversation.');
    if(!cancel&&goal!=null){
      const {root}=await readGoalContext(String(goal)),own=root.connection;
      if(own?.harnessId!==record.harnessId||own?.sessionId!==record.sessionId||own?.contextId!==record.contextId)throw Error('That Goal belongs to another conversation.');
    }
    const next={...record};
    if(cancel)delete next.wake;
    else next.wake={at:new Date(now()+minutes*60000).toISOString(),reason:reason.trim(),...(goal!=null?{goalId:String(goal)}:{}),setAt:new Date(now()).toISOString()};
    await writeJsonAtomically(location.record,next);
    return next.wake?{wake:next.wake,note:'The watcher wakes this conversation at that time.'}:{wake:null};
  });
}
export const wakeDue=(record,now=Date.now())=>Boolean(record?.wake&&Date.parse(record.wake.at)<=now);
