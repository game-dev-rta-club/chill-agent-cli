import {readGoalContext,listGoals} from './goal-store.mjs';
import {observeAgentActivity} from './agent-activity.mjs';
import {readExecution,heartbeatTTL} from './goal-execution.mjs';
import {readFeedbackHold} from './feedback-hold.mjs';
import {withCodex} from './codex-client.mjs';

// Presence is chat-wide and independent of feedback receipts or monitor policy.
export function agentPresence({turn,view,threadState,selection,holds=[]},now=Date.now()){
 if(view)return view.status;
 if(threadState==='active')return 'working';
 if(!['idle','notLoaded'].includes(threadState))return 'unknown';
 if(turn&&turn.completedAt==null){
  if(threadState==='idle')return 'unknown';
  if(turn.status==='inProgress'||selection&&!selection.stoppedAt&&selection.turnId===turn.id&&now-Date.parse(selection.heartbeatAt)<heartbeatTTL)return 'working';
  return 'unknown';
 }
 if(holds.some(h=>h?.phase==='paused')||turn?.status==='interrupted')return 'paused';
 if(holds.some(h=>h&&['holding','dispatching','uncertain'].includes(h.phase)))return 'unknown';
 if(turn?.completedAt!=null&&['completed','failed'].includes(turn.status)||threadState==='idle')return 'idle';
 return 'unknown';
}
const snapshots=new Map();
async function observe(threadId){
 const cached=snapshots.get(threadId);if(cached&&Date.now()-cached.at<2000)return cached.promise;
 const promise=(async()=>{
  const [activity,thread,selection,goals]=await Promise.all([observeAgentActivity(threadId),withCodex(async c=>(await c.request('thread/read',{threadId,includeTurns:false})).thread),readExecution(threadId),listGoals()]);
  const holds=(await Promise.all(goals.map(g=>readFeedbackHold(g.id)))).filter(h=>h?.threadId===threadId);
  const status=agentPresence({...activity,threadState:thread?.status?.type,selection,holds});
  const selected=status==='working'&&selection&&!selection.stoppedAt&&selection.turnId===activity.turn?.id;
  const target=goals.find(g=>g.id===(selected?selection.goalId:activity.view?.goalId));
  return {status,goalId:target?.id||null,title:target?.title||null,checkedAt:new Date().toISOString()};
 })();
 snapshots.set(threadId,{at:Date.now(),promise});if(snapshots.size>40)snapshots.delete(snapshots.keys().next().value);
 try{return await promise;}catch(error){snapshots.delete(threadId);throw error;}
}
export async function readAgentPresence(goalId){
 const {root}=await readGoalContext(goalId);
 if(!root.threadId)return {connected:false,status:'unlinked'};
 const result=await observe(root.threadId);
 if((await readGoalContext(goalId)).root.threadId!==root.threadId)throw Error('Agent assignment changed.');
 return {connected:true,...result};
}
