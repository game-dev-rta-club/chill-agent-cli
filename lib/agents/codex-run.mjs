// Codex run state for the Agent menu and the Goal list, from the chat's snapshot
// (codex-work), as claude-run does for Claude.
import {codexSnapshot} from './codex-work.mjs';
import {executionMarks,focusGoal,handedIn} from '../hand-off.mjs';
import {hidden} from '../hidden-failure.mjs';

export function presenceOf(snapshot){
 const shown=snapshot.status==='running'?'working':snapshot.status;
 const goal=snapshot.goals.find(g=>g.id===focusGoal(snapshot)),last=snapshot.goals.find(g=>g.id===snapshot.work.lastGoal);
 return {connected:true,status:shown==='idle'&&snapshot.queued?'queued':shown,goalId:goal?.id||null,title:goal?.title||null,eventId:goal?handedIn(snapshot,goal.id):null,
  turnId:snapshot.status==='running'?snapshot.work.id:null,last:last?{goalId:last.id,title:last.title,eventId:handedIn(snapshot,last.id)}:null,running:snapshot.running,checkedAt:snapshot.checkedAt};
}
export const observeCodex=async threadId=>presenceOf(await codexSnapshot(threadId));

export async function overlayCodexExecutions(goals,executions){
 for(const threadId of new Set(goals.filter(g=>!g.parentId&&g.threadId).map(g=>g.threadId))){
  const snapshot=await codexSnapshot(threadId).catch(hidden('codex-run.overlay',null));
  if(!snapshot)continue;
  for(const mark of executionMarks(snapshot,{threadId}))if(!executions.has(mark.goalId))executions.set(mark.goalId,mark);
 }
 return executions;
}
