// The one place core code gets an agent connection. Core sees only this
// interface; which harness implements it is invisible here. Display strings
// such as the agent name and model come back as plain data.
//
// agent = {
//   token,                      opaque key; changes when the Root is reassigned
//   presence(goalId),           {connected,status,goalId,title,eventId?,turnId?,last,checkedAt}
//   status(goalId),             {agent:{name,model,status},capabilities,work,queue,
//                                control?,settings?,models?,usage?,usageScope?,approveAll?,checkedAt?}
//   control(goalId,input),      current-run Pause/Resume
//   controlActivity(goalId,input), Pause/Resume of one delivered message's run
//   isCaller(env),              whether this process runs in the agent's own conversation
//   setApproveAll(on),          when capabilities.approveAll
//   saveSettings(goalId,input), when capabilities.settings
// }
//
// A saved feedback is carried by the agent its delivery record names:
// carrier = {deliver(id,event), receipt(id,status,env)}. A receipt returns the
// updated delivery, or {pending,note} when the agent confirms it later; the
// pending line must be printed on its own.
import {codexAgent,codexExecutions,codexDeliveries} from './codex.mjs';
import {claudeAgent,claudeExecutions,claudeDeliveries} from './claude.mjs';
import {listDeliveries} from '../delivery.mjs';

const adapters=[codexAgent,claudeAgent];
export function agentFor(root) {
  for(const adapter of adapters){const agent=adapter(root);if(agent)return agent;}
  return null;
}
// Whether the process calling chill is the Root's own agent conversation.
export async function callerOwns(root,env=process.env) {const agent=agentFor(root);return Boolean(agent&&await agent.isCaller(env));}
export const agentKey=root=>agentFor(root)?.token??null;
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
// A Goal's deliveries with each agent's progress (Think) and reception marks.
export async function deliveriesWithWork(goalId) {
  for(const adapter of deliveries)await adapter.refresh?.(goalId);
  let list=await listDeliveries(goalId);
  for(const adapter of deliveries)if(adapter.decorate)list=await adapter.decorate(list);
  return list;
}
