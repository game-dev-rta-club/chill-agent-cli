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
//   commented?(goalId),         its own conversation wrote a Comment or Letter on the Goal
//   saveSettings(goalId,input), when capabilities.settings
//   continuation,               the end-of-turn check (Autonomy): {live}, and for an agent chill polls
//                                {read(),plan(),observe(pending),enqueue(facts,text,id),prepare,tick,busy};
//                                an agent that is not polled checks at its own Stop
// }
//
// Beyond the per-Root interface, the index exports what extensions and entry
// points need by name: readRunOutput (a chat's public turn output by id) and runNativeAction (a
// native conversation's confirmed action).
//
// A saved comment is carried by the agent of its Root:
// carrier = {deliver(id,event), sendNow(id)}, each returning the comment's mark.
// Agents hand comments over by the Root's cursor (hand-off); a Goal is answered
// by a reply on it, so no agent reports receipts.
import {codexAgent,codexExecutions,codexDeliveries,codexLiveWork,codexCaller} from './codex.mjs';
import {claudeAgent,claudeExecutions,claudeDeliveries,claudeLiveWork,claudeCaller} from './claude.mjs';
import {readRunOutput} from './codex-run-output.mjs';
import {runClaudeAction as runNativeAction} from '../claude-actions.mjs';
import {listDeliveries} from '../delivery.mjs';
import {readGoalContext} from '../goal-store.mjs';

export {readRunOutput,runNativeAction};
const adapters=[codexAgent,claudeAgent];
export function agentFor(root) {
  for(const adapter of adapters){const agent=adapter(root);if(agent)return agent;}
  return null;
}
// Whether the process calling chill is the Root's own agent conversation.
export async function callerOwns(root,env=process.env) {const agent=agentFor(root);return Boolean(agent&&await agent.isCaller(env));}
// A Comment or Letter from the Root's own agent marks the Goal its work is on.
export async function noteAgentComment(root,goalId,env=process.env) {
  const agent=agentFor(root);
  if(agent?.commented&&await agent.isCaller(env))await agent.commented(goalId);
}
export const agentKey=root=>agentFor(root)?.token??null;
// The conversation running this command, named by its app in the shell:
// caller = {agent, link:{join,wait,wake}, owner(env), owned(owner), inbox(owner,env), after(text,env)},
// or null outside any agent (the user's shell).
export const namedCaller=(env=process.env)=>[codexCaller,claudeCaller].find(caller=>caller.named(env))??null;
export async function callingAgent(env=process.env) {
  const caller=namedCaller(env);
  return caller&&{...caller,owner:await caller.owner(env)};
}
export async function selectAgentWork(goalId,{stop=false,env=process.env}={}) {
  const agent=agentFor((await readGoalContext(goalId)).root);
  if(!agent)throw Error('This Goal has no owner. Take it with goal adopt first.');
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
