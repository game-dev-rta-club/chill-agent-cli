// The Goal commands an agent conversation runs (agent-actions), by the names
// tests use: create-goal, adopt, release, reply and inbox. Returns their text.
import {adoptRoot,createRootOrGoal,readInbox,releaseRoot,replyOnGoal} from '../lib/agent-actions.mjs';

export async function agentAction(action,payload={},env=process.env) {
  if(action==='create-goal')return (await createRootOrGoal({title:payload.title,scope:payload.scope??'',criteria:payload.criteria??''},{env})).text;
  if(action==='adopt')return (await adoptRoot(payload.goalId,{env})).text;
  if(action==='release')return (await releaseRoot(payload.goalId)).text;
  if(action==='reply')return (await replyOnGoal({goalId:payload.goalId==null?undefined:String(payload.goalId),text:payload.text,ask:payload.ask},{env})).text;
  if(action==='inbox')return readInbox({env});
  throw Error(`Unknown agent action ${action}.`);
}
