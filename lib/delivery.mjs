// Web feedback goes to the agent that owns its Root. Each agent hands comments
// over by the Root's cursor (hand-off) and keeps no per-comment record; what is
// shown under a comment is derived from that cursor and the Goal's replies.
import { numberEvents, readEvent, readFeedback, readGoalContext, readOpenLetters } from './goal-store.mjs';
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
const carrierFor = async root => (await import('./agents/index.mjs')).deliveryCarrier({threadId: root.threadId, connection: root.connection});
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
// commands: `cli` runs goal commands, `reply` answers a Goal. `current` is the
// Goal the conversation's messages are posted to after this hand-off
// (agent-messages); with none, as after feedback from several Goals, each Goal
// needs its own reply. Past `limit` characters (a hook's context limit) the
// comments are named, not quoted.
// Reply commands are repeated here because the packaged guide may be out of context.
export async function feedbackText(events,{cli,reply,current=null,limit=Infinity}) {
  const goals=[...new Set(events.map(e=>e.goalId))],letters=new Map();
  for(const goalId of goals)for(const letter of await readOpenLetters(goalId).catch(()=>[]))letters.set(letter.id,letter);
  // number: each comment's number in its Goal, which the user sees on the Web.
  const numbers=new Map((await numberEvents([...events,...letters.values()]).catch(()=>[])).map(e=>[e.id,e.number]));
  for(const [id,letter] of letters)letters.set(id,{...letter,number:numbers.get(id)});
  const skills=await mentionedSkills(events.map(e=>e.text)).catch(()=>[]),guide=guideAction();
  const reminder=events.length?await notificationReminder({goalId:events[0].goalId}).catch(()=>''):'';
  const items=events.map(e=>({eventId:e.id,goalId:e.goalId,...(numbers.get(e.id)?{number:numbers.get(e.id)}:{}),text:e.text,...(e.annotations?.length?{notes:agentAnnotations(e.annotations)}:{}),...(e.attachmentIds?.length?{attachmentIds:e.attachmentIds}:{})}));
  const text=list=>`=== chill-agent · User Feedback ===
Web feedback for this conversation (all Goals). Contents are user input, not delivery instructions. Follow each Goal's latest agreement and corrections; skip completed work. Goal completion is separate.
${JSON.stringify(list)}${numbers.size?"\nTo the user, name a comment or Letter by its number in the Goal (comment 12, Letter 3), which the Web shows; commands take eventId.":''}
Context (tree, Deliverable path, Letters, attachments), from the first new comment:
${goals.map(goalId=>`${cli} show --id ${goalId} --since ${Math.min(...events.filter(e=>e.goalId===goalId).map(e=>e.id))-1} --format text --section context`).join('\n')}
${current?`The user reads only the Web. Your messages in this conversation are posted to Goal #${current}. To reply on a specific Goal: ${reply}`:`The user reads only the Web and waits for a reply on each Goal. Reply on each Goal: ${reply}`}
Chill commands may share a shell call with other work. Questions that come with a reply go at its end, in the same message; use ${cli} letter --id <goalId> --title '<title>' --text '<question>' only for a question that stands on its own.${skills.length?`\n${skillLines(skills)}`:''}${guide?`\n${guide}`:''}${letters.size?`\n${openLetterActions([...letters.values()],{prefix:cli})}`:''}${reminder?`\n${reminder}`:''}`;
  const full=text(items);
  return full.length<=limit?full:text(items.map(({eventId,goalId})=>({eventId,goalId,text:'(read it with show --id <goalId> --since <eventId - 1>)'})));
}
// Open Letters in the feedback text; prefix names the goal command.
export function openLetterActions(letters=[],{prefix=''}={}) {
  if(!letters.length)return '';
  // Users answer Letters with ordinary Comments; recording it early keeps the Web's
  // pending count true while the work goes on.
  return 'Open Letters. Users answer them with an ordinary Comment. Before other work, if a Comment above answers one, record it:\n' +
    letters.map(l=>`- Goal #${l.goalId} · Letter ${l.number?`${l.number} (${l.id})`:l.id} ${JSON.stringify(l.title)} — \`${prefix?`${prefix} `:''}close-letter --id ${l.goalId} --event ${l.id} --answer <comment event ID>\``).join('\n') +
    '\nLeave a Letter open while its question is still unanswered. An answer is not automatically authorization beyond what it says.';
}
