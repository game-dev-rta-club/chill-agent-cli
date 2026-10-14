// What the Root's agent is doing now, for the Agent button, tab icon and Goal
// list. Harness-neutral: each agent observes itself (lib/agents).
import {readGoalContext} from './goal-store.mjs';
import {agentFor,agentExecutions} from './agents/index.mjs';
export {agentPresence,readPresenceSnapshot} from './agents/codex-observation.mjs';
export {agentExecutions};

export async function readAgentPresence(goalId){
 const {root}=await readGoalContext(goalId),agent=agentFor(root);
 if(!agent)return {connected:false,status:'unlinked'};
 const result=await agent.presence(goalId);
 if(agentFor((await readGoalContext(goalId)).root)?.token!==agent.token)throw Error('Agent assignment changed.');
 return result;
}
