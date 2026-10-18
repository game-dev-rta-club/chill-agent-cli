// goal work for a Claude conversation: mark the Goal this response works on,
// as a Codex chat selects one for its turn. The selection lasts for the
// current response; the Goal list and Agent menu then show it as Running.
import {dataDirectory} from './data-directory.mjs';
import {claudeEntryPaths,identifyClaudeCaller} from './claude-entry.mjs';
import {recordedWork} from './claude-agent-work.mjs';
import {readGoalContext,updateGoal} from './goal-store.mjs';
import {readJson,withStoreLock,writeJsonAtomically} from './storage.mjs';

const current=(record,connection)=>record?.version===1&&record.sessionId===connection.sessionId&&record.contextId===connection.contextId;
export async function selectClaudeWork(goalId,connection,{stop=false,env=process.env,directory=dataDirectory()}={}) {
  const caller=await identifyClaudeCaller({env,directory});
  if(caller.identity.sessionId!==connection.sessionId||caller.contextId!==connection.contextId)throw Error('Work must come from the Goal’s assigned chat.');
  const {goal}=await readGoalContext(goalId);
  const location=claudeEntryPaths(directory,connection.sessionId);
  if(!stop&&goal.state!=='idle')throw Error('Resolve Waiting or reopen Done by setting the work Goal to idle before starting.');
  return withStoreLock(location.lock,async()=>{
    const record=await readJson(location.record);
    if(!current(record,connection))throw Error('Agent changed. Read the Goal again.');
    if(stop){
      if(record.work?.goalId!==goalId||record.work.stoppedAt)throw Error('This is not the current work Goal.');
      const work={...record.work,stoppedAt:new Date().toISOString()};
      await writeJsonAtomically(location.record,{...record,work});
      return work;
    }
    const running=recordedWork(record);
    if(running.phase!=='working')throw Error('No current unfinished Claude response.');
    await updateGoal(goalId,{started:true});
    const work={goalId,turnId:running.id,selectedAt:new Date().toISOString(),stoppedAt:null};
    await writeJsonAtomically(location.record,{...record,work});
    return work;
  });
}
// The selected Goal while the work that selected it still runs.
export const claudeSelection=(record,agentWork)=>record?.work&&!record.work.stoppedAt&&agentWork?.phase==='working'&&record.work.turnId===agentWork.id?record.work:null;
