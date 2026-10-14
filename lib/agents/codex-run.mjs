// Codex run state from the Codex app and chill's selection records (adapter side).
import {listGoals} from '../goal-store.mjs';
import {readExecution,refreshExecutions,executionForGoals} from '../goal-execution.mjs';
import {readFeedbackHold} from '../feedback-hold.mjs';
import {displayPresence,observeAgentRun} from '../agent-observation.mjs';
import {overlayGoalActivity} from '../agent-activity.mjs';

export async function observeCodex(threadId){
 const [activity,selection,goals]=await Promise.all([observeAgentRun(threadId),readExecution(threadId),listGoals()]);
 const holds=(await Promise.all(goals.map(g=>readFeedbackHold(g.id)))).filter(h=>h?.threadId===threadId);
 const status=displayPresence({...activity,selection,holds});
 const selected=status==='working'&&selection&&!selection.stoppedAt&&selection.turnId===activity.turn?.id;
 const target=goals.find(g=>g.id===(selected?selection.goalId:activity.view?.goalId));
 // The last selected Goal stays reachable after the work ends.
 const previous=goals.find(g=>g.id===selection?.goalId);
 return {status,goalId:target?.id||null,title:target?.title||null,last:previous?{goalId:previous.id,title:previous.title,eventId:null}:null,checkedAt:new Date().toISOString()};
}

// Running and paused marks for Goals of every Codex Root.
export async function overlayCodexExecutions(goals,executions){
 await refreshExecutions();
 for(const [id,value] of await executionForGoals(goals))executions.set(id,value);
 return overlayGoalActivity(goals,executions);
}
