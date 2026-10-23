import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {dataDirectory} from './data-directory.mjs';
import {claudeEntryPaths,desktopPausesIdle,holdRunning,identifyClaudeCaller,validEntry,waiterRefreshMs,waiterRunning} from './claude-entry.mjs';
import {readJson,withStoreLock,writeJsonAtomically} from './storage.mjs';
import {claimClaudeFeedbackForWatcher,hasSavedClaudeFeedback} from './claude-actions.mjs';
import {command} from './chill-command.mjs';
import {createClaudeFeedbackReader} from './claude-feedback-cache.mjs';
import {wakeDue} from './claude-wake.mjs';
import {observedClaudeWork} from './claude-agent-work.mjs';
import {listGoals} from './goal-store.mjs';
import {watcherTimeoutSeconds} from './claude-setup.mjs';
import {hidden} from './hidden-failure.mjs';

const owner=record=>({harnessId:record.harnessId,sessionId:record.sessionId,contextId:record.contextId});
const owns=async connection=>(await listGoals()).some(g=>!g.parentId&&g.connection?.harnessId===connection.harnessId&&g.connection.sessionId===connection.sessionId&&g.connection.contextId===connection.contextId);

// One watcher per conversation detects saved Web feedback and due checks.
// As the watcher hook (asyncRewake on SessionStart and Stop), it follows the
// session across compact and clear, claims the feedback like a tool hook and
// returns the text Claude Code wakes the model with. As the older background
// task (connection wait) of a setup without the hook, it stays with one context
// and only detects; the inbox or a tool hook offers it. A hook watcher takes
// over from such a task. In Claude Desktop, which pauses an idle conversation
// unless a task runs, the task only holds the conversation (its own record
// entry, hold) and leaves watching to the hook.
// File I/O that never settled once left a waiter alive and silent for hours: its
// task looked running, so nothing woke the conversation or started another
// waiter. A watcher that stops checking ends as stalled, and its stale refresh
// lets the next waiter take over.
export const watcherStallMs=5*60*1000;
export async function watchClaudeConversation({stallMs=watcherStallMs,...options}={}) {
  let checkedAt=Date.now(),timer;
  const stalled=new Promise(resolve=>{timer=setInterval(()=>{if(Date.now()-checkedAt>=stallMs)resolve({status:'stalled'});},Math.min(stallMs,10000));});
  try { return await Promise.race([watch({...options,check:()=>{checkedAt=Date.now();}}),stalled]); }
  finally { clearInterval(timer); }
}

async function watch({check,sessionId,hook=false,hold=false,attached=()=>true,directory=dataDirectory(),pollMs=2000,now=Date.now,signal,refreshMs=waiterRefreshMs,livenessMs=waiterRefreshMs*2+5000,maxMs=(watcherTimeoutSeconds-600)*1000}={}) {
  const location=claudeEntryPaths(directory,sessionId);
  const id=randomUUID(),startedAt=now();
  // The hook and the hold follow the session across compact and clear.
  const follows=hook||hold,seat=hold?'hold':'waiter';
  const contextId=follows?null:(await readJson(location.record))?.contextId;
  const update=change=>withStoreLock(location.lock,async()=>{
    const record=await readJson(location.record);
    if(!validEntry(record,sessionId))return 'gone';
    if(!follows&&record.contextId!==contextId)return 'context-changed';
    const result=change(record);
    if(result.record)await writeJsonAtomically(location.record,result.record);
    return result.status;
  });
  const mine=record=>record[seat]?.id===id;
  const running=record=>hold?holdRunning(record,now()):waiterRunning(record,now());
  // A running watcher hook also stops the older waiter guidance for this record.
  const mark=record=>hold?{...record,hold:{id,checkedAt:new Date(now()).toISOString()}}:
    {...record,waiter:{id,contextId:record.contextId,checkedAt:new Date(now()).toISOString(),...(hook?{kind:'hook'}:{})},...(hook?{hookWatcher:true}:{})};
  // The hook takes over from an older waiter task.
  const outranks=waiter=>hook&&waiter.kind!=='hook';
  const claim=(record,other)=>{
    if(other?(record[seat]?.id!==other.id||record[seat].checkedAt!==other.checkedAt):(running(record)&&!mine(record)&&!(seat==='waiter'&&outranks(record.waiter))))return {status:'already-running'};
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
      check();
      if(signal?.aborted)return {status:'stopped'};
      const current=(await readJson(location.record))?.[seat];
      if(!current){claimed=await update(record=>claim(record));continue;}
      if(other&&(current.id!==other.id||current.checkedAt!==other.checkedAt))return {status:'already-running'};
      other??=current;
      if(now()-since>=livenessMs)claimed=await update(record=>claim(record,other));
      else await sleep();
    }
  }
  if(claimed!=='waiting')return {status:claimed};
  let refreshedAt=now(),checkOwner=follows;
  // Refreshes the record entry when due: true once checked, a result to end with.
  const refresh=async()=>{
    if(now()-refreshedAt<refreshMs)return false;
    const status=await update(r=>mine(r)?{status:'waiting',record:{...r,[seat]:{...r[seat],checkedAt:new Date(now()).toISOString()}}}:{status:'replaced'});
    if(status==='waiting'){refreshedAt=now();checkOwner=follows;return true;}
    return status==='replaced'||{status};
  };
  try {
    const readEvents=createClaudeFeedbackReader();
    for(;;) {
      check();
      if(signal?.aborted)return {status:'stopped'};
      // A watcher whose Claude Code process ended must not claim feedback nobody receives.
      if(!attached())return {status:'detached'};
      const record=await readJson(location.record);
      if(!validEntry(record,sessionId))return {status:'gone'};
      if(!follows&&record.contextId!==contextId)return {status:'context-changed'};
      if(!mine(record)){
        // A new context (clear, fork) starts without a waiter: keep watching it.
        if(!follows||running(record))return {status:'replaced'};
        if(await update(r=>mine(r)||running(r)?{status:'replaced'}:{status:'waiting',record:mark(r)})!=='waiting')return {status:'replaced'};
        checkOwner=true;continue;
      }
      // A conversation that owns no Goal has nothing to wait for. Its next
      // Stop starts a watcher again, for example after it creates one.
      if(checkOwner){if(!await owns(owner(record)))return {status:'not-owner'};checkOwner=false;}
      // The hold only keeps Desktop from pausing the conversation; the hook watches.
      if(hold){const ended=await refresh();if(ended?.status)return ended;if(!ended)await sleep();continue;}
      // While a response runs, only feedback it takes at its next step wakes it; the rest waits for its end.
      const {work}=await observedClaudeWork(record),midTurn=work.phase==='working';
      if(await hasSavedClaudeFeedback(owner(record),{readEvents,midTurn,startedAt:work.startedAt})){
        if(!hook)return {status:'feedback'};
        if(!attached())return {status:'detached'};
        const text=await claimClaudeFeedbackForWatcher(sessionId,{midTurn});
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
      const ended=await refresh();if(ended?.status)return ended;if(ended)continue;
      await sleep();
    }
  } finally {
    await update(r=>{if(!mine(r))return {status:'kept'};const next={...r};delete next[seat];return {status:'released',record:next};}).catch(hidden('claude-wait.release'));
  }
}

