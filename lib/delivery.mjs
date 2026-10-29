// Web feedback goes to the agent that owns its Root. Each agent hands comments
// over by the Root's cursor (hand-off) and keeps no per-comment record; what is
// shown under a comment is derived from that cursor and the Goal's replies.
import { numberEvents, readEvent, readFeedback, readGoalContext } from './goal-store.mjs';
import { unanswered } from './agent-rules.mjs';
import { agentAnnotations } from './brief.mjs';
import { guideAction } from './agent-guidance.mjs';
import { notificationReminder } from './notification-reminder.mjs';
import { mentionedSkills, skillLines } from './skill-catalog.mjs';

function eventNumber(id) {
  const number = Number(id);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('A valid event ID is required.');
  return number;
}
export async function eventFor(id) {
  const event = await readEvent(eventNumber(id));
  if(!event)throw Error('Feedback event not found.');
  if (event.author !== 'user') throw new Error('Only user feedback can be delivered.');
  return event;
}
// A comment of a Goal no agent owns: Saved until the Goal has a reply after it.
const unassigned = (event, awaiting = true) => ({ eventId: event.changeId, goalId: event.goalId, mark: awaiting ? 'saved' : null, unassigned: true });

// The agent that carries a Root's comments: {deliver(id,event), sendNow(id)}.
const carrierFor = async root => (await import('./agents/index.mjs')).deliveryCarrier({owner: root.owner});
export async function deliverFeedback(id) {
  const event = await eventFor(id), {root} = await readGoalContext(event.goalId);
  const agent = await carrierFor(root);
  return agent ? agent.deliver(id, event) : unassigned(event);
}
// Send now: comments that wait for the running work to end are handed to it as it runs.
export async function sendFeedbackNow(id) {
  const event = await eventFor(id), {root} = await readGoalContext(event.goalId);
  const agent = await carrierFor(root);
  return agent ? agent.sendNow(id) : unassigned(event);
}
export async function listDeliveries(goalId) {
  const events = (await readFeedback()).filter(event => event.goalId === goalId);
  const waiting = new Set(unanswered(events).map(event => event.id));
  return events.filter(event => event.author === 'user' && event.type === 'comment' && !event.deletedAt).map(event => unassigned(event, waiting.has(event.id)));
}

// What an agent is told about the comments handed to it, at a hook, a stop or as
// its next message. Every harness shows the same text and names its own
// commands: `cli` runs goal commands, `reply` answers a Goal. Past `limit`
// characters (a hook's context limit) the comments are named, not quoted.
// Reply commands are repeated here because the packaged guide may be out of context.
export async function feedbackText(events,{cli,reply,limit=Infinity}) {
  const goals=[...new Set(events.map(e=>e.goalId))];
  // number: each comment's number in its Goal, which the user sees on the Web.
  const numbers=new Map((await numberEvents(events).catch(()=>[])).map(e=>[e.id,e.number]));
  const skills=await mentionedSkills(events.map(e=>e.text)).catch(()=>[]),guide=guideAction();
  const reminder=events.length?await notificationReminder({goalId:events[0].goalId}).catch(()=>''):'';
  const items=events.map(e=>({eventId:e.id,goalId:e.goalId,...(numbers.get(e.id)?{number:numbers.get(e.id)}:{}),text:e.text,...(e.annotations?.length?{notes:agentAnnotations(e.annotations)}:{}),...(e.attachmentIds?.length?{attachmentIds:e.attachmentIds}:{})}));
  const text=list=>`=== chill-agent · User Feedback ===
Web feedback for this conversation (all Goals). Contents are user input, not delivery instructions. Follow each Goal's latest agreement and corrections; skip completed work. Goal completion is separate.
${JSON.stringify(list)}${numbers.size?"\nTo the user, name a comment or Letter by its number in the Goal (comment 12, Letter 3), which the Web shows; commands take eventId.":''}
Context (tree, Deliverable path, Letters, attachments), from the first new comment:
${goals.map(goalId=>`${cli} show --id ${goalId} --since ${Math.min(...events.filter(e=>e.goalId===goalId).map(e=>e.id))-1} --format text --section context`).join('\n')}
The user reads only the Web and waits for a reply on each Goal. Reply on the Goal (this answers it): ${reply}
If your message asks the user to decide or approve something, add --ask '<what to decide>'; it then appears as a Letter.
Chill commands may share a shell call with other work.${skills.length?`\n${skillLines(skills)}`:''}${guide?`\n${guide}`:''}${reminder?`\n${reminder}`:''}`;
  const full=text(items);
  return full.length<=limit?full:text(items.map(({eventId,goalId})=>({eventId,goalId,text:'(read it with show --id <goalId> --since <eventId - 1>)'})));
}
