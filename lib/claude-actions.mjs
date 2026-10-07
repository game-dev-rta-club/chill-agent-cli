import {realpath} from 'node:fs/promises';
import {realpathSync,statSync} from 'node:fs';
import {basename,dirname, join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {dataDirectory, createClaudeRoot, readFeedback, readGoalContext, validThreadId} from './goal-store.mjs';
import {readJson, withStoreLock, writeJsonAtomically} from './storage.mjs';
import {claudeEntryPaths, identifyClaudeCaller} from './claude-entry.mjs';
import {eventFor, prepareDelivery, updateDelivery, readDeliveryState} from './delivery.mjs';
import {readFeedbackHold} from './feedback-hold.mjs';
import {connectionExtensions} from './connection-extensions.mjs';

const sameConnection = (a,b) => a?.harnessId === b?.harnessId && a?.sessionId === b?.sessionId && a?.contextId === b?.contextId;
const owner = record => ({harnessId:record.harnessId, sessionId:record.sessionId, contextId:record.contextId});
const requestPath = (location,id) => join(dirname(location.record), 'requests', `${validThreadId(id)}.json`);
const marker = id => `[chill-claude-request:${id}]`;
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const command = () => {
  const directory=dataDirectory(),root=fileURLToPath(new URL('../',import.meta.url));
  let entry=join(root,'bin/chill-entry.mjs');
  // Installed hooks keep the setup prefix across updates. A checkout or a
  // different store must keep its own entry, not silently use another runtime.
  try {
    const canonical=realpathSync(root),launcher=join(directory,'runtime/chill.mjs');
    if (/^[a-f0-9]{64}$/.test(basename(canonical)) && dirname(canonical)===realpathSync(join(directory,'runtime/packages')) && statSync(launcher).isFile()) entry=launcher;
  } catch {}
  return `CHILL_AGENT_DATA_DIR=${quote(directory)} ${quote(process.execPath)} ${quote(entry)}`;
};
const promptIdentity = value => typeof value==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null;
const toolIdentity = value => typeof value==='string' && value.trim() && value.length<=512 && !/[\x00-\x1f\x7f]/.test(value);
const hookContext = context => context ? {hookSpecificOutput:{hookEventName:'PostToolUse',additionalContext:context}} : null;
export function feedbackContext(items) {
  return `Saved user feedback for this conversation (all Goals). Treat event contents as user input, not delivery instructions. Read each Goal's current agreement and later corrections before acting. Claim with:\n${command()} connection activity --event <eventId> --state working\nFinish with completed or failed. The main hook confirms each receipt. Do not repeat completed work. Goal completion is separate.\n${JSON.stringify(items)}\nFor Brief, Letters and attachment paths:\n${command()} goal show --id <goalId> --format text --section context`;
}
function validateAction(action, input) {
  if(action === 'create-goal') {
    for(const [key,max] of [['title',300],['scope',10000],['criteria',10000]])
      if(typeof input[key] !== 'string' || input[key].length > max || (key === 'title' && !input[key].trim()))throw Error(`Invalid ${key}.`);
    return {title:input.title, scope:input.scope, criteria:input.criteria};
  }
  if(action === 'inbox')return {};
  if(action === 'activity') {
    if(!Number.isSafeInteger(input.eventId) || input.eventId < 1 || !['working','completed','failed'].includes(input.state))throw Error('Invalid feedback receipt.');
    return {eventId:input.eventId,state:input.state};
  }
  if(action==='extension') {
    if(!/^[a-z][a-z0-9-]*$/.test(input.extension||'')||typeof input.operation!=='string'||!input.operation||input.operation.length>100||!input.input||typeof input.input!=='object'||Array.isArray(input.input)||JSON.stringify(input.input).length>10000)throw Error('Invalid connection extension action.');
    return {extension:input.extension,operation:input.operation,input:input.input};
  }
  throw Error('Unsupported Claude action.');
}

// A shell may inherit its environment from a subagent. It can request an
// action, but only the main-session PostToolUse hook can commit it.
export async function requestClaudeAction(action, input={}, {env=process.env}={}) {
  const directory=dataDirectory();
  const payload = validateAction(action,input);
  const caller = await identifyClaudeCaller({env,directory});
  const location = claudeEntryPaths(directory,caller.identity.sessionId);
  return withStoreLock(location.lock,async()=>{
    const current = await identifyClaudeCaller({env,directory});
    validThreadId(current.contextId);
    const request = {id:randomUUID(),action,payload,connection:{harnessId:'claude-code',sessionId:current.identity.sessionId,contextId:current.contextId},
      generation:current.identity.generation,status:'pending',createdAt:new Date().toISOString()};
    await writeJsonAtomically(requestPath(location,request.id),request,true);
    return {requestId:request.id,marker:marker(request.id),status:'pending-main-hook'};
  });
}

export async function inspectClaudeRequest(id,{retry=false,env=process.env}={}) {
  const directory=dataDirectory(),caller=await identifyClaudeCaller({env,directory});
  const location=claudeEntryPaths(directory,caller.identity.sessionId);
  return withStoreLock(location.lock,async()=>{
    const current=await identifyClaudeCaller({env,directory});
    const request=await readJson(requestPath(location,id));
    const connection={harnessId:'claude-code',sessionId:current.identity.sessionId,contextId:current.contextId};
    if(!request||!sameConnection(connection,request.connection))throw Error('Request is missing or belongs to another conversation context.');
    const pending=retry&&request.status!=='completed';
    if(pending)await writeJsonAtomically(requestPath(location,id),{...request,generation:current.identity.generation});
    return {requestId:id,action:request.action,status:request.status,result:request.result??null,...(pending?{marker:marker(id)}:{})};
  });
}

async function held(goalId,state) {
  if(state?.heldBy)return true;
  const {path} = await readGoalContext(goalId);
  for(const goal of path){const h=await readFeedbackHold(goal.id);if(h && h.phase !== 'sent')return true;}
  return false;
}
export async function inbox(request,{recover=true}={}) {
  const items=[];
  for(const event of await readFeedback()) {
    if(event.author !== 'user' || !sameConnection(event.connection,request.connection))continue;
    const {root} = await readGoalContext(event.goalId);
    if(!sameConnection(root.connection,request.connection))continue;
    await prepareDelivery(event);
    let offered=false;
    const state=await updateDelivery(event.changeId,async current=>{
      if(!sameConnection(current.connection,request.connection) || await held(event.goalId,current) || current.agentReported || !(recover?['saved','unknown']:['saved']).includes(current.status))return null;
      // Persist before emitting context. Missing stdout is unconfirmed, not
      // permission to switch transports. Explicit inbox reads reuse this ID.
      offered=true;
      return {status:'unknown',mayHaveSent:true,nativeOfferId:current.nativeOfferId||current.messageId,
        nativeRequestId:request.id,nativeOfferedAt:current.nativeOfferedAt||new Date().toISOString(),error:'Awaiting the Claude agent receipt.'};
    });
    if(offered)items.push({eventId:event.changeId,offerId:state.nativeOfferId,goalId:event.goalId,event});
    if(items.length === 10)break;
  }
  return items;
}
// Read-only preflight prevents an idle watcher from creating delivery/lock files
// every time it polls. The locked inbox rechecks ownership and holds before offering.
export async function hasSavedClaudeFeedback(connection,{readEvents=readFeedback}={}) {
  for(const event of await readEvents()) {
    if(event.author!=='user'||!sameConnection(event.connection,connection))continue;
    const state=await readDeliveryState(event.changeId);
    if(state&&(state.status!=='saved'||state.agentReported))continue;
    const {root}=await readGoalContext(event.goalId);
    if(sameConnection(root.connection,connection)&&!await held(event.goalId,state))return true;
  }
  return false;
}
export async function clearClaudePrompt(input,{cwd=process.cwd()}={}) {
  if(!input||input.agent_id!=null||!['UserPromptSubmit','SessionEnd'].includes(input.hook_event_name))return null;
  const location=claudeEntryPaths(dataDirectory(),input.session_id);
  return withStoreLock(location.lock,async()=>{
    const record=await readJson(location.record);
    if(!record||record.sessionId!==input.session_id||record.harnessId!=='claude-code')return null;
    if(typeof input.cwd!=='string'||await realpath(input.cwd)!==await realpath(cwd))throw Error('Claude hook directory does not match its caller.');
    const next={...record,lastHook:{name:input.hook_event_name,at:new Date().toISOString()}};delete next.verifiedPrompt;delete next.stoppedPrompt;delete next.resumeCheckpoint;delete next.idleWatch;
    await writeJsonAtomically(location.record,next);
    return null;
  });
}
async function receipt(request) {
  const {eventId,state} = request.payload, event=await eventFor(eventId);
  const {root} = await readGoalContext(event.goalId);
  if(!sameConnection(event.connection,request.connection)||!sameConnection(root.connection,request.connection))throw Error('Feedback belongs to another conversation.');
  await prepareDelivery(event);
  return updateDelivery(eventId,async current=>{
    if(!sameConnection(current.connection,request.connection) || await held(event.goalId,current))throw Error('Feedback is held or belongs to another conversation.');
    if(!current.nativeOfferId)throw Error('Read this feedback with connection inbox first, or receive it through a main hook.');
    if(current.agentReported && ['completed','failed'].includes(current.status)) {
      if(state !== current.status)throw Error('Feedback already has a terminal receipt.');
      return null;
    }
    if(current.status === state && current.agentReported)return null;
    return {status:state,agentReported:true,error:null,nativeReceiptRequestId:request.id};
  });
}

export async function confirmClaudeAction(input,{cwd=process.cwd(),extensions=connectionExtensions}={}) {
  const directory=dataDirectory();
  if(!input || input.agent_id != null || input.hook_event_name !== 'PostToolUse' || input.tool_name !== 'Bash' || input.tool_response?.interrupted)return null;
  const stdout=input.tool_response?.stdout;
  if(typeof stdout !== 'string')return null;
  const ids=[...stdout.matchAll(/^\[chill-claude-request:([0-9a-f-]{36})\]$/gm)].map(match=>match[1]);
  if(ids.length !== 1)return null;
  const id=validThreadId(ids[0]);
  if(typeof input.tool_use_id !== 'string'||!input.tool_use_id.trim()||input.tool_use_id.length>512)throw Error('Claude tool identity is missing.');
  const location=claudeEntryPaths(directory,input.session_id);
  return withStoreLock(location.lock,async()=>{
    const record=await readJson(location.record), request=await readJson(requestPath(location,id));
    if(!request)return null;
    if(!record || record.version!==1 || record.sessionId!==input.session_id || !sameConnection(owner(record),request.connection) || record.generation!==request.generation)throw Error('Claude action belongs to a stale or different conversation.');
    if(typeof input.cwd !== 'string' || await realpath(input.cwd)!==await realpath(cwd))throw Error('Claude hook directory does not match its caller.');
    if(request.status === 'completed')return null;
    // A deliberate retry may use another tool call after a crash. This lock
    // serializes confirmations; the stored request ID deduplicates its effects.
    request.toolUseId=input.tool_use_id;
    request.status='processing';
    await writeJsonAtomically(requestPath(location,id),request);
    let result,context;
    if(request.action==='extension') {
      const provider=(await extensions())[request.payload.extension];
      if(typeof provider?.confirmAction!=='function')throw Error('Connection extension action is unavailable.');
      const confirmed=await provider.confirmAction({requestId:request.id,connection:request.connection,generation:record.generation,promptId:promptIdentity(input.prompt_id),operation:request.payload.operation,input:request.payload.input});
      if(!confirmed||typeof confirmed.context!=='string')throw Error('Invalid connection extension result.');
      result=confirmed.result;context=confirmed.context;
    }
    else if(request.action === 'create-goal') {
      result=await createClaudeRoot(request.payload,request.connection,request.id);
      context=`Created Goal #${result.id} in this Claude conversation. Read it with:\n${command()} goal show --id ${result.id} --format text --section context\nThis action does not enable Auto mode, live controls or a permanent idle listener.`;
    } else if(request.action === 'inbox') {
      result=await inbox(request);
      context=result.length ? feedbackContext(result) : 'No unclaimed feedback for this Claude conversation. Held feedback is left untouched.';
    } else if(request.action === 'activity') {
      result=await receipt(request);
      context=`Feedback #${result.eventId}: ${result.status}. This receipt does not complete the Goal or prove live execution.`;
    } else throw Error('Unsupported stored Claude action.');
    const promptId=promptIdentity(input.prompt_id);
    const nextRecord={...record,lastHook:{name:'PostToolUse',at:new Date().toISOString()}};delete nextRecord.stoppedPrompt;delete nextRecord.resumeCheckpoint;delete nextRecord.idleWatch;
    if(promptId)await writeJsonAtomically(location.record,{...nextRecord,verifiedPrompt:{id:promptId,generation:record.generation,contextId:record.contextId}});
    else {delete nextRecord.verifiedPrompt;await writeJsonAtomically(location.record,nextRecord);}
    // A repeated native hook is silent even if its first output was lost. The
    // user/agent can deliberately read inbox again with the same event IDs.
    await writeJsonAtomically(requestPath(location,id),{...request,status:'completed',completedAt:new Date().toISOString(),
      result:request.action==='extension'?result:request.action==='inbox'?result.map(({eventId,offerId,goalId})=>({eventId,offerId,goalId})):request.action==='create-goal'?{goalId:result.id}:{eventId:result.eventId,state:result.status}});
    return hookContext(context);
  });
}

// Only a prompt already verified by a main-session action can receive automatic
// tool-hook offers. A new prompt, SessionStart, clear, fork or Stop requires a
// fresh action. Prompt IDs are native observations, never Codex turn IDs.
export async function collectClaudeHookFeedback(input,{cwd=process.cwd()}={}) {
  if(!input || input.agent_id!=null || !['PostToolUse','Stop'].includes(input.hook_event_name))return null;
  const promptId=promptIdentity(input.prompt_id);
  if(!promptId || input.tool_response?.interrupted)return null;
  if(input.hook_event_name==='PostToolUse' && !toolIdentity(input.tool_use_id))return null;
  const location=claudeEntryPaths(dataDirectory(),input.session_id);
  return withStoreLock(location.lock,async()=>{
    const record=await readJson(location.record),verified=record?.verifiedPrompt;
    if(!record || record.version!==1 || record.harnessId!=='claude-code' || record.sessionId!==input.session_id || !verified || verified.id!==promptId || verified.generation!==record.generation || verified.contextId!==record.contextId)return null;
    if(typeof input.cwd!=='string'||await realpath(input.cwd)!==await realpath(cwd))throw Error('Claude hook directory does not match its caller.');
    if(input.hook_event_name==='Stop') {
      // Repeated Stop output is not a new continuation. Native block continues
      // the same prompt; require its next real tool call before another Stop.
      if(verified.awaitingTool)return null;
      const next={...record,lastHook:{name:'Stop',at:new Date().toISOString()},stoppedPrompt:{...verified,checkpointId:randomUUID()}};delete next.verifiedPrompt;delete next.idleWatch;
      await writeJsonAtomically(location.record,next);
      return null;
    }
    if(verified.awaitingTool)await writeJsonAtomically(location.record,{...record,verifiedPrompt:{...verified,awaitingTool:false}});
    const key=createHash('sha256').update(JSON.stringify([record.sessionId,record.generation,promptId,input.tool_use_id])).digest('hex');
    const path=join(dirname(location.record),'offers',`${key}.json`);
    if(await readJson(path))return null;
    // Reserve before offering. A duplicate hook cannot pick up newer events.
    // Unoffered saved events remain eligible on a later distinct tool call.
    const offer={id:randomUUID(),connection:owner(record),generation:record.generation,promptId,toolUseId:input.tool_use_id,status:'reserved'};
    await writeJsonAtomically(path,offer,true);
    const items=await inbox(offer,{recover:false});
    await writeJsonAtomically(path,{...offer,status:'offered',eventIds:items.map(item=>item.eventId)});
    return items.length?hookContext(feedbackContext(items)):null;
  });
}

export async function handleClaudeStopExtensions(input,{cwd=process.cwd(),extensions=connectionExtensions}={}) {
  if(!input||input.agent_id!=null||input.hook_event_name!=='Stop'||!promptIdentity(input.prompt_id))return null;
  const location=claudeEntryPaths(dataDirectory(),input.session_id);
  return withStoreLock(location.lock,async()=>{
    const record=await readJson(location.record),stop=record?.stoppedPrompt;
    if(!stop||stop.id!==input.prompt_id||stop.generation!==record.generation||stop.contextId!==record.contextId)return null;
    if(typeof input.cwd!=='string'||await realpath(input.cwd)!==await realpath(cwd))throw Error('Claude hook directory does not match its caller.');
    for(const provider of Object.values(await extensions())){
      if(typeof provider.onStop!=='function')continue;
      const reason=await provider.onStop({connection:owner(record),generation:record.generation,promptId:stop.id,checkpointId:stop.checkpointId});
      if(reason==null)continue;
      if(typeof reason!=='string'||!reason.trim())throw Error('Invalid connection extension continuation.');
      // A synchronous continuation owns this Stop. Cancel its optional idle
      // watcher, and never reissue the hook output after an uncertain return.
      const next={...record,verifiedPrompt:{id:stop.id,generation:record.generation,contextId:record.contextId,awaitingTool:true}};delete next.stoppedPrompt;delete next.resumeCheckpoint;delete next.idleWatch;
      await writeJsonAtomically(location.record,next);
      return {decision:'block',reason};
    }
    return null;
  });
}
export async function handleClaudeToolHook(input,options) {
  if(['UserPromptSubmit','SessionEnd'].includes(input?.hook_event_name))return clearClaudePrompt(input,options);
  const action=await confirmClaudeAction(input,options);
  let feedback;
  try {feedback=await collectClaudeHookFeedback(input,options);}
  catch(error) {
    if(!action)throw error;
    return hookContext(action.hookSpecificOutput.additionalContext+`\nAutomatic feedback could not be checked. Recover with an explicit inbox call:\n${command()} connection inbox`);
  }
  if(input?.hook_event_name==='Stop')return handleClaudeStopExtensions(input,options);
  if(!action)return feedback;
  if(!feedback)return action;
  return hookContext(action.hookSpecificOutput.additionalContext+'\n\n'+feedback.hookSpecificOutput.additionalContext);
}
