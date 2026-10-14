// The one place core code gets an agent connection. Core sees only this
// interface; which harness implements it is invisible here. Display strings
// such as the agent name and model come back as plain data.
//
// agent = {
//   token,                      opaque key; changes when the Root is reassigned
//   status(goalId),             {agent:{name,model,status},capabilities,work,queue,
//                                control?,settings?,models?,usage?,usageScope?,approveAll?,checkedAt?}
//   control(goalId,input),      current-run Pause/Resume
//   controlActivity(goalId,input), Pause/Resume of one delivered message's run
//   setApproveAll(on),          when capabilities.approveAll
//   saveSettings(goalId,input), when capabilities.settings
// }
import {codexAgent} from './codex.mjs';
import {claudeAgent} from './claude.mjs';

const adapters=[codexAgent,claudeAgent];
export function agentFor(root) {
  for(const adapter of adapters){const agent=adapter(root);if(agent)return agent;}
  return null;
}
