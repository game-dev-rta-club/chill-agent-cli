import {readGoalContext,listGoals} from './goal-store.mjs';
import {readExecution} from './goal-execution.mjs';
import {readFeedbackHold} from './feedback-hold.mjs';
import {agentPresence,observeAgentRun} from './agent-observation.mjs';
export {agentPresence,readPresenceSnapshot} from './agent-observation.mjs';

async function observe(threadId){
 const [activity,selection,goals]=await Promise.all([observeAgentRun(threadId),readExecution(threadId),listGoals()]);
 const holds=(await Promise.all(goals.map(g=>readFeedbackHold(g.id)))).filter(h=>h?.threadId===threadId);
 const status=agentPresence({...activity,selection,holds});
 const selected=status==='working'&&selection&&!selection.stoppedAt&&selection.turnId===activity.turn?.id;
 const target=goals.find(g=>g.id===(selected?selection.goalId:activity.view?.goalId));
 return {status,goalId:target?.id||null,title:target?.title||null,checkedAt:new Date().toISOString()};
}
export async function readAgentPresence(goalId){
 const {root}=await readGoalContext(goalId);
 if(!root.threadId)return {connected:false,status:'unlinked'};
 const result=await observe(root.threadId);
 if((await readGoalContext(goalId)).root.threadId!==root.threadId)throw Error('Agent assignment changed.');
 return {connected:true,...result};
}
