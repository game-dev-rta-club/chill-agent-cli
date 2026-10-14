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
import {codexAgent,codexExecutions} from './codex.mjs';
import {claudeAgent,claudeExecutions} from './claude.mjs';

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
