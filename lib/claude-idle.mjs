import {realpath} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {dataDirectory} from './data-directory.mjs';
import {claudeEntryPaths,claudeResumeHookKey} from './claude-entry.mjs';
import {readJson,withStoreLock,writeJsonAtomically} from './storage.mjs';
import {hasSavedClaudeFeedback,inbox,feedbackContext} from './claude-actions.mjs';
import {idleCheckIntervalMs} from './claude-status.mjs';
import {createClaudeFeedbackReader} from './claude-feedback-cache.mjs';
import {defaultClaudeIdleMs,validateClaudeIdleDuration} from './claude-idle-duration.mjs';

const validPrompt=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const inactive={status:'inactive'};
const connection=r=>({harnessId:r.harnessId,sessionId:r.sessionId,contextId:r.contextId});
async function checkDirectory(input,cwd) {
  if(typeof input.cwd!=='string'||await realpath(input.cwd)!==await realpath(cwd))throw Error('Claude hook directory does not match its caller.');
}
// Both native entry paths reserve one finite watch while holding the record lock.
// They differ only in how the synchronous hook proves the checkpoint.
async function reserveWatch(location,record,checkpoint,{cwd,timeoutMs,now}) {
  const startedAt=now();
  const watch={id:randomUUID(),checkpointId:checkpoint.checkpointId,expiresAt:startedAt+timeoutMs,lastCheckedAt:startedAt,status:'watching'};
  await writeJsonAtomically(location.record,{...record,idleWatch:watch});
  return {status:'watching',ticket:{...watch,connection:connection(record),generation:record.generation,cwd:await realpath(cwd)}};
}
const validRecord=(record,input)=>record?.version===1&&record.harnessId==='claude-code'&&record.sessionId===input.session_id;
const pendingCheckpoint={status:'pending-checkpoint'};
// A sibling asynchronous hook may run before the synchronous checkpoint exists.
// Wait briefly for that race without creating a binding or renewing a watch.
export async function startClaudeResumeWatch(input,{cwd=process.cwd(),timeoutMs=defaultClaudeIdleMs,now=Date.now}={}) {
  validateClaudeIdleDuration(timeoutMs);
  if(!input||input.agent_id!=null||input.hook_event_name!=='SessionStart'||input.source!=='resume')return inactive;
  await checkDirectory(input,cwd);
  const location=claudeEntryPaths(dataDirectory(),input.session_id);
  return withStoreLock(location.lock,async()=>{
    const record=await readJson(location.record),checkpoint=record?.resumeCheckpoint;
    if(!validRecord(record,input)||!checkpoint||checkpoint.hookKey!==claudeResumeHookKey(input))return pendingCheckpoint;
    if(record.lastHook?.name!=='SessionStart'||record.idleWatch||checkpoint.generation!==record.generation||checkpoint.contextId!==record.contextId)return inactive;
    return reserveWatch(location,record,checkpoint,{cwd,timeoutMs,now});
  });
}
export async function startClaudeIdleWatch(input,{cwd=process.cwd(),timeoutMs=defaultClaudeIdleMs,now=Date.now}={}) {
  validateClaudeIdleDuration(timeoutMs);
  if(!input||input.agent_id!=null||input.hook_event_name!=='Stop'||!validPrompt(input.prompt_id))return inactive;
  await checkDirectory(input,cwd);
  const location=claudeEntryPaths(dataDirectory(),input.session_id);
  return withStoreLock(location.lock,async()=>{
    const record=await readJson(location.record);
    if(!validRecord(record,input))return inactive;
    const matches=p=>p?.id===input.prompt_id&&p.generation===record.generation&&p.contextId===record.contextId;
    if(matches(record.verifiedPrompt))return pendingCheckpoint;
    if(!matches(record.stoppedPrompt)||record.idleWatch?.checkpointId===record.stoppedPrompt.checkpointId)return inactive;
    return reserveWatch(location,record,record.stoppedPrompt,{cwd,timeoutMs,now});
  });
}
function matches(record,ticket) {
  return record?.version===1&&record.harnessId==='claude-code'&&record.sessionId===ticket.connection.sessionId&&record.contextId===ticket.connection.contextId&&record.generation===ticket.generation&&(record.stoppedPrompt||record.resumeCheckpoint)?.checkpointId===ticket.checkpointId&&record.idleWatch?.id===ticket.id&&record.idleWatch?.status==='watching';
}
export async function pollClaudeIdleWatch(ticket,{now=Date.now,readEvents}={}) {
  const location=claudeEntryPaths(dataDirectory(),ticket.connection.sessionId);
  const current=await readJson(location.record);
  if(!matches(current,ticket))return inactive;
  const checkedAt=now();
  const hasFeedback=checkedAt<current.idleWatch.expiresAt&&await hasSavedClaudeFeedback(ticket.connection,{readEvents});
  if(checkedAt<current.idleWatch.expiresAt&&!hasFeedback&&Number.isFinite(current.idleWatch.lastCheckedAt)&&checkedAt-current.idleWatch.lastCheckedAt<idleCheckIntervalMs)return {status:'watching'};
  return withStoreLock(location.lock,async()=>{
    const record=await readJson(location.record);
    if(!matches(record,ticket))return inactive;
    if(now()>=record.idleWatch.expiresAt){await writeJsonAtomically(location.record,{...record,idleWatch:{...record.idleWatch,status:'expired'}});return {status:'expired'};}
    const items=hasFeedback?await inbox({id:ticket.id,connection:ticket.connection},{recover:false}):[];
    if(!items.length){await writeJsonAtomically(location.record,{...record,idleWatch:{...record.idleWatch,lastCheckedAt:now()}});return {status:'watching'};}
    // Persist an uncertain offer before exit-2 stdout/stderr. If native delivery
    // is lost, neither another watcher nor a busy hook automatically repeats it.
    await writeJsonAtomically(location.record,{...record,idleWatch:{...record.idleWatch,lastCheckedAt:now(),status:'offered',eventIds:items.map(i=>i.eventId)}});
    return {status:'offered',context:feedbackContext(items)};
  });
}
export async function watchClaudeIdle(input,{cwd=process.cwd(),timeoutMs=defaultClaudeIdleMs}={}) {
  const start=input?.hook_event_name==='SessionStart'?startClaudeResumeWatch:startClaudeIdleWatch;
  const until=Date.now()+2000;let state;
  do {
    state=await start(input,{cwd,timeoutMs});
    if(state.status!=='pending-checkpoint')break;
    await delay(100);
  }while(Date.now()<until);
  if(state.status!=='watching')return null;
  const readEvents=createClaudeFeedbackReader();
  while(true){const next=await pollClaudeIdleWatch(state.ticket,{readEvents});if(next.status==='offered')return next.context;if(next.status!=='watching')return null;await delay(500);}
}
