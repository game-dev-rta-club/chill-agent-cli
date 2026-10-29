// The Goal commands an agent conversation runs, the same for every agent:
// goal create (a Root the caller owns), adopt, release, reply and inbox. The
// caller is the conversation its app names in the shell (agents/index.mjs
// namedCaller); a command from outside any agent, such as the user's shell, has
// no caller and acts for nobody.
import {agentMessageType,appendAgentComment,createGoal,createOwnedRoot,readGoalContext,setRootOwner} from './goal-store.mjs';
import {sameOwner} from './owner.mjs';
import {callingAgent,noteAgentComment} from './agents/index.mjs';
import {command} from './chill-command.mjs';

// {agent, owner, …adapter} of the calling conversation, or null outside any agent.
export const callingOwner=callingAgent;
const requireCaller=async(env,what)=>{
  const caller=await callingAgent(env);
  if(!caller)throw Error(`${what} runs in an agent conversation.`);
  return caller;
};
const read=id=>`Read it with:\n${command()} goal show --id ${id} --format text --section context`;

// Shared by every agent's inbox: comments handed now first, then the ones
// handed earlier and still awaiting a reply, so a second read does not look new.
export async function inboxText({handed,awaiting},feedbackText) {
  const now=new Set(handed.map(e=>e.id)),earlier=awaiting.filter(e=>!now.has(e.id));
  const listed=[handed.length?await feedbackText(handed):'',earlier.length?`Handed to you earlier and still awaiting your reply:\n${await feedbackText(earlier)}`:''].filter(Boolean);
  return listed.join('\n\n')||'Nothing awaits a reply in this conversation.';
}

export async function createRootOrGoal(input,{env=process.env}={}) {
  const caller=input.parentId?null:await callingAgent(env);
  if(!caller)return {goal:await createGoal(input)};
  await caller.owned(caller.owner);
  const goal=await createOwnedRoot(input,caller.owner);
  return {goal,text:await caller.after(`Created Goal #${goal.id}, owned by this conversation. ${read(goal.id)}`,env)};
}

export async function adoptRoot(goalId,{env=process.env}={}) {
  const caller=await requireCaller(env,'goal adopt');
  const {root}=await readGoalContext(goalId);
  await caller.owned(caller.owner);
  // No note in Web: an agent comment would count as a reply and drop the
  // user's comments that still await one.
  const {changed}=await setRootOwner(root.id,caller.owner);
  const text=changed
    ?`This conversation now owns Goal #${root.id} and its Split Goals. Comments not handed yet come here. ${read(root.id)}`
    :`This conversation already owns Goal #${root.id}.`;
  return {goalId:root.id,changed,text:await caller.after(text,env)};
}

export async function releaseRoot(goalId) {
  const {root}=await readGoalContext(goalId);
  const {changed}=await setRootOwner(root.id,null);
  return {goalId:root.id,changed,text:changed?`Goal #${root.id} has no owner now. A conversation takes it with goal adopt.`:`Goal #${root.id} had no owner.`};
}

// A reply answers the Goal it is on, so from an agent conversation it must be
// the Root's owner. The user's shell may write one for any Goal.
export async function replyOnGoal({goalId,text,ask},{env=process.env}={}) {
  const caller=await callingAgent(env);
  if(caller){
    const {root}=await readGoalContext(goalId);
    if(!root.owner)throw Error(`Goal #${goalId} has no owner. Take it with goal adopt --id ${root.id} first.`);
    if(!sameOwner(root.owner,caller.owner))throw Error(`Goal #${goalId} belongs to another conversation. Take it with goal adopt --id ${root.id} when the user asks.`);
  }
  const comment=await appendAgentComment({goalId,...agentMessageType(ask),text});
  if(caller)await noteAgentComment((await readGoalContext(goalId)).root,goalId,env);
  const saved=comment.type==='letter'
    ?`Replied on Goal #${goalId} with a Letter (comment ${comment.changeId}); it waits in the Letters menu until the user comments on the Goal. This does not complete the Goal.`
    :`Replied on Goal #${goalId} (comment ${comment.changeId}). This does not complete the Goal.`;
  return {comment,text:caller?await caller.after(saved,env):saved};
}

export async function readInbox({env=process.env}={}) {
  const caller=await requireCaller(env,'goal inbox');
  const listed=await caller.inbox(caller.owner,env);
  if(typeof listed==='string')return listed;
  return listed?inboxText(listed,listed.feedbackText):'This conversation is paused from the Web. Nothing is handed until Resume.';
}
