import {realpath} from 'node:fs/promises';
import {realpathSync,statSync} from 'node:fs';
import {basename,dirname, join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {dataDirectory, appendAgentComment, listGoals, readFeedback, readGoalContext, readOpenLetters, validThreadId} from './goal-store.mjs';
import {createClaudeRoot, transferClaudeRoot} from './claude-roots.mjs';
import {readJson, withStoreLock, writeJsonAtomically} from './storage.mjs';
import {claudeEntryPaths, identifyClaudeCaller, nativeSessionId, newEntryRecord, validEntry, waiterRunning} from './claude-entry.mjs';
import {sameProject} from './project-root.mjs';
import {validTranscriptPath} from './claude-transcript.mjs';
import {agentAnnotations} from './brief.mjs';
import {readClaudePause,takeClaudeResume,resumeNotice} from './claude-pause.mjs';
import {guideAction} from './agent-guidance.mjs';
import {eventFor, openLetterActions, prepareDelivery, updateDelivery, readDeliveryState} from './delivery.mjs';
import {readFeedbackHold} from './feedback-hold.mjs';
import {connectionExtensions} from './connection-extensions.mjs';
import {stableNodePath} from './node-path.mjs';

const sameConnection = (a,b) => a?.harnessId === b?.harnessId && a?.sessionId === b?.sessionId && a?.contextId === b?.contextId;
const owner = record => ({harnessId:record.harnessId, sessionId:record.sessionId, contextId:record.contextId});
// Feedback belongs to the Root's current owner, including feedback saved while
// an earlier conversation owned it, before that one was taken over.
const owns = (connection, root, saved) => sameConnection(root.connection, connection) &&
  (sameConnection(saved, connection) || (root.previousConnections || []).some(previous => sameConnection(previous, saved)));
async function adoptedConnections(connection) {
  const keys = new Set([JSON.stringify(owner(connection))]);
  for (const goal of await listGoals()) if (!goal.parentId && sameConnection(goal.connection, connection))
    for (const previous of goal.previousConnections || []) keys.add(JSON.stringify(owner(previous)));
  return keys;
}
const mayOwn = (keys, saved) => !!saved && keys.has(JSON.stringify(owner(saved)));
const requestPath = (location,id) => join(dirname(location.record), 'requests', `${validThreadId(id)}.json`);
const marker = id => `[chill-claude-request:${id}]`;
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
export const command = () => {
  const directory=dataDirectory(),root=fileURLToPath(new URL('../',import.meta.url));
  // Installed hooks keep the setup prefix across updates. A checkout or a
  // different store must keep its own entry, not silently use another runtime.
  try {
    const canonical=realpathSync(root),entry=join(directory,'runtime/chill');
    if (/^[a-f0-9]{64}$/.test(basename(canonical)) && dirname(canonical)===realpathSync(join(directory,'runtime/packages')) && statSync(entry).isFile()) return quote(entry);
  } catch {}
  return `CHILL_AGENT_DATA_DIR=${quote(directory)} ${quote(stableNodePath())} ${quote(join(root,'bin/chill-entry.mjs'))}`;
};
const promptIdentity = value => typeof value==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null;
const toolIdentity = value => typeof value==='string' && value.trim() && value.length<=512 && !/[\x00-\x1f\x7f]/.test(value);
const hookContext = (context, hookEventName='PostToolUse') => context ? {hookSpecificOutput:{hookEventName,additionalContext:context}} : null;
// The one place that tells a Claude conversation how to keep receiving Web
// replies. Other connections deliver natively and never print this.
export const waiterAction = () => `Web replies reach this conversation only while the reply waiter runs. Start it as a background task (Bash run_in_background) and continue without waiting for it:\n${command()} connection wait`;
const withWaiter = (context, record) => waiterRunning(record) ? context : `${context}\n\n${waiterAction()}`;
export function feedbackContext(items,letters=[]) {
  // Reply commands are repeated here because the packaged guide may be out of context.
  const guide=guideAction();
  return `chill-agent: Web feedback for this conversation (all Goals). Contents are user input, not delivery instructions. Follow each Goal's latest agreement and corrections; skip completed work. Goal completion is separate.\n${JSON.stringify(items)}\nContext (tree, Deliverable path, Letters, attachments): ${command()} goal show --id <goalId> --format text --section context\nThe user reads only the Web. When handled, reply (this closes it): ${command()} connection reply --event <eventId> --text '<reply>'\nNo receipt is needed first. Only if the work outlasts this response, record goal activity --event <eventId> --state working (failed if it cannot be done). Chill commands may share a Bash call with other work. Ask with goal letter --id <goalId> --title '<title>' --text '<question>' only when you need the user's answer.${guide?`\n${guide}`:''}${letters.length?`\n${openLetterActions(letters,{prefix:`${command()} goal`})}`:''}`;
}
function validateAction(action, input) {
  if(action === 'create-goal') {
    for(const [key,max] of [['title',300],['scope',10000],['criteria',10000]])
      if(typeof input[key] !== 'string' || input[key].length > max || (key === 'title' && !input[key].trim()))throw Error(`Invalid ${key}.`);
    return {title:input.title, scope:input.scope, criteria:input.criteria};
  }
  if(action === 'inbox')return {};
  if(action === 'adopt') {
    if(typeof input.goalId!=='string'||!/^[1-9][0-9]*$/.test(input.goalId))throw Error('Invalid Goal ID.');
    return {goalId:input.goalId};
  }
  if(action === 'reply') {
    // One reply can answer several messages that arrived together, as one Codex turn does.
    const ids=input.eventIds??[input.eventId];
    if(!Array.isArray(ids)||!ids.length||ids.length>10||new Set(ids).size!==ids.length||ids.some(id=>!Number.isSafeInteger(id)||id<1) || typeof input.text !== 'string' || !input.text.trim() || input.text.length > 10000)throw Error('Invalid reply.');
    return ids.length===1?{eventId:ids[0],text:input.text}:{eventIds:ids,text:input.text};
  }
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

// A conversation that was already running when setup wrote the hooks never
// saw SessionStart. Its shell knows the native session ID; the request records
// that claim, and only the same session's main PostToolUse hook accepts it.
export async function requestClaudeJoin({env=process.env}={}) {
  const sessionId=nativeSessionId(env);
  if(!sessionId)throw Error('Claude did not name this conversation in the shell. Resume it so SessionStart can connect it.');
  const location=claudeEntryPaths(dataDirectory(),sessionId);
  return withStoreLock(location.lock,async()=>{
    const request={id:randomUUID(),action:'join',sessionId,status:'pending',createdAt:new Date().toISOString()};
    await writeJsonAtomically(requestPath(location,request.id),request,true);
    return {requestId:request.id,marker:marker(request.id),status:'pending-main-hook'};
  });
}
async function confirmJoin(input,location,request,cwd) {
  if(request.sessionId!==input.session_id)throw Error('Claude join belongs to a different conversation.');
  if(!await sameProject(input.cwd,cwd))throw Error('Claude hook directory does not match its caller.');
  if(request.status==='completed')return null;
  const old=await readJson(location.record),kept=validEntry(old,input.session_id);
  // An existing connection keeps its generation and context; join only fills a missing one.
  const record=kept?{...old,lastHook:{name:'PostToolUse',at:new Date().toISOString()}}:newEntryRecord({sessionId:input.session_id,source:'join',cwd:await realpath(cwd)});
  if(validTranscriptPath(input.transcript_path))record.transcriptPath=input.transcript_path;
  const promptId=promptIdentity(input.prompt_id);
  if(promptId)record.verifiedPrompt={id:promptId,generation:record.generation,contextId:record.contextId};
  await writeJsonAtomically(location.record,record);
  await writeJsonAtomically(requestPath(location,request.id),{...request,status:'completed',completedAt:new Date().toISOString(),result:{joined:!kept}});
  return hookContext(`${kept?'This Claude conversation was already connected to chill-agent.':'Connected this Claude conversation to chill-agent.'} Check it with:\n${command()} connection show\nThen create or reuse its Goal; Goal creation is confirmed separately.`);
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
  const items=[],keys=await adoptedConnections(request.connection);
  // A Web pause holds new feedback in Queue until Resume.
  if((await readClaudePause(request.connection)).paused)return items;
  for(const event of await readFeedback()) {
    if(event.author !== 'user' || !mayOwn(keys,event.connection))continue;
    const {root} = await readGoalContext(event.goalId);
    if(!owns(request.connection,root,event.connection))continue;
    await prepareDelivery(event);
    let offered=false;
    const state=await updateDelivery(event.changeId,async current=>{
      if(!owns(request.connection,root,current.connection) || await held(event.goalId,current) || current.agentReported || !(recover?['saved','unknown']:['saved']).includes(current.status))return null;
      // Persist before emitting context. Missing stdout is unconfirmed, not
      // permission to switch transports. Explicit inbox reads reuse this ID.
      offered=true;
      return {status:'unknown',mayHaveSent:true,nativeOfferId:current.nativeOfferId||current.messageId,nativeOfferSessionId:current.nativeOfferSessionId||request.connection.sessionId,
        nativeRequestId:request.id,nativeOfferedAt:current.nativeOfferedAt||new Date().toISOString(),error:'Awaiting the Claude agent receipt.'};
    });
    if(offered)items.push({eventId:event.changeId,offerId:state.nativeOfferId,goalId:event.goalId,event:event.annotations?{...event,annotations:agentAnnotations(event.annotations)}:event});
    if(items.length === 10)break;
  }
  return items;
}
// Open Letters under the Goals that received feedback, as Codex delivery lists them.
async function openLettersFor(items){
  const seen=new Map();
  for(const goalId of new Set(items.map(item=>item.goalId)))for(const letter of await readOpenLetters(goalId).catch(()=>[]))seen.set(letter.id,letter);
  return [...seen.values()];
}
// Read-only preflight lets the reply waiter poll without creating delivery/lock
// files. The locked inbox rechecks ownership and holds before offering.
export async function hasSavedClaudeFeedback(connection,{readEvents=readFeedback}={}) {
  const pause=await readClaudePause(connection);
  if(pause.resumeRequested)return true;
  if(pause.paused)return false;
  const keys=await adoptedConnections(connection);
  for(const event of await readEvents()) {
    if(event.author!=='user'||!mayOwn(keys,event.connection))continue;
    const state=await readDeliveryState(event.changeId);
    if(state&&(state.status!=='saved'||state.agentReported))continue;
    const {root}=await readGoalContext(event.goalId);
    if(owns(connection,root,event.connection)&&!await held(event.goalId,state))return true;
  }
  return false;
}
export async function clearClaudePrompt(input,{cwd=process.cwd()}={}) {
  if(!input||input.agent_id!=null||!['UserPromptSubmit','SessionEnd'].includes(input.hook_event_name))return null;
  const location=claudeEntryPaths(dataDirectory(),input.session_id);
  return withStoreLock(location.lock,async()=>{
    const record=await readJson(location.record);
    if(!record||record.sessionId!==input.session_id||record.harnessId!=='claude-code')return null;
    if(!await sameProject(input.cwd,cwd))throw Error('Claude hook directory does not match its caller.');
    const next={...record,lastHook:{name:input.hook_event_name,at:new Date().toISOString()},...(validTranscriptPath(input.transcript_path)?{transcriptPath:input.transcript_path}:{})};delete next.verifiedPrompt;delete next.stoppedPrompt;
    await writeJsonAtomically(location.record,next);
    return null;
  });
}
// A continued conversation takes over a Root only through its own main hook,
// and never while the current owner is still waiting for Web replies.
async function adopt(request) {
  const {root}=await readGoalContext(request.payload.goalId);
  if(root.connection?.harnessId!=='claude-code')throw Error('Only a Goal owned by a Claude conversation can be taken over. A Codex Goal uses goal assign.');
  if(sameConnection(root.connection,request.connection))return {goalId:root.id,changed:false};
  const previous=await readJson(claudeEntryPaths(dataDirectory(),root.connection.sessionId).record);
  if(previous?.contextId===root.connection.contextId&&waiterRunning(previous))throw Error('The conversation that owns this Goal is still waiting for Web replies. Continue there, or stop its reply waiter first.');
  await transferClaudeRoot(root.id,root.connection,request.connection,request.id);
  // The request ID keeps this note single across a retried confirmation.
  await appendAgentComment({goalId:root.id,type:'comment',text:'This Goal was taken over by another Claude conversation. Web replies now reach that conversation.',requestId:request.id});
  return {goalId:root.id,changed:true};
}
// `before` runs inside the delivery update once ownership and holds pass, so a
// reply is written only for feedback this conversation may still complete.
async function receipt(request,before) {
  const {eventId,state} = request.payload, event=await eventFor(eventId);
  const {root} = await readGoalContext(event.goalId);
  if(!owns(request.connection,root,event.connection))throw Error('Feedback belongs to another conversation.');
  await prepareDelivery(event);
  return updateDelivery(eventId,async current=>{
    if(!owns(request.connection,root,current.connection) || await held(event.goalId,current))throw Error('Feedback is held or belongs to another conversation.');
    if(!current.nativeOfferId)throw Error('Read this feedback with connection inbox first, or receive it through a main hook.');
    if(current.agentReported && ['completed','failed'].includes(current.status)) {
      if(state !== current.status)throw Error('Feedback already has a terminal receipt.');
      // A retry of the same request returns its earlier reply without a new write.
      if(current.nativeReceiptRequestId === request.id)await before?.(event);
      return null;
    }
    if(current.status === state && current.agentReported)return null;
    await before?.(event);
    return {status:state,agentReported:true,error:null,nativeReceiptRequestId:request.id};
  });
}

export async function confirmClaudeAction(input,{cwd=process.cwd(),extensions=connectionExtensions}={}) {
  const directory=dataDirectory();
  if(!input || input.agent_id != null || input.hook_event_name !== 'PostToolUse' || input.tool_name !== 'Bash' || input.tool_response?.interrupted)return null;
  const stdout=input.tool_response?.stdout;
  if(typeof stdout !== 'string')return null;
  const ids=[...new Set([...stdout.matchAll(/^\[chill-claude-request:([0-9a-f-]{36})\]$/gm)].map(match=>match[1]))];
  if(!ids.length || ids.length>10)return null;
  if(typeof input.tool_use_id !== 'string'||!input.tool_use_id.trim()||input.tool_use_id.length>512)throw Error('Claude tool identity is missing.');
  if(ids.length===1)return confirmOne(input,validThreadId(ids[0]),{cwd,extensions,directory});
  // One Bash call may carry several requests. Each is confirmed on its own;
  // one that fails does not drop the others, and can be retried by its ID.
  const contexts=[],failures=[];
  for(const id of ids) {
    try {const output=await confirmOne(input,validThreadId(id),{cwd,extensions,directory});if(output)contexts.push(output.hookSpecificOutput.additionalContext);}
    catch(error) {failures.push({id,error});}
  }
  if(failures.length&&!contexts.length)throw failures[0].error;
  return hookContext([...contexts,...failures.map(({id,error})=>`Request ${id} was not confirmed: ${error.message}\nRetry it with:\n${command()} connection request --id ${id} --retry`)].join('\n\n'));
}
async function confirmOne(input,id,{cwd,extensions,directory}) {
  const location=claudeEntryPaths(directory,input.session_id);
  return withStoreLock(location.lock,async()=>{
    const record=await readJson(location.record), request=await readJson(requestPath(location,id));
    if(!request)return null;
    if(request.action==='join')return confirmJoin(input,location,request,cwd);
    if(!record || record.version!==1 || record.sessionId!==input.session_id || !sameConnection(owner(record),request.connection) || record.generation!==request.generation)throw Error('Claude action belongs to a stale or different conversation.');
    if(!await sameProject(input.cwd,cwd))throw Error('Claude hook directory does not match its caller.');
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
      context=`Created Goal #${result.id} in this Claude conversation. Read it with:\n${command()} goal show --id ${result.id} --format text --section context\nThis action does not enable Auto mode or live controls.`;
    } else if(request.action === 'adopt') {
      result=await adopt(request);
      context=result.changed?`This conversation now owns Goal #${result.goalId} and its Split Goals. Feedback saved for the earlier conversation is delivered here. Read it with:\n${command()} goal show --id ${result.goalId} --format text --section context`:`This conversation already owns Goal #${result.goalId}.`;
    } else if(request.action === 'inbox') {
      result=await inbox(request);
      const resumed=await takeClaudeResume(request.connection,{locked:true});
      context=`${resumed?`${resumeNotice}\n`:''}${result.length ? feedbackContext(result,await openLettersFor(result)) : resumed ? '' : 'No unclaimed feedback for this Claude conversation. Held feedback is left untouched.'}`.trim();
    } else if(request.action === 'activity') {
      result=await receipt(request);
      context=`Feedback #${result.eventId}: ${result.status}. This receipt does not complete the Goal or prove live execution.`;
    } else if(request.action === 'reply') {
      // The request ID makes the comment idempotent if a crash forces a retry.
      let comment;
      const ids=request.payload.eventIds||[request.payload.eventId];
      const goals=new Set();for(const id of ids)goals.add((await eventFor(id)).goalId);
      if(goals.size!==1)throw Error('One reply answers messages of one Goal. Reply to each Goal separately.');
      // The comment is keyed by the request ID, so it is posted once for all messages.
      for(const id of ids)result=await receipt({...request,payload:{eventId:id,state:'completed'}},async event=>{
        comment=await appendAgentComment({goalId:event.goalId,type:'comment',text:request.payload.text,requestId:request.id});
      });
      if(!comment)throw Error('Feedback already has a terminal receipt; post a new comment with goal comment instead.');
      result={...result,eventId:ids[0],eventIds:ids,goalId:comment.goalId,commentId:comment.changeId};
      context=`Replied on Goal #${comment.goalId} (comment #${comment.changeId}) and recorded feedback ${ids.map(id=>`#${id}`).join(', ')} as completed. This does not complete the Goal.`;
    } else throw Error('Unsupported stored Claude action.');
    const promptId=promptIdentity(input.prompt_id);
    const at=new Date().toISOString(),nextRecord={...record,lastHook:{name:'PostToolUse',at},lastToolAt:at};delete nextRecord.stoppedPrompt;
    if(promptId)await writeJsonAtomically(location.record,{...nextRecord,verifiedPrompt:{id:promptId,generation:record.generation,contextId:record.contextId}});
    else {delete nextRecord.verifiedPrompt;await writeJsonAtomically(location.record,nextRecord);}
    // A repeated native hook is silent even if its first output was lost. The
    // user/agent can deliberately read inbox again with the same event IDs.
    await writeJsonAtomically(requestPath(location,id),{...request,status:'completed',completedAt:new Date().toISOString(),
      result:request.action==='extension'?result:request.action==='inbox'?result.map(({eventId,offerId,goalId})=>({eventId,offerId,goalId})):request.action==='create-goal'?{goalId:result.id}:request.action==='adopt'?{goalId:result.goalId,changed:result.changed}:request.action==='reply'?{eventId:result.eventId,eventIds:result.eventIds,goalId:result.goalId,commentId:result.commentId}:{eventId:result.eventId,state:result.status}});
    return hookContext(request.action==='extension'?context:withWaiter(context,record));
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
    if(!await sameProject(input.cwd,cwd))throw Error('Claude hook directory does not match its caller.');
    if(input.hook_event_name==='Stop') {
      // Repeated Stop output is not a new continuation. Native block continues
      // the same prompt; require its next real tool call before another Stop.
      if(verified.awaitingTool)return null;
      const next={...record,lastHook:{name:'Stop',at:new Date().toISOString()},stoppedPrompt:{...verified,checkpointId:randomUUID()}};delete next.verifiedPrompt;
      await writeJsonAtomically(location.record,next);
      return null;
    }
    // The time of this tool call tells the reply waiter the response is still
    // running, so feedback can wait for the next tool hook instead of a wake.
    await writeJsonAtomically(location.record,{...record,lastToolAt:new Date().toISOString(),...(verified.awaitingTool?{verifiedPrompt:{...verified,awaitingTool:false}}:{})});
    const key=createHash('sha256').update(JSON.stringify([record.sessionId,record.generation,promptId,input.tool_use_id])).digest('hex');
    const path=join(dirname(location.record),'offers',`${key}.json`);
    if(await readJson(path))return null;
    // Reserve before offering. A duplicate hook cannot pick up newer events.
    // Unoffered saved events remain eligible on a later distinct tool call.
    const offer={id:randomUUID(),connection:owner(record),generation:record.generation,promptId,toolUseId:input.tool_use_id,status:'reserved'};
    await writeJsonAtomically(path,offer,true);
    const items=await inbox(offer,{recover:false});
    await writeJsonAtomically(path,{...offer,status:'offered',eventIds:items.map(item=>item.eventId)});
    const resumed=await takeClaudeResume(offer.connection,{locked:true});
    const text=[resumed?resumeNotice:'',items.length?feedbackContext(items,await openLettersFor(items)):''].filter(Boolean).join('\n');
    return text?hookContext(text):null;
  });
}

// Feedback this conversation took up (a working receipt) but never recorded as
// done, and feedback it was offered but never answered.
async function openReceipts(connection){
  const working=[],unanswered=[];
  for(const event of await readFeedback()){
    if(event.author!=='user'||!sameConnection(event.connection,connection))continue;
    const state=await readDeliveryState(event.changeId),open={eventId:event.changeId,goalId:event.goalId};
    if(state?.agentReported&&state.status==='working')working.push(open);
    else if(state&&!state.agentReported&&state.nativeOfferId&&state.status==='unknown')unanswered.push(open);
  }
  return {working,unanswered};
}
const listed=open=>open.slice(0,5).map(o=>`#${o.eventId} (Goal #${o.goalId})`).join(', ');
export async function handleClaudeStopExtensions(input,{cwd=process.cwd(),extensions=connectionExtensions}={}) {
  if(!input||input.agent_id!=null||input.hook_event_name!=='Stop'||!promptIdentity(input.prompt_id))return null;
  const location=claudeEntryPaths(dataDirectory(),input.session_id);
  return withStoreLock(location.lock,async()=>{
    const record=await readJson(location.record),stop=record?.stoppedPrompt;
    if(!stop||stop.id!==input.prompt_id||stop.generation!==record.generation||stop.contextId!==record.contextId)return null;
    if(!await sameProject(input.cwd,cwd))throw Error('Claude hook directory does not match its caller.');
    if(record.pause)return null;
    // A receipt left as working, or offered feedback left without a reply,
    // would stay open for good. Before the response ends, remind the
    // conversation once per prompt to close it. Short work needs no receipt.
    if(record.receiptReminder!==stop.id){
      const {working,unanswered}=await openReceipts(owner(record));
      if(working.length||unanswered.length){
        const next={...record,receiptReminder:stop.id,verifiedPrompt:{id:stop.id,generation:record.generation,contextId:record.contextId,awaitingTool:true}};delete next.stoppedPrompt;
        await writeJsonAtomically(location.record,next);
        const reply=`${command()} connection reply --event <ID> --text '<reply>'`;
        return {decision:'block',reason:[
          working.length?`chill-agent: feedback you marked working is not recorded as done: ${listed(working)}. Before ending, reply and close it with ${reply}, or record ${command()} goal activity --event <ID> --state completed (failed if it cannot be done). If the work really continues later, say so in a comment and record its state.`:'',
          unanswered.length?`chill-agent: feedback offered to this conversation has no reply yet: ${listed(unanswered)}. Before ending, reply with ${reply}. If the work continues after this response, record ${command()} goal activity --event <ID> --state working instead (failed if it cannot be done).`:'',
          'This reminder is shown once for this response.'].filter(Boolean).join('\n')};
      }
    }
    for(const provider of Object.values(await extensions())){
      if(typeof provider.onStop!=='function')continue;
      const reason=await provider.onStop({connection:owner(record),generation:record.generation,promptId:stop.id,checkpointId:stop.checkpointId});
      if(reason==null)continue;
      if(typeof reason!=='string'||!reason.trim())throw Error('Invalid connection extension continuation.');
      // A synchronous continuation owns this Stop. Never reissue the hook
      // output after an uncertain return.
      const next={...record,verifiedPrompt:{id:stop.id,generation:record.generation,contextId:record.contextId,awaitingTool:true}};delete next.stoppedPrompt;
      await writeJsonAtomically(location.record,next);
      return {decision:'block',reason};
    }
    return null;
  });
}
export async function handleClaudeToolHook(input,options) {
  if(['UserPromptSubmit','SessionEnd'].includes(input?.hook_event_name))return clearClaudePrompt(input,options);
  let action;
  try {action=await confirmClaudeAction(input,options);}
  catch(error) {
    // The shell only printed a request; tell the agent why it was not confirmed,
    // as a failing command would.
    if(input?.hook_event_name!=='PostToolUse')throw error;
    action=hookContext(`chill-agent: the request in this output was not confirmed: ${error.message}`);
  }
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
// A resumed or compacted conversation that owns Goals has lost its background
// waiter with the old process. Fresh, cleared and forked contexts own nothing.
export async function claudeSessionStartContext(record) {
  if(!record||waiterRunning(record))return null;
  const connection=owner(record);
  const owns=(await listGoals()).some(goal=>!goal.parentId&&sameConnection(goal.connection,connection));
  return owns?hookContext(`This conversation owns chill-agent Goals. ${waiterAction()}`,'SessionStart'):null;
}