// The background task. In Claude Desktop with the watcher hook it holds the
// conversation and the hook hands the feedback; in a setup without the hook it
// is the waiter.
export async function waitForClaudeFeedback({env=process.env,directory=dataDirectory(),...options}={}) {
  const {sessionId}=(await identifyClaudeCaller({env,directory})).identity;
  const hold=desktopPausesIdle(env)&&(await readJson(claudeEntryPaths(directory,sessionId).record))?.hookWatcher===true;
  const result=await watchClaudeConversation({...options,directory,sessionId,hold});
  return hold?{...result,hold}:result;
}

// What the watcher hook wakes the model with; empty when it should not wake.
export function watcherWakeText({status,reason='',text=''}) {
  if(status==='feedback')return text;
  if(status==='wake')return `chill-agent: the check you scheduled is due${reason?` (${reason})`:''}. Do it now. If you still need to wait, schedule another: ${command()} connection wake --in <minutes> --reason '<what you wait for>'`;
  if(status==='idle')return 'chill-agent: a routine check after a week without Web input. Nothing to do; Web replies keep reaching this conversation.';
  if(status==='stalled')return `chill-agent: the reply watcher stopped responding and ended. Check for Web feedback from the main Bash tool: ${command()} connection inbox`;
  return '';
}

export function waitResultText({status,reason='',hold=false}) {
  if(hold){
    if(status==='already-running')return 'chill-agent: a task already keeps this conversation receiving Web replies. Nothing to do.';
    if(status==='replaced')return 'chill-agent: another task took over keeping this conversation receiving Web replies. Nothing to do.';
    if(status==='not-owner')return 'chill-agent: this conversation owns no Goal, so nothing needs to keep it running. Nothing to do.';
    return `chill-agent: the task that keeps Claude Desktop from pausing this conversation ended, so Web replies may wait until it is opened again. Start it again as a background task: ${command()} connection wait`;
  }
  if(status==='wake')return `chill-agent: the check you scheduled is due${reason?` (${reason})`:''}.
1. Do that check now and continue the work. If you still need to wait, schedule another check: ${command()} connection wake --in <minutes> --reason '<what you wait for>'
2. When finished, start the waiter again as a background task: ${command()} connection wait`;
  if(status==='feedback')return `chill-agent: new Web feedback is saved for this conversation.
1. Read and claim it from the main Bash tool: ${command()} connection inbox
2. When finished, start the waiter again as a background task: ${command()} connection wait`;
  if(status==='stalled')return `chill-agent: the reply waiter stopped responding and ended.
1. Check for Web feedback from the main Bash tool: ${command()} connection inbox
2. Start the waiter again as a background task: ${command()} connection wait`;
  if(status==='already-running')return 'chill-agent: a reply waiter is already running for this conversation. Nothing to do.';
  if(status==='replaced')return 'chill-agent: another reply waiter took over for this conversation. Nothing to do.';
  if(status==='stopped')return 'chill-agent: the reply waiter stopped. Start it again as a background task if this conversation should keep receiving Web replies.';
  return 'chill-agent: this conversation context changed. Start the waiter from the current conversation if it owns Goals.';
}
