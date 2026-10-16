import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {dataDirectory} from './data-directory.mjs';
import {claudeEntryPaths,identifyClaudeCaller,validEntry,waiterRefreshMs,waiterRunning} from './claude-entry.mjs';
import {readJson,withStoreLock,writeJsonAtomically} from './storage.mjs';
import {claimClaudeFeedbackForWatcher,command,hasSavedClaudeFeedback} from './claude-actions.mjs';
import {createClaudeFeedbackReader} from './claude-feedback-cache.mjs';
import {wakeDue} from './claude-wake.mjs';
import {listGoals} from './goal-store.mjs';
import {watcherTimeoutSeconds} from './claude-setup.mjs';

const owner=record=>({harnessId:record.harnessId,sessionId:record.sessionId,contextId:record.contextId});
const owns=async connection=>(await listGoals()).some(g=>!g.parentId&&g.connection?.harnessId===connection.harnessId&&g.connection.sessionId===connection.sessionId&&g.connection.contextId===connection.contextId);

// One watcher per conversation detects saved Web feedback and due checks.
// As the watcher hook (asyncRewake on SessionStart and Stop), it follows the
// session across compact and clear, claims the feedback like a tool hook and
// returns the text Claude Code wakes the model with. As the older background
// task (connection wait), it stays with one context and only detects; the
// inbox or a tool hook offers it. A hook watcher takes over from such a task.
export async function watchClaudeConversation({sessionId,hook=false,attached=()=>true,directory=dataDirectory(),pollMs=2000,now=Date.now,signal,refreshMs=waiterRefreshMs,livenessMs=waiterRefreshMs*2+5000,maxMs=(watcherTimeoutSeconds-600)*1000}={}) {
  const location=claudeEntryPaths(directory,sessionId);
  const id=randomUUID(),startedAt=now();
  const contextId=hook?null:(await readJson(location.record))?.contextId;
  const update=change=>withStoreLock(location.lock,async()=>{
    const record=await readJson(location.record);
    if(!validEntry(record,sessionId))return 'gone';
    if(!hook&&record.contextId!==contextId)return 'context-changed';
    const result=change(record);
    if(result.record)await writeJsonAtomically(location.record,result.record);
    return result.status;
  });
  const mine=record=>record.waiter?.id===id;
  // A running watcher hook also stops the older waiter guidance for this record.
  const mark=record=>({...record,waiter:{id,contextId:record.contextId,checkedAt:new Date(now()).toISOString(),...(hook?{kind:'hook'}:{})},...(hook?{hookWatcher:true}:{})});
  const claim=(record,other)=>{
    if(other?(record.waiter?.id!==other.id||record.waiter.checkedAt!==other.checkedAt):(waiterRunning(record,now())&&!mine(record)&&!(hook&&record.waiter.kind!=='hook')))return {status:'already-running'};
    return {status:'waiting',record:mark(record)};
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
  let refreshedAt=now(),checkOwner=hook;
  try {
    const readEvents=createClaudeFeedbackReader();
    for(;;) {
      if(signal?.aborted)return {status:'stopped'};
      // A watcher whose Claude Code process ended must not claim feedback nobody receives.
      if(!attached())return {status:'detached'};
      const record=await readJson(location.record);
      if(!validEntry(record,sessionId))return {status:'gone'};
      if(!hook&&record.contextId!==contextId)return {status:'context-changed'};
      if(!mine(record)){
        // A new context (clear, fork) starts without a waiter: keep watching it.
        if(!hook||waiterRunning(record,now()))return {status:'replaced'};
        if(await update(r=>mine(r)||waiterRunning(r,now())?{status:'replaced'}:{status:'waiting',record:mark(r)})!=='waiting')return {status:'replaced'};
        checkOwner=true;continue;
      }
      // A conversation that owns no Goal has nothing to wait for. Its next
      // Stop starts a watcher again, for example after it creates one.
      if(checkOwner){if(!await owns(owner(record)))return {status:'not-owner'};checkOwner=false;}
      if(await hasSavedClaudeFeedback(owner(record),{readEvents})){
        if(!hook)return {status:'feedback'};
        if(!attached())return {status:'detached'};
        const text=await claimClaudeFeedbackForWatcher(sessionId);
        if(text)return {status:'feedback',text};
      }
      // A check the conversation scheduled is due: end, so it wakes, and clear it.
      if(wakeDue(record,now())){
        let reason='';
        const status=await update(r=>{if(!wakeDue(r,now()))return {status:'waiting'};reason=r.wake.reason||'';const next={...r};delete next.wake;return {status:'wake',record:next};});
        if(status==='wake')return {status:'wake',reason};
      }
      // End before Claude Code's hook timeout; the response this wakes starts the next watcher.
      if(hook&&now()-startedAt>=maxMs)return {status:'idle'};
      if(now()-refreshedAt>=refreshMs) {
        const status=await update(r=>mine(r)?{status:'waiting',record:{...r,waiter:{...r.waiter,checkedAt:new Date(now()).toISOString()}}}:{status:'replaced'});
        if(status==='waiting'){refreshedAt=now();checkOwner=hook;}
        else if(status!=='replaced')return {status};
        continue;
      }
      await sleep();
    }
  } finally {
    await update(r=>{if(!mine(r))return {status:'kept'};const next={...r};delete next.waiter;return {status:'released',record:next};}).catch(()=>{});
  }
}

// The older background task, for setups without the watcher hook.
export async function waitForClaudeFeedback({env=process.env,...options}={}) {
  const caller=await identifyClaudeCaller({env});
  return watchClaudeConversation({...options,sessionId:caller.identity.sessionId});
}

// What the watcher hook wakes the model with; empty when it should not wake.
export function watcherWakeText({status,reason='',text=''}) {
  if(status==='feedback')return text;
  if(status==='wake')return `chill-agent: the check you scheduled is due${reason?` (${reason})`:''}. Do it now. If you still need to wait, schedule another: ${command()} connection wake --in <minutes> --reason '<what you wait for>'`;
  if(status==='idle')return 'chill-agent: a routine check after a week without Web input. Nothing to do; Web replies keep reaching this conversation.';
  return '';
}

export function waitResultText({status,reason=''}) {
  if(status==='wake')return `chill-agent: the check you scheduled is due${reason?` (${reason})`:''}.
1. Do that check now and continue the work. If you still need to wait, schedule another check: ${command()} connection wake --in <minutes> --reason '<what you wait for>'
2. When finished, start the waiter again as a background task: ${command()} connection wait`;
  if(status==='feedback')return `chill-agent: new Web feedback is saved for this conversation.
1. Read and claim it from the main Bash tool: ${command()} connection inbox
2. When finished, start the waiter again as a background task: ${command()} connection wait`;
  if(status==='already-running')return 'chill-agent: a reply waiter is already running for this conversation. Nothing to do.';
  if(status==='replaced')return 'chill-agent: another reply waiter took over for this conversation. Nothing to do.';
  if(status==='stopped')return 'chill-agent: the reply waiter stopped. Start it again as a background task if this conversation should keep receiving Web replies.';
  return 'chill-agent: this conversation context changed. Start the waiter from the current conversation if it owns Goals.';
}
