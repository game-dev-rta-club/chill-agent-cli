import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {dataDirectory} from './data-directory.mjs';
import {claudeEntryPaths,identifyClaudeCaller,waiterRefreshMs,waiterRunning} from './claude-entry.mjs';
import {readJson,withStoreLock,writeJsonAtomically} from './storage.mjs';
import {command,hasSavedClaudeFeedback} from './claude-actions.mjs';
import {createClaudeFeedbackReader} from './claude-feedback-cache.mjs';
import {wakeDue} from './claude-wake.mjs';

// Runs as a Claude background task. Exiting is the wake-up: Claude Code starts
// a turn for an idle conversation when the task ends, and keeps a session with
// a live background task from being evicted. The waiter only detects saved
// feedback; the main-hook inbox still claims and offers it.
// A response counts as running only while its prompt is checked in and a tool
// hook ran recently; an interrupted response stops counting after activeMs.
export const responseRunning=(record,at,activeMs)=>{
  const verified=record?.verifiedPrompt;
  return !!verified&&verified.generation===record.generation&&verified.contextId===record.contextId&&at-Date.parse(record.lastToolAt||0)<activeMs;
};
export async function waitForClaudeFeedback({env=process.env,pollMs=2000,now=Date.now,signal,refreshMs=waiterRefreshMs,livenessMs=waiterRefreshMs*2+5000,activeMs=5*60_000}={}) {
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
  const claim=(record,other)=>{
    if(other?(record.waiter?.id!==other.id||record.waiter.checkedAt!==other.checkedAt):(waiterRunning(record,now())&&!mine(record)))return {status:'already-running'};
    return {status:'waiting',record:{...record,waiter:{id,contextId:connection.contextId,checkedAt:new Date(now()).toISOString()}}};
  };
  const sleep=()=>delay(pollMs,undefined,{signal}).catch(()=>{});
  let claimed=await update(record=>claim(record));
  // A waiter that was killed leaves a fresh-looking refresh behind. Watch it
  // for two refresh periods: a live one advances; a dead one is taken over, so
  // a restart right after a stop never leaves the conversation without a waiter.
  if(claimed==='already-running'){
    let other=null;const since=now();
    while(claimed==='already-running'){
      if(signal?.aborted)return {status:'stopped'};
      const current=(await readJson(location.record))?.waiter;
      if(!current){claimed=await update(record=>claim(record));continue;}
      if(other&&(current.id!==other.id||current.checkedAt!==other.checkedAt))return {status:'already-running'};
      other??=current;
      if(now()-since>=livenessMs)claimed=await update(record=>claim(record,other));
      else await sleep();
    }
  }
  if(claimed!=='waiting')return {status:claimed};
  let refreshedAt=now();
  try {
    const readEvents=createClaudeFeedbackReader();
    for(;;) {
      if(signal?.aborted)return {status:'stopped'};
      const record=await readJson(location.record);
      if(record?.contextId!==connection.contextId)return {status:'context-changed'};
      if(!mine(record))return {status:'replaced'};
      // While a checked-in response keeps calling tools, its next tool hook
      // offers the feedback; ending here would only cost a waiter restart.
      // Stop, a new prompt or a quiet spell lets the waiter wake as before.
      if(!responseRunning(record,now(),activeMs)&&await hasSavedClaudeFeedback(connection,{readEvents}))return {status:'feedback'};
      // A check the conversation scheduled is due: end, so it wakes, and clear it.
      if(wakeDue(record,now())){
        let reason='';
        // The due check stays on the record until the inbox reports it, so the
        // conversation need not read this task's output to learn why it woke.
        const status=await update(r=>{if(!wakeDue(r,now()))return {status:'waiting'};reason=r.wake.reason||'';const next={...r,dueCheck:{reason,at:r.wake.at}};delete next.wake;return {status:'wake',record:next};});
        if(status==='wake')return {status:'wake',reason};
      }
      if(now()-refreshedAt>=refreshMs) {
        const status=await update(r=>mine(r)?{status:'waiting',record:{...r,waiter:{...r.waiter,checkedAt:new Date(now()).toISOString()}}}:{status:'replaced'});
        if(status!=='waiting')return {status};
        refreshedAt=now();
      }
      await sleep();
    }
  } finally {
    await update(r=>{if(!mine(r))return {status:'kept'};const next={...r};delete next.waiter;return {status:'released',record:next};}).catch(()=>{});
  }
}

export function waitResultText({status,reason=''}) {
  const next=`In one response, run ${command()} connection inbox (it shows saved feedback and any due check)
and start the waiter again as a background task: ${command()} connection wait`;
  if(status==='wake')return `chill-agent: the check you scheduled is due${reason?` (${reason})`:''}.\n${next}\nIf you still need to wait after the check, schedule another: ${command()} connection wake --in <minutes> --reason '<what you wait for>'`;
  if(status==='feedback')return `chill-agent: new Web feedback is saved for this conversation.\n${next}`;
  if(status==='already-running')return 'chill-agent: a reply waiter is already running for this conversation. Nothing to do.';
  if(status==='replaced')return 'chill-agent: another reply waiter took over for this conversation. Nothing to do.';
  if(status==='stopped')return 'chill-agent: the reply waiter stopped. Start it again as a background task if this conversation should keep receiving Web replies.';
  return 'chill-agent: this conversation context changed. Start the waiter from the current conversation if it owns Goals.';
}
