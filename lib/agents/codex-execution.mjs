import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {readGoalContext, updateGoal, workspaceDirectory, validThreadId} from '../goal-store.mjs';
import {readJson, writeJsonAtomically, withStoreLock} from '../storage.mjs';
import {withCodex, verifyThread} from '../codex-client.mjs';
import {recordAgentHeartbeat} from './codex-observation.mjs';
export {heartbeatTTL} from './codex-observation.mjs';

// A selection belongs to exactly one chat AND turn. Neither updating Deliverable
// nor receiving feedback silently changes what that agent is working on.
const path=threadId=>join(workspaceDirectory(),'executions',`${validThreadId(threadId)}.json`);
const locked=(threadId,run)=>withStoreLock(join(workspaceDirectory(),'locks',`execution-${validThreadId(threadId)}`),run);
export const readExecution=threadId=>readJson(path(threadId));
export async function assignGoal(id,threadId) {
  const {goal}=await readGoalContext(id);
  if(goal.parentId) throw new Error('Assign a chat to the root Goal only.');
  if(goal.connection) throw new Error('This Goal belongs to a native conversation. Reassignment is not supported.');
  if(threadId!==null) await verifyThread(validThreadId(threadId));
  // Already queued feedback retains its recipient; assignment never replays it.
  return updateGoal(id,{threadId});
}
export async function selectWork(id,{stop=false,threadId}={}) {
  validThreadId(threadId);
  const {goal,root}=await readGoalContext(id);
  if(root.threadId!==threadId) throw new Error('Work must come from the Goal’s assigned chat.');
  if(stop) return locked(threadId,async()=>{
    const old=await readExecution(threadId);
    if(!old||old.goalId!==id) throw new Error('This is not the current work Goal.');
    const next={...old,stoppedAt:new Date().toISOString()};
    await writeJsonAtomically(path(threadId),next); return next;
  });
  if(goal.state!=='idle') throw new Error('Resolve Waiting or reopen Done by setting the work Goal to idle before starting.');
  const turn=await withCodex(async client=>{
    const result=await client.request('thread/turns/list',{threadId,limit:1,itemsView:'notLoaded'});
    const latest=result.data[0];
    if(!latest||latest.completedAt!=null||!['inProgress','interrupted'].includes(latest.status)) throw new Error('No current unfinished Codex turn.');
    return latest;
  });
  return locked(threadId,async()=>{
    const latest=await readGoalContext(id);
    if(latest.root.threadId!==threadId||latest.root.id!==root.id||latest.goal.state!=='idle') throw new Error('Goal assignment or state changed. Read it again.');
    await updateGoal(id,{started:true});
    const now=new Date().toISOString();
    const next={id:randomUUID(),rootId:root.id,goalId:id,threadId,turnId:turn.id,selectedAt:now,heartbeatAt:now,stoppedAt:null};
    await writeJsonAtomically(path(threadId),next); return next;
  });
}
export async function recordWorkHeartbeat({threadId,turnId}) {
  await recordAgentHeartbeat({threadId,turnId});
  if(!await readExecution(threadId)) return;
  return locked(threadId,async()=>{
    const old=await readExecution(threadId);
    if(!old||old.stoppedAt||old.turnId!==turnId) return;
    await writeJsonAtomically(path(threadId),{...old,heartbeatAt:new Date().toISOString()});
  });
}
