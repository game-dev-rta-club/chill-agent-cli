// Codex's delivery transport: feedback is pushed into the chat's native
// Queue, its hooks pick up what the Queue missed, and receipts claim the
// Queue entry and bind the live turn for Think.
import {workspacePort} from '../project-workspace.mjs';
import {readFeedback, readGoalContext, readOpenLetters, validThreadId} from '../goal-store.mjs';
import {withCodex} from '../codex-client.mjs';
import {workReader, needsWorkRefresh} from '../work-output.mjs';
import {notificationReminder} from '../notification-reminder.mjs';
import {listDeliveries, locked, notificationText, persist, readDeliveryState, writeDeliveryQuietly} from '../delivery.mjs';
import {recordHidden} from '../hidden-failure.mjs';

async function captureWork(state, readWork) {
  if (!needsWorkRefresh(state)) return state;
  let extra;
  try {
    const work = await readWork(state);
    extra = {...(work ? {work} : {}), workTracking: true, workError: null};
  }
  catch (error) { recordHidden('codex-delivery.progress', error); extra = {workError: 'Progress updates are unavailable.'}; }
  if (JSON.stringify(state.work) === JSON.stringify(extra.work ?? state.work) && state.workError === extra.workError && state.workTracking) return state;
  const next = {...state, ...extra};
  await writeDeliveryQuietly(next);
  return next;
}

const outputRefreshes = new Map();
export async function refreshCodexWorkOutputs(goalId) {
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
    } catch (error) { recordHidden('codex-delivery.refresh', error); /* Preserve delivery and any last readable output if Codex is unavailable. */ }
  })();
  entry.promise = promise.finally(() => { entry.done = true; });
  outputRefreshes.set(goalId, entry);
  return entry.promise;
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
export async function deliverCodexFeedback(id,event) {
 const {withAgentControlLock}=await import('../agent-control.mjs');
 const {deliverHeldFeedback}=await import('../feedback-hold.mjs');
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
     }catch(error){recordHidden('codex-delivery.queue-add',error);return persist(state,'unknown',{error:error.message.slice(0,400)});}
    });
   });
  });
 }catch(error){
  recordHidden('codex-delivery.send',error);
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
    recordHidden('codex-delivery.queue-clear', error);
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
      if (state.hookTurnId === turnId) return;
      // Queued feedback runs after the current turn (Waiting); Send now offers it to this one.
      if (state.status === 'queued' && state.waitForIdle && !state.sendNow) return;
      // Output might be lost if the hook is interrupted. The queue is retained
      // until activity(working), so this cannot silently consume the feedback.
      await persist(state, state.status, { hookTurnId: turnId });
      const context=await readGoalContext(state.goalId);
      pending.push({ eventId: state.eventId, goalId: state.goalId, port:state.port||4173,rootId:context.root.id,path:context.path.map(({id,title})=>({id,title})),letters:await readOpenLetters(state.goalId) });
    });
  }
  return pending;
}

export async function recordCodexActivity(id, status, threadId) {
  if (status === 'deferred') {
    validThreadId(threadId);
    const {withAgentControlLock} = await import('../agent-control.mjs');
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
      catch (error) { recordHidden('codex-delivery.receive-progress', error); /* Receiving feedback must not fail because progress is unavailable. */ }
    }
    return state;
  });
}
