import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {dataDirectory} from './data-directory.mjs';
import {claudeEntryPaths,identifyClaudeCaller,waiterRefreshMs,waiterRunning} from './claude-entry.mjs';
import {readJson,withStoreLock,writeJsonAtomically} from './storage.mjs';
import {command,hasSavedClaudeFeedback} from './claude-actions.mjs';
import {createClaudeFeedbackReader} from './claude-feedback-cache.mjs';

// Runs as a Claude background task. Exiting is the wake-up: Claude Code starts
// a turn for an idle conversation when the task ends, and keeps a session with
// a live background task from being evicted. The waiter only detects saved
// feedback; the main-hook inbox still claims and offers it.
export async function waitForClaudeFeedback({env=process.env,pollMs=2000,now=Date.now,signal}={}) {
  const caller=await identifyClaudeCaller({env});
  const connection={harnessId:'claude-code',sessionId:caller.identity.sessionId,contextId:caller.contextId};
  const location=claudeEntryPaths(dataDirectory(),connection.sessionId);
  const id=randomUUID();
  const update=change=>withStoreLock(location.lock,async()=>{
    const record=await readJson(location.record);
    if(record?.contextId!==connection.contextId)return 'context-changed';
    const result=change(record);
    if(result.record)await writeJsonAtomically(location.record,result.record);
    return result.status;
  });
  const mine=record=>record.waiter?.id===id;
  const claimed=await update(record=>{
    if(waiterRunning(record,now())&&!mine(record))return {status:'already-running'};
    return {status:'waiting',record:{...record,waiter:{id,contextId:connection.contextId,checkedAt:new Date(now()).toISOString()}}};
  });
  if(claimed!=='waiting')return {status:claimed};
  let refreshedAt=now();
  try {
    const readEvents=createClaudeFeedbackReader();
    for(;;) {
      if(signal?.aborted)return {status:'stopped'};
      const record=await readJson(location.record);
      if(record?.contextId!==connection.contextId)return {status:'context-changed'};
      if(!mine(record))return {status:'replaced'};
      if(await hasSavedClaudeFeedback(connection,{readEvents}))return {status:'feedback'};
      if(now()-refreshedAt>=waiterRefreshMs) {
        const status=await update(r=>mine(r)?{status:'waiting',record:{...r,waiter:{...r.waiter,checkedAt:new Date(now()).toISOString()}}}:{status:'replaced'});
        if(status!=='waiting')return {status};
        refreshedAt=now();
      }
      await delay(pollMs);
    }
  } finally {
    await update(r=>{if(!mine(r))return {status:'kept'};const next={...r};delete next.waiter;return {status:'released',record:next};}).catch(()=>{});
  }
}

export function waitResultText({status}) {
  if(status==='feedback')return `chill-agent: new Web feedback is saved for this conversation.
1. Read and claim it from the main Bash tool: ${command()} connection inbox
2. When finished, start the waiter again as a background task: ${command()} connection wait`;
  if(status==='already-running')return 'chill-agent: a reply waiter is already running for this conversation. Nothing to do.';
  if(status==='replaced')return 'chill-agent: another reply waiter took over for this conversation. Nothing to do.';
  return 'chill-agent: this conversation context changed. Start the waiter from the current conversation if it owns Goals.';
}
