// Web feedback goes to the agent that owns its Root. Each agent hands comments
// over by the Root's cursor (hand-off) and keeps no per-comment record; what is
// shown under a comment is derived from that cursor and the Goal's replies.
import { readEvent, readFeedback, readGoalContext } from './goal-store.mjs';
import { unanswered } from './agent-rules.mjs';

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

// Shared by every harness's feedback text; prefix names the goal command when needed.
export function openLetterActions(letters=[],{prefix=''}={}) {
  if(!letters.length)return '';
  // Users answer Letters with ordinary Comments; recording it early keeps the Web's
  // pending count true while the work goes on.
  return 'Open Letters. Users answer them with an ordinary Comment. Before other work, if a Comment above answers one, record it:\n' +
    letters.map(l=>`- Goal #${l.goalId} · Letter #${l.id} ${JSON.stringify(l.title)} — \`${prefix?`${prefix} `:''}close-letter --id ${l.goalId} --event ${l.id} --answer <comment event ID>\``).join('\n') +
    '\nLeave a Letter open while its question is still unanswered. An answer is not automatically authorization beyond what it says.';
}
