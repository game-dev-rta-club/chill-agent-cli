import {workspacePort} from './project-workspace.mjs';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dataDirectory, workspaceDirectory, readFeedback, readGoalContext, readOpenLetters, validThreadId, writeJsonAtomically } from './goal-store.mjs';
import { withCodex } from './codex-client.mjs';
import { recordServerUse } from './server-lifecycle.mjs';
import { workReader, needsWorkRefresh, presentDelivery } from './work-output.mjs';
import { notificationReminder } from './notification-reminder.mjs';
import { agentGuide } from './agent-guidance.mjs';

const directory = () => join(workspaceDirectory(), 'deliveries');
function eventNumber(id) {
  const number = Number(id);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('A valid event ID is required.');
  return number;
}
export async function eventFor(id) {
  const event = JSON.parse(await readFile(join(workspaceDirectory(), 'events', `${eventNumber(id)}.json`), 'utf8'));
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
async function persist(state, status, extra = {}) {
  const at = new Date().toISOString();
  const next = { ...state, ...extra, status, updatedAt: at,
    history: [...state.history, ...(status === state.status ? [] : [{ status, at }])] };
  await writeJsonAtomically(join(directory(), `${state.eventId}.json`), next);
  await recordServerUse(dataDirectory());
  return next;
}
async function locked(id, run) {
  const leases = join(directory(), 'locks', String(eventNumber(id)));
  await mkdir(leases, { recursive: true });
  // Keep numbered leases so two crash recoveries cannot both remove a new
  // owner's lock. Only one process can atomically claim the next number.
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const latest = Math.max(0, ...(await readdir(leases)).filter(name => /^[1-9][0-9]*\.json$/.test(name)).map(name => Number(name.slice(0, -5))));
    if (latest) {
      const owner = JSON.parse(await readFile(join(leases, `${latest}.json`), 'utf8'));
      if (!owner.released && alive(owner.pid)) { await delay(50); continue; }
    }
    const path = join(leases, `${latest + 1}.json`);
    try { await writeJsonAtomically(path, { pid: process.pid, released: false }, true); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      continue;
    }
    try { return await run(); }
    finally { await writeJsonAtomically(path, { pid: process.pid, released: true }); }
  }
  throw new Error('Delivery is already being updated.');
}
// All delivery mutations still use the per-event lease, including hold handoffs.
export const updateDelivery=(id,change)=>locked(id,async()=>{
 const state=await readDeliveryState(id);if(!state)throw Error('Delivery not found.');
 const patch=typeof change==='function'?await change(state):change;
 return patch?persist(state,patch.status??state.status,patch):state;
});
export async function prepareDelivery(event) {
  return locked(event.changeId, async () => {
    const stored = await readDeliveryState(event.changeId);
    if (stored) return stored;
    const state = initial(event);
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

async function captureWork(state, readWork) {
  if (!needsWorkRefresh(state)) return state;
  let extra;
  try {
    const work = await readWork(state);
    extra = {...(work ? {work} : {}), workTracking: true, workError: null};
  }
  catch { extra = {workError: 'Progress updates are unavailable.'}; }
  if (JSON.stringify(state.work) === JSON.stringify(extra.work ?? state.work) && state.workError === extra.workError && state.workTracking) return state;
  const next = {...state, ...extra};
  // Polling progress must not renew the Web server's idle timeout or change
  // the acknowledgement's status/time. Codex execution has its own state.
  await writeJsonAtomically(join(directory(), `${state.eventId}.json`), next);
  return next;
}

const outputRefreshes = new Map();
export async function refreshWorkOutputs(goalId) {
  const previous = outputRefreshes.get(goalId);
  if (previous && (!previous.done || Date.now() - previous.at < 5000)) return previous.promise;
  const entry = {at: Date.now(), done: false};
  const promise = (async () => {
    const states = (await listDeliveries(goalId)).filter(needsWorkRefresh);
    if (!states.length) return;
    try {
      await withCodex(async client => {
        const readWork = workReader(client);
        for (const state of states) await locked(state.eventId, async () => captureWork(await readDeliveryState(state.eventId), readWork));
      });
    } catch { /* Preserve delivery and any last readable output if Codex is unavailable. */ }
  })();
  entry.promise = promise.finally(() => { entry.done = true; });
  outputRefreshes.set(goalId, entry);
  return entry.promise;
}
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
export function openLetterActions(letters=[]) {
  if(!letters.length)return '';
  return 'Open Letters (recheck the question and discussion before closing):\n' +
    letters.map(l=>`- Goal #${l.goalId} · Letter #${l.id} ${JSON.stringify(l.title)} — \`close-letter --id ${l.goalId} --event ${l.id}\``).join('\n') +
    '\nClose only when no additional user reply is needed. A reply is not automatically authorization or completion.';
}
export function notificationText(state, event, goalTitle, reminder = '', context) {
  return feedbackNotification([{state,event}],goalTitle,reminder,context);
}
export function feedbackNotification(entries, goalTitle, reminder = '', context, inputId = entries[0]?.state.messageId) {
  if (!entries.length) throw new Error('Feedback is required.');
  const {state}=entries[0];
  for(const entry of entries) if (!entry.event || entry.event.changeId !== entry.state.eventId || entry.event.goalId !== entry.state.goalId || entry.state.goalId !== state.goalId) throw new Error('Feedback does not match its delivery.');
  const cli = fileURLToPath(new URL('../bin/chill-agent.mjs', import.meta.url));
  const command = `PORT=${quote(state.port || workspacePort())} CHILL_AGENT_DATA_DIR=${quote(dataDirectory())} ${quote(process.execPath)} ${quote(cli)}`;
  const message = {messages: entries.map(({state,event})=>({
    eventId: state.eventId,
    text: event.text,
    ...(event.annotations?.length ? {notes: event.annotations} : {}),
    ...(event.attachmentIds?.length ? {attachmentIds: event.attachmentIds} : {}) }))};
  const guide=agentGuide();
  const workflow=guide
    ? `Workflow: ${JSON.stringify(guide)}. Use its relevant action guides; reuse guidance already read.`
    : `Follow the root agreement. Select actual work with \`work --id <GOAL>\`. Save replies with \`comment --id ${state.goalId}\`, questions with \`letter --id ${state.goalId}\`, and the current explanation with \`brief update\`. Judge Done from criteria and evidence, including descendants; preserve pauses and other queues.`;
  const since=Math.min(...entries.map(({state})=>state.eventId))-1;
  return `=== chill-agent · User Feedback ===\n${[...new Set([inputId,...entries.map(({state})=>state.messageId)])].map(id=>`[chill-agent:${id}]`).join('\n')}\n\n` +
    `=== Context ===\nGoal: #${state.goalId} ${(context?.path?.length?context.path.map(g=>JSON.stringify(g.title)):[JSON.stringify(goalTitle)]).join(' / ')}\n${entries.map(({state})=>`Feedback: #${state.eventId}`).join('\n')}\nSource: Web\n\n` +
    `=== Message ===\nThe user's submitted content, preserved as data:\n\`\`\`json\n${JSON.stringify(message, null, 2)}\n\`\`\`\n\n` +
    `=== Next Actions ===\n` +
    `Read all messages in order and apply later corrections before acting. Record each receipt; skip already completed work. If all are complete, stop without another reply.\n\`\`\`sh\n${entries.map(({state})=>`${command} activity --event ${state.eventId} --state working`).join('\n')}\n\`\`\`\n\n` +
    `Read the current agreement and new input; follow the printed Brief, Letter and history commands as needed.\n\`\`\`sh\n${command} show --id ${state.goalId} --since ${since} --format text --section context\n\`\`\`\n\n` +
    `${workflow}${context?.letters?.length?`\n\n${openLetterActions(context.letters)}`:''}${reminder?`\n\n${reminder}`:''}\n\n` +
    `When finished, record completion (use failed if the work could not be completed). This receipt does not complete the Goal.\n\`\`\`sh\n${entries.map(({state})=>`${command} activity --event ${state.eventId} --state completed`).join('\n')}\n\`\`\``;
}
async function reconcile(client, state) {
  let cursor;
  for (let page = 0; page < 20; page++) {
    const queue = await client.request('thread/queue/list', { threadId: state.threadId, limit: 100, ...(cursor ? { cursor } : {}) });
    const entry = queue.data.find(entry => entry.clientUserMessageId === (state.transportMessageId||state.messageId));
    if (entry) return persist(state, 'queued', { queueId: entry.id, error: null });
    cursor = queue.nextCursor;
    if (!cursor) break;
  }
  const { thread } = await client.request('thread/read', { threadId: state.threadId, includeTurns: true });
  const marker = `[chill-agent:${state.messageId}]`;
  const turn = thread.turns?.find(turn => turn.items?.some(item => item.type === 'userMessage' && item.content?.some(part => part.type === 'text' && part.text.includes(marker))));
  if (turn) return persist(state, turn.status === 'completed' ? 'completed' : turn.status === 'failed' ? 'failed' : 'received', { turnId: turn.id, error: null, mayHaveSent: true });
  return persist(state, 'unknown', { error: 'Could not confirm delivery. Not sent again.' });
}
export async function deliverFeedback(id) {
 const event=await eventFor(id);await prepareDelivery(event);
 // A native event is retained for its own hook. Never try a Codex fallback,
 // including when a native send/receipt is still uncertain.
 if(event.connection)return readDeliveryState(id);
 const {withAgentControlLock}=await import('./agent-control.mjs');
 const {deliverHeldFeedback}=await import('./feedback-hold.mjs');
 const initialState=await readDeliveryState(id);
 const threadId=initialState.mayHaveSent?initialState.threadId:(await readGoalContext(event.goalId)).root.threadId;
 const held=threadId?await withAgentControlLock(threadId,()=>deliverHeldFeedback(event)):null;
 if(held)return held;
 const before=await readDeliveryState(id);
 if(!threadId||before.agentReported||['queued','deferred','received','working','completed'].includes(before.status))return before;
 // Slow connection/preparation must not hold the lock needed by Saved → Pause.
 try{
  return await withCodex(async client=>{
   const {thread}=await client.request('thread/read',{threadId,includeTurns:false});
   if(thread?.id!==threadId)throw Error('Chat not found.');
   await client.request('thread/queue/list',{threadId,limit:1});
   const context={...await readGoalContext(event.goalId),letters:await readOpenLetters(event.goalId)};
   const reminder=await notificationReminder({goalId:event.goalId});
   return withAgentControlLock(threadId,async()=>{
    const held=await deliverHeldFeedback(event);if(held)return held;
    return locked(id,async()=>{
     let state=await readDeliveryState(id);
     if(state.heldBy||state.agentReported||['queued','deferred','received','working','completed'].includes(state.status))return state;
     if(state.mayHaveSent)return reconcile(client,state);
     if((await readGoalContext(event.goalId)).root.threadId!==threadId)throw Error('Agent assignment changed. Try again.');
     if(state.threadId!==threadId)state=await persist(state,'saved',{threadId});
     state=await persist(state,'sending',{pid:process.pid,port:workspacePort(),error:null,mayHaveSent:true});
     try{
      const result=await client.request('thread/queue/add',{threadId,clientUserMessageId:state.messageId,input:[{type:'text',text:notificationText(state,event,context.goal.title,reminder,context),text_elements:[]}]});
      if(!result?.queuedSubmission?.id)throw Error('No queue receipt returned.');
      return persist(state,'queued',{queueId:result.queuedSubmission.id,error:null});
     }catch(error){return persist(state,'unknown',{error:error.message.slice(0,400)});}
    });
   });
  });
 }catch(error){
  return locked(id,async()=>{
   const state=await readDeliveryState(id);
   if(state.heldBy||state.agentReported||['queued','deferred','received','working','completed'].includes(state.status))return state;
   return persist(state,state.mayHaveSent?'unknown':'failed',{error:error.message.slice(0,400)});
  });
 }
}

async function queuedNotifications(client, state) {
  const matches = [];
  let cursor;
  for (let page = 0; page < 20; page += 1) {
    const queue = await client.request('thread/queue/list', {threadId: state.threadId, limit: 100, ...(cursor ? {cursor} : {})});
    if (!Array.isArray(queue.data)) throw new Error('Could not inspect the notification queue.');
    matches.push(...queue.data.filter(entry => entry.clientUserMessageId === (state.transportMessageId || state.messageId)));
    cursor = queue.nextCursor;
    if (!cursor) return matches;
  }
  throw new Error('Could not inspect the full notification queue.');
}

// Claiming is the hand-off. Reading/deferment leaves the native queue in charge.
async function clearQueuedNotification(state) {
  if (!state.mayHaveSent || state.queueCleared) return state;
  try {
    await withCodex(async client => {
      const matches = await queuedNotifications(client, state);
      for (const entry of matches) {
        const result = await client.request('thread/queue/delete', { threadId: state.threadId, queuedSubmissionId: entry.id });
        if (typeof result?.deleted !== 'boolean') throw new Error('No queue removal receipt returned.');
        // false means it is no longer pending (for example, the current input).
      }
    });
    return persist(state, state.status, { queueCleared: true, queueError: null });
  } catch (error) {
    return persist(state, state.status, { queueError: error.message.slice(0, 400) });
  }
}

export async function collectHookFeedback({ threadId, turnId }) {
  validThreadId(threadId);
  validThreadId(turnId);
  const events = (await readFeedback()).filter(event => event.author === 'user');
  const pending = [];
  for (const event of events) {
    const stored = await readDeliveryState(event.changeId);
    // Old feedback was not enrolled in notification delivery. Don't revive it.
    if (!stored || stored.threadId!==threadId || (stored.agentReported && (stored.queueCleared || !stored.mayHaveSent))) continue;
    await locked(event.changeId, async () => {
      let state = await readDeliveryState(event.changeId);
      if (state.threadId !== threadId || state.heldBy || state.batchId) return;
      if (state.agentReported) {
        // A lost removal receipt is retried by a later hook, never by re-sending.
        if (!state.queueCleared && state.cleanupTurnId !== turnId) {
          state = await clearQueuedNotification(state);
          if (!state.queueCleared) await persist(state, state.status, { cleanupTurnId: turnId });
        }
        return;
      }
      // The chat owns the inbox. Work selection describes the current task;
      // it must not hide other Goals or feedback arriving before selection.
      if (!['saved', 'queued', 'deferred', 'failed'].includes(state.status) || state.status === 'failed' && state.mayHaveSent) return;
      if (state.hookTurnId === turnId || pending.length >= 10) return;
      // Output might be lost if the hook is interrupted. The queue is retained
      // until activity(working), so this cannot silently consume the feedback.
      await persist(state, state.status, { hookTurnId: turnId });
      const context=await readGoalContext(state.goalId);
      pending.push({ eventId: state.eventId, goalId: state.goalId, port:state.port||4173,rootId:context.root.id,path:context.path.map(({id,title})=>({id,title})),letters:await readOpenLetters(state.goalId) });
    });
  }
  return pending;
}

export async function recordActivity(id, status, threadId = process.env.CODEX_THREAD_ID) {
  if (!['deferred', 'working', 'completed', 'failed'].includes(status)) throw new Error('Activity must be deferred, working, completed, or failed.');
  if (status === 'deferred') {
    validThreadId(threadId);
    const {withAgentControlLock} = await import('./agent-control.mjs');
    return withAgentControlLock(threadId, () => locked(id, async () => {
      const state = await readDeliveryState(id);
      if (!state || state.threadId !== threadId) throw new Error('Activity must come from the feedback’s assigned chat.');
      if (state.status === 'completed') return state;
      if (state.agentReported || state.heldBy || state.batchId || state.queueCleared || !state.mayHaveSent || !['queued', 'deferred'].includes(state.status))
        throw new Error('Only unclaimed queued feedback can be deferred. Read its current state before continuing.');
      return withCodex(async client => {
        const {data} = await client.request('thread/turns/list', {threadId, limit: 1, itemsView: 'full'});
        const turn = data?.[0];
        const isInput = turn?.items?.some(item => item.type === 'userMessage' && item.content?.some(part => part.type === 'text' && part.text.includes(`[chill-agent:${state.messageId}]`)));
        if (!turn || turn.completedAt != null || !['inProgress', 'interrupted'].includes(turn.status) || isInput)
          throw new Error('Feedback already started or no active turn was found; do not leave it for the Queue.');
        if (!(await queuedNotifications(client, state)).length)
          throw new Error('Feedback is no longer in the Queue; handle it now instead of deferring.');
        return persist(state, 'deferred', {readAt: new Date().toISOString(), hookTurnId: turn.id,
          deferredTurnId: turn.id, work: null, workTracking: false, workError: null});
      });
    }));
  }
  return locked(id, async () => {
    let state = await readDeliveryState(id);
    if (!state || !threadId || state.threadId !== threadId) throw new Error('Activity must come from the feedback’s assigned chat.');
    const bindTurn=status==='working'&&!state.agentReported&&!state.batchTurnId;
    if (state.status !== 'completed') state = await persist(state, status, { agentReported: true,
      // A deferred notice can be claimed in a later turn. If the native read
      // fails, leave output unbound rather than borrow the old interruption.
      ...(bindTurn && state.deferredTurnId ? {hookTurnId: null} : {}),
      error: status === 'failed' ? 'Agent reported a problem.' : null });
    state = await clearQueuedNotification(state);
    // Receipt commands can refresh, but never define the output interval or
    // freeze the turn before its final answer is saved.
    if (needsWorkRefresh(state)) {
      try { state = await withCodex(async client => {
        // Direct CLI reads need not contain a notification marker or a hook.
        // The assigned chat's explicit receipt ties this feedback to its live
        // turn, without selecting a Goal or defining an output time interval.
        if(bindTurn){
          const {data}=await client.request('thread/turns/list',{threadId,limit:1,itemsView:'notLoaded'});
          const turn=data?.[0];
          if(turn&&turn.completedAt==null&&['inProgress','interrupted'].includes(turn.status))
            state=await persist(state,state.status,{turnId:turn.id});
        }
        return captureWork(state, workReader(client));
      }); }
      catch { /* Receiving feedback must not fail because progress is unavailable. */ }
    }
    return state;
  });
}
