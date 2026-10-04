import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {readGoalContext, listGoals, updateGoal, workspaceDirectory, validThreadId} from './goal-store.mjs';
import {readJson, writeJsonAtomically, withStoreLock} from './storage.mjs';
import {withCodex, verifyThread} from './codex-client.mjs';

// A selection belongs to exactly one chat AND turn. Neither updating Brief
// nor receiving feedback silently changes what that agent is working on.
export const heartbeatTTL=120000, observationTTL=15000;
const path=threadId=>join(workspaceDirectory(),'executions',`${validThreadId(threadId)}.json`);
const locked=(threadId,run)=>withStoreLock(join(workspaceDirectory(),'locks',`execution-${validThreadId(threadId)}`),run);
export const readExecution=threadId=>readJson(path(threadId));
export async function assignGoal(id,threadId) {
  const {goal}=await readGoalContext(id);
  if(goal.parentId) throw new Error('Assign a chat to the root Goal only.');
  if(threadId!==null) await verifyThread(validThreadId(threadId));
  // Already queued feedback retains its recipient; assignment never replays it.
  return updateGoal(id,{threadId});
}
export async function selectWork(id,{stop=false,threadId=process.env.CODEX_THREAD_ID}={}) {
  validThreadId(threadId);
  const {goal,root}=await readGoalContext(id);
  if(root.threadId!==threadId) throw new Error('Work must come from the Goal’s assigned chat.');
  if(stop) return locked(threadId,async()=>{
    const old=await readExecution(threadId);
    if(!old||old.goalId!==id) throw new Error('This is not the current work Goal.');
    const next={...old,stoppedAt:new Date().toISOString(),observation:null};
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
    const next={id:randomUUID(),rootId:root.id,goalId:id,threadId,turnId:turn.id,selectedAt:now,heartbeatAt:now,stoppedAt:null,observation:null};
    await writeJsonAtomically(path(threadId),next); return next;
  });
}
export async function recordWorkHeartbeat({threadId,turnId}) {
  validThreadId(threadId);validThreadId(turnId);
  if(!await readExecution(threadId)) return;
  return locked(threadId,async()=>{
    const old=await readExecution(threadId);
    if(!old||old.stoppedAt||old.turnId!==turnId) return;
    await writeJsonAtomically(path(threadId),{...old,heartbeatAt:new Date().toISOString()});
  });
}
export function observeExecution(selection,thread,turn,now=Date.now()) {
  const checkedAt=new Date(now).toISOString();
  if(!turn) return {status:'unknown',checkedAt,reason:'The selected turn could not be read.'};
  if(turn.id!==selection.turnId||turn.completedAt!=null||['completed','failed'].includes(turn.status)) return {status:'idle',checkedAt,reason:'The selected turn has ended or another turn is current.'};
  if(['idle','systemError'].includes(thread.status?.type)) return {status:'unknown',checkedAt,reason:'Codex does not confirm active execution.'};
  // A separate app-server does not load Desktop's active chat. A recent hook
  // is positive liveness evidence even when that server reports notLoaded or
  // interrupted with no completedAt. Those values alone prove nothing.
  if(thread.status?.type==='active'||now-Date.parse(selection.heartbeatAt)<heartbeatTTL) return {status:'working',checkedAt};
  return {status:'unknown',checkedAt,reason:'Live execution could not be confirmed. Working is hidden until a new heartbeat.'};
}
const refreshes=new Map();
export async function refreshExecutions() {
  const goals=await listGoals(),roots=goals.filter(g=>!g.parentId&&g.threadId);
  const threads=[...new Set(roots.map(g=>g.threadId))];
  await Promise.all(threads.map(async threadId=>{
    const old=await readExecution(threadId);
    if(!old||old.stoppedAt||old.observation?.status==='idle'||goals.find(g=>g.id===old.goalId)?.state!=='idle'||!roots.some(g=>g.id===old.rootId&&g.threadId===threadId))return;
    const cached=refreshes.get(threadId);
    if(cached&&(!cached.done||Date.now()-cached.at<5000))return cached.promise;
    const entry={at:Date.now(),done:false};
    entry.promise=(async()=>{
      let observation;
      try {
        observation=await withCodex(async client=>{
          const {thread}=await client.request('thread/read',{threadId,includeTurns:false});
          const turns=await client.request('thread/turns/list',{threadId,limit:1,itemsView:'notLoaded'});
          return observeExecution(old,thread,turns.data[0]);
        });
      }catch{observation={status:'unknown',checkedAt:new Date().toISOString(),reason:'Codex connection unavailable. Working is hidden.'};}
      await locked(threadId,async()=>{
        const current=await readExecution(threadId);
        if(current?.id!==old.id||current.stoppedAt)return;
        // Do not overwrite a heartbeat arriving during the network read.
        await writeJsonAtomically(path(threadId),{...current,observation});
      });
    })().finally(()=>{entry.done=true;});
    refreshes.set(threadId,entry);return entry.promise;
  }));
}
export async function executionForGoals(goals,now=Date.now()) {
  const result=new Map();
  for(const root of goals.filter(g=>!g.parentId&&g.threadId)) {
    const selected=await readExecution(root.threadId);
    if(!selected||selected.stoppedAt||selected.rootId!==root.id)continue;
    const goal=goals.find(g=>g.id===selected.goalId);
    if(!goal||goal.state!=='idle')continue;
    let parent=goal;
    while(parent.parentId)parent=goals.find(g=>g.id===parent.parentId);
    if(parent.id!==root.id)continue;
    const observed=selected.observation;
    const fresh=observed&&(observed.status==='idle'||now-Date.parse(observed.checkedAt)<observationTTL);
    result.set(goal.id,{goalId:goal.id,rootId:root.id,threadId:root.threadId,turnId:selected.turnId,
      status:fresh?observed.status:'unknown',checkedAt:observed?.checkedAt??null,
      expiresAt:observed?new Date(Date.parse(observed.checkedAt)+observationTTL).toISOString():null,
      reason:fresh?observed.reason:'Execution status needs a fresh Codex check.'});
  }
  return result;
}
