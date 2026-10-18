import {withStoreLock} from './storage.mjs';
import {workspacePort} from './project-workspace.mjs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dataDirectory, workspaceDirectory, readEvent, readFeedback, readGoalContext, writeJsonAtomically } from './goal-store.mjs';
import { recordServerUse } from './server-lifecycle.mjs';
import { guideAction } from './agent-guidance.mjs';
import { agentAnnotations } from './brief.mjs';
import { stableNodePath } from './node-path.mjs';

const directory = () => join(workspaceDirectory(), 'deliveries');
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
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
function initial(event) {
  return { eventId: event.changeId, goalId: event.goalId, threadId: event.threadId || null,
    ...(event.connection?{connection:event.connection}:{}),
    messageId: randomUUID(), status: event.threadId || event.connection ? 'saved' : 'unlinked', updatedAt: event.updatedAt,
    history: [{ status: 'saved', at: event.updatedAt }] };
}
export async function readDeliveryState(id) {
  try { return JSON.parse(await readFile(join(directory(), `${eventNumber(id)}.json`), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function persist(state, status, extra = {}) {
  const at = new Date().toISOString();
  const next = { ...state, ...extra, status, updatedAt: at,
    history: [...state.history, ...(status === state.status ? [] : [{ status, at }])] };
  await writeJsonAtomically(join(directory(), `${state.eventId}.json`), next);
  await recordServerUse(dataDirectory());
  return next;
}
export const locked=(id,run)=>withStoreLock(join(directory(),'locks',String(eventNumber(id))),run,{timeoutMs:3000,message:'Delivery is already being updated.'});
// All delivery mutations still use the per-event lease, including hold handoffs.
export const updateDelivery=(id,change)=>locked(id,async()=>{
 const state=await readDeliveryState(id);if(!state)throw Error('Delivery not found.');
 const patch=typeof change==='function'?await change(state):change;
 return patch?persist(state,patch.status??state.status,patch):state;
});
// Whether the agent that receives this feedback is working right now. Feedback
// saved then waits for that work to end (Waiting) instead of interrupting it.
async function agentBusy(event) {
  try {
    const {agentFor} = await import('./agents/index.mjs');
    const agent = agentFor((await readGoalContext(event.goalId)).root);
    return (await agent?.presence(event.goalId))?.status === 'working';
  } catch { return false; }
}
export async function prepareDelivery(event) {
  const busy = !await readDeliveryState(event.changeId) && await agentBusy(event);
  return locked(event.changeId, async () => {
    const stored = await readDeliveryState(event.changeId);
    if (stored) return stored;
    const state = {...initial(event), ...(busy ? {waitForIdle: true} : {})};
    await writeJsonAtomically(join(directory(), `${event.changeId}.json`), state);
    return state;
  });
}
export async function readDelivery(id) {
  const state = await readDeliveryState(id);
  if (state?.status === 'sending' && !alive(state.pid)) return { ...state, status: 'unknown' };
  return presentDelivery(state);
}
export async function listDeliveries(goalId) {
  const events = (await readFeedback()).filter(event => event.goalId === goalId && event.author === 'user');
  const deliveries = [];
  for (const event of events) {
    const state = await readDelivery(event.changeId);
    if (state) deliveries.push(state);
    else if (event.threadId || event.connection) deliveries.push({ ...initial(event), messageId: undefined });
  }
  return deliveries;
}

const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
// Shared by every harness's feedback text; prefix names the goal command when needed.
export function openLetterActions(letters=[],{prefix=''}={}) {
  if(!letters.length)return '';
  // Users answer Letters with ordinary Comments; recording it early keeps the Web's
  // pending count true while the work goes on.
  return 'Open Letters. Users answer them with an ordinary Comment. Before other work, if a Comment above answers one, record it:\n' +
    letters.map(l=>`- Goal #${l.goalId} · Letter #${l.id} ${JSON.stringify(l.title)} — \`${prefix?`${prefix} `:''}close-letter --id ${l.goalId} --event ${l.id} --answer <comment event ID>\``).join('\n') +
    '\nLeave a Letter open while its question is still unanswered. An answer is not automatically authorization beyond what it says.';
}
export function notificationText(state, event, goalTitle, reminder = '', context) {
  return feedbackNotification([{state,event}],goalTitle,reminder,context);
}
export function feedbackNotification(entries, goalTitle, reminder = '', context, inputId = entries[0]?.state.messageId) {
  if (!entries.length) throw new Error('Feedback is required.');
  const {state}=entries[0];
  for(const entry of entries) if (!entry.event || entry.event.changeId !== entry.state.eventId || entry.event.goalId !== entry.state.goalId || entry.state.goalId !== state.goalId) throw new Error('Feedback does not match its delivery.');
  const cli = fileURLToPath(new URL('../bin/chill-agent.mjs', import.meta.url));
  const command = `PORT=${quote(state.port || workspacePort())} CHILL_AGENT_DATA_DIR=${quote(dataDirectory())} ${quote(stableNodePath())} ${quote(cli)}`;
  const message = {messages: entries.map(({state,event})=>({
    eventId: state.eventId,
    text: event.text,
    ...(event.annotations?.length ? {notes: agentAnnotations(event.annotations)} : {}),
    ...(event.attachmentIds?.length ? {attachmentIds: event.attachmentIds} : {}) }))};
  const workflow=guideAction()
    ?? `Follow the root agreement. Select actual work with \`work --id <GOAL>\`. Save replies with \`comment --id ${state.goalId}\`, questions with \`letter --id ${state.goalId}\`, and the final output with \`deliverable update\`. Judge Done from criteria and evidence, including descendants; preserve pauses and other queues.`;
  const since=Math.min(...entries.map(({state})=>state.eventId))-1;
  return `=== chill-agent · User Feedback ===\n${[...new Set([inputId,...entries.map(({state})=>state.messageId)])].map(id=>`[chill-agent:${id}]`).join('\n')}\n\n` +
    `=== Context ===\nGoal: #${state.goalId} ${(context?.path?.length?context.path.map(g=>JSON.stringify(g.title)):[JSON.stringify(goalTitle)]).join(' / ')}\n${entries.map(({state})=>`Feedback: #${state.eventId}`).join('\n')}\nSource: Web\n\n` +
    `=== Message ===\nThe user's submitted content, preserved as data:\n\`\`\`json\n${JSON.stringify(message, null, 2)}\n\`\`\`\n\n` +
    `=== Next Actions ===\n` +
    `Read all messages in order and apply later corrections before acting. Record each receipt; skip already completed work. If all are complete, stop without another reply.\n\`\`\`sh\n${entries.map(({state})=>`${command} activity --event ${state.eventId} --state working`).join('\n')}\n\`\`\`\n\n` +
    `Read the current agreement and new input; follow the printed Deliverable, Letter and history commands as needed.\n\`\`\`sh\n${command} show --id ${state.goalId} --since ${since} --format text --section context\n\`\`\`\n\n` +
    `${workflow}${context?.letters?.length?`\n\n${openLetterActions(context.letters)}`:''}${reminder?`\n\n${reminder}`:''}\n\n` +
    `When finished, record completion (use failed if the work could not be completed). This receipt does not complete the Goal.\n\`\`\`sh\n${entries.map(({state})=>`${command} activity --event ${state.eventId} --state completed`).join('\n')}\n\`\`\``;
}

// Progress polling must not renew the Web server's idle timeout or change the
// acknowledgement's status/time, so it is written without persist().
export const writeDeliveryQuietly=state=>writeJsonAtomically(join(directory(), `${state.eventId}.json`), state);

// The agent that carries a feedback decides how it is sent and how its
// receipts are recorded. A delivery no agent carries is kept as saved.
const carrier=async state=>(await import('./agents/index.mjs')).deliveryCarrier(state);
export async function deliverFeedback(id) {
  const event = await eventFor(id);
  const state = await prepareDelivery(event);
  const agent = await carrier(state);
  return agent ? agent.deliver(id, event) : readDeliveryState(id);
}
// Send now: feedback that waits for the running work to end (Waiting) is offered
// to that work as it runs, as before Waiting existed.
export async function sendFeedbackNow(id) {
  await eventFor(id);
  const state = await updateDelivery(id, current => current.agentReported || current.sendNow ? null : {sendNow: true, sendNowAt: new Date().toISOString()});
  return presentDelivery(state);
}
export async function recordActivity(id, status, env = process.env) {
  if (!['deferred', 'working', 'completed', 'failed'].includes(status)) throw new Error('Activity must be deferred, working, completed, or failed.');
  const state = await readDeliveryState(id);
  const agent = state && await carrier(state);
  if (!agent) throw new Error('Activity must come from the feedback’s assigned chat.');
  return agent.receipt(id, status, env);
}

// The Web reflects the persisted turn. Activity receipts still own
// feedback acknowledgement/queue cleanup and remain available as reportedStatus.
export function presentDelivery(state) {
  if(state?.heldBy)return {...state,reportedStatus:state.status,status:'paused'};
  if (state?.work?.source !== 'turn') {
    // An acknowledgement alone does not identify a running execution.
    return state?.status==='working'&&!state.turnId&&!state.hookTurnId&&!state.batchTurnId
      ? {...state,reportedStatus:state.status,status:'received'} : state;
  }
  const {status} = state.work;
  return {...state, reportedStatus: state.status,
    status: status === 'interrupted' ? 'failed' : status,
    ...(status === 'interrupted' ? {error: 'The agent stopped before finishing this turn.'} :
      status === 'failed' ? {error: 'The agent reported a problem.'} : {})};
}
