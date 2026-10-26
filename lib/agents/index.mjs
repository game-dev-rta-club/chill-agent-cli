// The one place core code gets an agent connection. Core sees only this
// interface; which harness implements it is invisible here. Display strings
// such as the agent name and model come back as plain data.
//
// agent = {
//   token,                      opaque key; changes when the Root is reassigned
//   name,                       display name only, never used to branch
//   presence(goalId),           {connected,status,goalId,title,eventId?,turnId?,last,checkedAt}
//   status(goalId),             {agent:{name,model,status},capabilities,work,queue,
//                                control?,settings?,models?,usage?,usageScope?,checkedAt?}
//   control(goalId,input),      current-run Pause/Resume
//   activity(goalId),           the agent as the Goal shows it after its conversation (hand-off goalActivity):
//                               {goalId,status,turnId,capabilities:{stop,resume},work}|null, where work is
//                               Think, its current or last work's public text: {live,settings,startedAt,messages}
//   comments(goalId),           the mark under each of the Goal's comments (hand-off commentMarks)
//   isCaller(env),              whether this process runs in the agent's own conversation
//   selectWork(goalId,{stop,env}), goal work: mark the Goal the caller's current run works on
//   saveSettings(goalId,input), when capabilities.settings
//   continuation,               the end-of-turn check (Autonomy): {live}, and for an agent chill polls
//                                {read(),plan(),observe(pending),enqueue(facts,text,id),prepare,tick,busy};
//                                an agent that is not polled checks at its own Stop
// }
//
// Beyond the per-Root interface, the index exports what extensions and entry
// points need by name: assignGoal (bind a chat to a Root; null unbinds),
// readRunOutput (a chat's public turn output by id) and runNativeAction (a
// native conversation's confirmed action).
//
// A saved comment is carried by the agent of its Root:
// carrier = {deliver(id,event), sendNow(id)}, each returning the comment's mark.
// Agents hand comments over by the Root's cursor (hand-off); a Goal is answered
// by a reply on it, so no agent reports receipts.
import {codexAgent,codexExecutions,codexDeliveries,codexCaller,codexLiveWork} from './codex.mjs';
import {claudeAgent,claudeExecutions,claudeDeliveries,claudeCaller,claudeLiveWork} from './claude.mjs';
import {assignGoal} from './codex-execution.mjs';
import {readRunOutput} from './codex-run-output.mjs';
import {runClaudeAction as runNativeAction} from '../claude-actions.mjs';
import {listDeliveries} from '../delivery.mjs';
import {readGoalContext} from '../goal-store.mjs';

export {assignGoal,readRunOutput,runNativeAction};
const adapters=[codexAgent,claudeAgent];
export function agentFor(root) {
  for(const adapter of adapters){const agent=adapter(root);if(agent)return agent;}
  return null;
}
// Whether the process calling chill is the Root's own agent conversation.
export async function callerOwns(root,env=process.env) {const agent=agentFor(root);return Boolean(agent&&await agent.isCaller(env));}
// An agent's Comment answers the Goal it is on, so one from another agent
// conversation is refused. A command from outside any agent (the user's shell),
// or on a Goal no agent owns, is not.
export async function assertAnswerer(root,env=process.env) {
  const agent=agentFor(root);
  if(agent&&[codexCaller,claudeCaller].some(inAgent=>inAgent(env))&&!await agent.isCaller(env))throw Error('That Goal belongs to another conversation.');
}
export const agentKey=root=>agentFor(root)?.token??null;
export async function selectAgentWork(goalId,{stop=false,env=process.env}={}) {
  const agent=agentFor((await readGoalContext(goalId)).root);
  if(!agent)throw Error('Work must come from the Goal’s assigned chat.');
  return agent.selectWork(goalId,{stop,env});
}
export const agentContinuation=root=>agentFor(root)?.continuation??null;
// The Goals other live conversations work on, for Autonomy Ultra Continue: every agent's
// running work except the asking agent's own (its token).
export async function goalsHeldElsewhere(token) {
  const held=new Set();
  for(const live of [codexLiveWork,claudeLiveWork])for(const work of await live())if(work.token!==token)for(const id of work.goals)held.add(String(id));
  return held;
}
// Running and paused marks for the Goal list, from every kind of agent.
export async function agentExecutions(goals) {
  let executions=new Map();
  for(const overlay of [codexExecutions,claudeExecutions])executions=await overlay(goals,executions);
  return executions;
}
const deliveries=[codexDeliveries,claudeDeliveries];
export function deliveryCarrier(state) {
  for(const adapter of deliveries){const carrier=adapter.carrier(state);if(carrier)return carrier;}
  return null;
}
// The mark under each of a Goal's comments, from the agent of its Root.
export async function goalCommentMarks(goalId) {
  const agent=agentFor((await readGoalContext(goalId)).root);
  return agent?agent.comments(goalId):listDeliveries(goalId);
}
