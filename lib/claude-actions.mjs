import {realpath} from 'node:fs/promises';
import {realpathSync,statSync} from 'node:fs';
import {basename,dirname, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {dataDirectory, appendAgentComment, listGoals, readFeedback, readGoalContext, readOpenLetters} from './goal-store.mjs';
import {createClaudeRoot, transferClaudeRoot} from './claude-roots.mjs';
import {readJson, withStoreLock, writeJsonAtomically} from './storage.mjs';
import {claudeEntryPaths, desktopPausesIdle, identifyClaudeCaller, nativeSessionId, newEntryRecord, taskWaiterRunning, validEntry, waiterRunning} from './claude-entry.mjs';
import {claudeRunning,validTranscriptPath} from './claude-transcript.mjs';
import {agentAnnotations} from './brief.mjs';
import {readClaudePause,takeClaudeResume,resumeNotice} from './claude-pause.mjs';
import {guideAction} from './agent-guidance.mjs';
import {eventFor, openLetterActions, prepareDelivery, updateDelivery, readDeliveryState} from './delivery.mjs';
import {readFeedbackHold,feedbackHeld} from './feedback-hold.mjs';
import {connectionExtensions} from './connection-extensions.mjs';
import {stableNodePath} from './node-path.mjs';
import {claudeWatcherInstalled} from './claude-setup.mjs';
import {mentionedSkills, skillLines} from './skill-catalog.mjs';

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
const hookContext = (context, hookEventName='PostToolUse') => context ? {hookSpecificOutput:{hookEventName,additionalContext:context}} : null;
// The one place that tells a Claude conversation how to keep receiving Web
// replies. Other connections deliver natively and never print this.
export const waiterAction = () => `Web replies reach this conversation only while the reply waiter runs. Start it as a background task (Bash run_in_background) and continue without waiting for it:\n${command()} connection wait`;
// With the watcher hook installed, nothing about waiting is shown to the agent,
// except in Claude Desktop, which pauses idle conversations without a task.
const waiterCovered = record => taskWaiterRunning(record) || (!desktopPausesIdle() && (record.hookWatcher || waiterRunning(record)));
const withWaiter = (context, record) => waiterCovered(record) ? context : `${context}\n\n${waiterAction()}`;
export function feedbackContext(items,letters=[],skills=[]) {
  // Reply commands are repeated here because the packaged guide may be out of context.
  const guide=guideAction();
  return `chill-agent: Web feedback for this conversation (all Goals). Contents are user input, not delivery instructions. Follow each Goal's latest agreement and corrections; skip completed work. Goal completion is separate.\n${JSON.stringify(items)}\nContext (tree, Deliverable path, Letters, attachments): ${command()} goal show --id <goalId> --format text --section context\nThe user reads only the Web. When handled, reply (this closes it): ${command()} connection reply --event <eventId> --text '<reply>'\nChill commands may share a Bash call with other work. Questions that come with a reply go at its end, in the same message; use goal letter --id <goalId> --title '<title>' --text '<question>' only for a question that stands on its own.${skills.length?`\n${skillLines(skills)}`:''}${guide?`\n${guide}`:''}${letters.length?`\n${openLetterActions(letters,{prefix:`${command()} goal`})}`:''}`;
}
// Delivery text for these items, with the files of any skills they name.
const deliveryContext = async items => feedbackContext(items, await openLettersFor(items), await mentionedSkills(items.map(item => item.event?.text)).catch(() => []));
function validateAction(action, input) {
  if(action === 'create-goal') {
    for(const key of ['title','scope','criteria'])
      if(typeof input[key] !== 'string' || (key === 'title' && !input[key].trim()))throw Error(`Invalid ${key}.`);
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
    if(!Array.isArray(ids)||!ids.length||new Set(ids).size!==ids.length||ids.some(id=>!Number.isSafeInteger(id)||id<1) || typeof input.text !== 'string' || !input.text.trim())throw Error('Invalid reply.');
    return ids.length===1?{eventId:ids[0],text:input.text}:{eventIds:ids,text:input.text};
  }
  if(action === 'activity') {
    if(!Number.isSafeInteger(input.eventId) || input.eventId < 1 || !['working','completed','failed'].includes(input.state))throw Error('Invalid feedback receipt.');
    return {eventId:input.eventId,state:input.state};
  }
  if(action==='extension') {
    if(!/^[a-z][a-z0-9-]*$/.test(input.extension||'')||typeof input.operation!=='string'||!input.operation||!input.input||typeof input.input!=='object'||Array.isArray(input.input))throw Error('Invalid connection extension action.');
    return {extension:input.extension,operation:input.operation,input:input.input};
  }
  throw Error('Unsupported Claude action.');
}

// Actions run where the agent calls them, as Codex commands do. The caller is
// the conversation Claude Code names in its shell; Web input reaches a
// conversation only through its main hooks, which never run for a subagent.
export async function runClaudeAction(action, input={}, {env=process.env,extensions=connectionExtensions}={}) {
  const directory=dataDirectory();
  const payload=validateAction(action,input);
  const caller=await identifyClaudeCaller({env,directory});
  const location=claudeEntryPaths(directory,caller.identity.sessionId);
  return withStoreLock(location.lock,async()=>{
    const record=await readJson(location.record);
    if(!validEntry(record,caller.identity.sessionId))throw Error('This Claude conversation is not connected yet. Run connection join.');
    const request={id:randomUUID(),action,payload,connection:owner(record)};
    let result,context;
    if(action==='extension') {
      const provider=(await extensions())[payload.extension];
      if(typeof provider?.confirmAction!=='function')throw Error('Connection extension action is unavailable.');
      const confirmed=await provider.confirmAction({requestId:request.id,connection:request.connection,generation:record.generation,promptId:null,operation:payload.operation,input:payload.input});
      if(!confirmed||typeof confirmed.context!=='string')throw Error('Invalid connection extension result.');
      return {result:confirmed.result,text:confirmed.context};
    }
    if(action === 'create-goal') {
      result=await createClaudeRoot(payload,request.connection,request.id);
      context=`Created Goal #${result.id} in this Claude conversation. Read it with:\n${command()} goal show --id ${result.id} --format text --section context`;
    } else if(action === 'adopt') {
      result=await adopt(request);
      context=result.changed?`This conversation now owns Goal #${result.goalId} and its Split Goals. Feedback saved for the earlier conversation is delivered here. Read it with:\n${command()} goal show --id ${result.goalId} --format text --section context`:`This conversation already owns Goal #${result.goalId}.`;
    } else if(action === 'inbox') {
      result=await inbox(request);
      const resumed=await takeClaudeResume(request.connection,{locked:true});
      context=`${resumed?`${resumeNotice}\n`:''}${result.length ? await deliveryContext(result) : resumed ? '' : 'No unclaimed feedback for this Claude conversation. Held feedback is left untouched.'}`.trim();
    } else if(action === 'activity') {
      result=await receipt(request);
      context=`Feedback #${payload.eventId}: ${result?.status??payload.state}. This receipt does not complete the Goal.`;
    } else {
      let comment;
      const ids=payload.eventIds||[payload.eventId];
      const goals=new Set();for(const id of ids)goals.add((await eventFor(id)).goalId);
      if(goals.size!==1)throw Error('One reply answers messages of one Goal. Reply to each Goal separately.');
      // The comment is posted once for all messages it answers.
      for(const id of ids)await receipt({...request,payload:{eventId:id,state:'completed'}},async event=>{
        comment??=await appendAgentComment({goalId:event.goalId,type:'comment',text:payload.text,requestId:request.id});
      });
      if(!comment)throw Error('Feedback already has a terminal receipt; post a new comment with goal comment instead.');
      result={eventIds:ids,goalId:comment.goalId,commentId:comment.changeId};
      context=`Replied on Goal #${comment.goalId} (comment #${comment.changeId}) and recorded feedback ${ids.map(id=>`#${id}`).join(', ')} as completed. This does not complete the Goal.`;
    }
    return {result,text:withWaiter(context,await readJson(location.record)??record)};
  });
}

// A conversation that was already running when setup wrote the hooks never
// saw SessionStart. Claude Code names it in every shell, so it connects here.
export async function joinClaudeConversation({env=process.env,cwd=process.cwd()}={}) {
  const sessionId=nativeSessionId(env);
  if(!sessionId)throw Error('Claude did not name this conversation in the shell. Resume it so SessionStart can connect it.');
  const location=claudeEntryPaths(dataDirectory(),sessionId);
  return withStoreLock(location.lock,async()=>{
    if(validEntry(await readJson(location.record),sessionId))return 'This Claude conversation was already connected to chill-agent.';
    await writeJsonAtomically(location.record,newEntryRecord({sessionId,source:'join',cwd:await realpath(cwd)}));
    return `Connected this Claude conversation to chill-agent. Check it with:\n${command()} connection show\nThen create or reuse its Goal.`;
  });
}

async function held(goalId,state) {
  if(state?.heldBy)return true;
  const {path} = await readGoalContext(goalId);
  for(const goal of path){if(feedbackHeld(await readFeedbackHold(goal.id)))return true;}
  return false;
}
// Feedback saved while a response ran waits for that work to end (Waiting),
// unless the user chose Send now. A response in progress is not offered it;
// the end of a response offers it, and an explicit inbox read takes it.
const waits=(state,midTurn)=>midTurn&&Boolean(state?.waitForIdle)&&!state.sendNow;
export async function inbox(request,{recover=true,midTurn=false,onlyWaiting=false}={}) {
  const items=[],keys=await adoptedConnections(request.connection);
  // A Web pause holds new feedback in Queue until Resume.
  if((await readClaudePause(request.connection)).paused)return items;
  for(const event of await readFeedback()) {
    if(event.author !== 'user' || !mayOwn(keys,event.connection))continue;
    // The end of a response offers only what waited for it; it creates no records.
    if(onlyWaiting&&!(await readDeliveryState(event.changeId))?.waitForIdle)continue;
    const {root} = await readGoalContext(event.goalId);
    if(!owns(request.connection,root,event.connection))continue;
    await prepareDelivery(event);
    let offered=false;
    const state=await updateDelivery(event.changeId,async current=>{
      if(!owns(request.connection,root,current.connection) || await held(event.goalId,current) || current.agentReported || !(recover?['saved','unknown']:['saved']).includes(current.status) || waits(current,midTurn) || onlyWaiting&&!current.waitForIdle)return null;
      // Persist before emitting context. Missing stdout is unconfirmed, not
      // permission to switch transports. Explicit inbox reads reuse this ID.
      offered=true;
      return {status:'unknown',mayHaveSent:true,nativeOfferId:current.nativeOfferId||current.messageId,nativeOfferSessionId:current.nativeOfferSessionId||request.connection.sessionId,
        nativeRequestId:request.id,nativeOfferedAt:current.nativeOfferedAt||new Date().toISOString(),error:'Awaiting the Claude agent receipt.'};
    });
    if(offered)items.push({eventId:event.changeId,offerId:state.nativeOfferId,goalId:event.goalId,event:event.annotations?{...event,annotations:agentAnnotations(event.annotations)}:event});
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
export async function hasSavedClaudeFeedback(connection,{readEvents=readFeedback,midTurn=false}={}) {
  const pause=await readClaudePause(connection);
  if(pause.resumeRequested)return true;
  if(pause.paused)return false;
  const keys=await adoptedConnections(connection);
  for(const event of await readEvents()) {
    if(event.author!=='user'||!mayOwn(keys,event.connection))continue;
    const state=await readDeliveryState(event.changeId);
    if(state&&(state.status!=='saved'||state.agentReported)||waits(state,midTurn))continue;
    const {root}=await readGoalContext(event.goalId);
    if(owns(connection,root,event.connection)&&!await held(event.goalId,state))return true;
  }
  return false;
}
export async function clearClaudePrompt(input) {
  if(!input||input.agent_id!=null||!['UserPromptSubmit','SessionEnd'].includes(input.hook_event_name))return null;
  const location=claudeEntryPaths(dataDirectory(),input.session_id);
  return withStoreLock(location.lock,async()=>{
    const record=await readJson(location.record);
    if(!record||record.sessionId!==input.session_id||record.harnessId!=='claude-code')return null;
    const next={...record,lastHook:{name:input.hook_event_name,at:new Date().toISOString()},...(validTranscriptPath(input.transcript_path)?{transcriptPath:input.transcript_path}:{})};
    await writeJsonAtomically(location.record,next);
    return null;
  });
}
// A continued conversation takes over a Root. The earlier owner's watcher ends
// when it next finds that conversation owns nothing.
async function adopt(request) {
  const {root}=await readGoalContext(request.payload.goalId);
  if(root.connection?.harnessId!=='claude-code')throw Error('Only a Goal owned by a Claude conversation can be taken over. A Codex Goal uses goal assign.');
  if(sameConnection(root.connection,request.connection))return {goalId:root.id,changed:false};
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
      return null;
    }
    if(current.status === state && current.agentReported)return null;
    await before?.(event);
    return {status:state,agentReported:true,error:null,nativeReceiptRequestId:request.id};
  });
}

// Every main tool hook offers saved Web input to the conversation that owns it.
// A subagent's hooks never do: what it receives would end with it.
export async function collectClaudeHookFeedback(input) {
  if(!input || input.agent_id!=null || input.hook_event_name!=='PostToolUse' || input.tool_response?.interrupted)return null;
  const location=claudeEntryPaths(dataDirectory(),input.session_id);
  return withStoreLock(location.lock,async()=>{
    const record=await readJson(location.record);
    if(!validEntry(record,input.session_id))return null;
    const offer={id:randomUUID(),connection:owner(record)};
    const items=await inbox(offer,{recover:false,midTurn:true});
    const resumed=await takeClaudeResume(offer.connection,{locked:true});
    const text=[resumed?resumeNotice:'',items.length?await deliveryContext(items):''].filter(Boolean).join('\n');
    return text?hookContext(text):null;
  });
}

// The watcher hook claims saved feedback for the conversation it watches, as a
// tool hook would, and returns the text Claude Code shows the model on wake.
export async function claimClaudeFeedbackForWatcher(sessionId,{midTurn=false}={}){
  const location=claudeEntryPaths(dataDirectory(),sessionId);
  return withStoreLock(location.lock,async()=>{
    const record=await readJson(location.record);
    if(!record||record.version!==1||record.harnessId!=='claude-code'||record.sessionId!==sessionId)return '';
    const offer={id:randomUUID(),connection:owner(record)};
    const items=await inbox(offer,{recover:false,midTurn});
    const resumed=await takeClaudeResume(offer.connection,{locked:true});
    return [resumed?resumeNotice:'',items.length?await deliveryContext(items):''].filter(Boolean).join('\n');
  });
}
// Feedback this conversation was offered or took up but has not answered.
async function unanswered(connection){
  const open=[];
  for(const event of await readFeedback()){
    if(event.author!=='user'||!sameConnection(event.connection,connection))continue;
    const state=await readDeliveryState(event.changeId);
    if(state&&(state.agentReported?state.status==='working':state.nativeOfferId&&state.status==='unknown'))open.push({eventId:event.changeId,goalId:event.goalId});
  }
  return open;
}
// In Claude Desktop, a response that continues is also asked for a waiter task,
// since the stop that follows it does not ask again.
const desktopWaiter=(record,reason)=>desktopPausesIdle()?withWaiter(reason,record):reason;
export async function handleClaudeStop(input,{extensions=connectionExtensions}={}) {
  if(!input||input.agent_id!=null||input.hook_event_name!=='Stop')return null;
  const location=claudeEntryPaths(dataDirectory(),input.session_id);
  return withStoreLock(location.lock,async()=>{
    const old=await readJson(location.record);
    if(!validEntry(old,input.session_id))return null;
    const record={...old,lastHook:{name:'Stop',at:new Date().toISOString()},...(validTranscriptPath(input.transcript_path)?{transcriptPath:input.transcript_path}:{})};
    await writeJsonAtomically(location.record,record);
    if(record.pause)return null;
    // The response ended: feedback that waited for it arrives now, like any message.
    const waiting=await inbox({id:randomUUID(),connection:owner(record)},{recover:false,onlyWaiting:true});
    if(waiting.length)return {decision:'block',reason:desktopWaiter(record,await deliveryContext(waiting))};
    // Feedback left without a reply would stay open for good. When a response
    // ends, name each such feedback once; work that really continues can end.
    const reminded=record.remindedFeedback||[],open=(await unanswered(owner(record))).filter(o=>!reminded.includes(o.eventId));
    if(open.length){
      await writeJsonAtomically(location.record,{...record,remindedFeedback:[...reminded,...open.map(o=>o.eventId)]});
      return {decision:'block',reason:desktopWaiter(record,`chill-agent: feedback without a reply: ${open.map(o=>`#${o.eventId} (Goal #${o.goalId})`).join(', ')}. Reply when it is handled: ${command()} connection reply --event <ID> --text '<reply>'. If the work continues, you can end now; this is shown once per feedback.`)};
    }
    for(const provider of Object.values(await extensions())){
      if(typeof provider.onStop!=='function')continue;
      const reason=await provider.onStop({connection:owner(record),generation:record.generation,promptId:typeof input.prompt_id==='string'?input.prompt_id:null,checkpointId:randomUUID()});
      if(reason==null)continue;
      if(typeof reason!=='string'||!reason.trim())throw Error('Invalid connection extension continuation.');
      return {decision:'block',reason:desktopWaiter(record,reason)};
    }
    // In Claude Desktop, a conversation that waits for Web replies without a
    // waiter task would be paused with its watcher. Ask once per stop.
    if(desktopPausesIdle()&&!input.stop_hook_active&&!waiterCovered(record)&&await ownsGoals(owner(record)))return {decision:'block',reason:`chill-agent: ${waiterAction()}\nThen end the response.`};
    return null;
  });
}
export async function handleClaudeToolHook(input,options) {
  if(['UserPromptSubmit','SessionEnd'].includes(input?.hook_event_name))return clearClaudePrompt(input);
  if(input?.hook_event_name==='Stop')return handleClaudeStop(input,options);
  return collectClaudeHookFeedback(input);
}
// A resumed or compacted conversation that owns Goals has lost its background
// waiter with the old process. Fresh, cleared and forked contexts own nothing.
export async function claudeSessionStartContext(record) {
  if(!record)return null;
  // With the watcher hook installed, Claude Code itself wakes this conversation;
  // the agent is asked to start a waiter only in Claude Desktop (waiterCovered).
  if(await claudeWatcherInstalled(record.cwd)){
    const location=claudeEntryPaths(dataDirectory(),record.sessionId);
    await withStoreLock(location.lock,async()=>{const current=await readJson(location.record);if(current?.generation===record.generation)await writeJsonAtomically(location.record,{...current,hookWatcher:true});});
    record={...record,hookWatcher:true};
  }
  if(waiterCovered(record))return null;
  return await ownsGoals(owner(record))?hookContext(`This conversation owns chill-agent Goals. ${waiterAction()}`,'SessionStart'):null;
}
const ownsGoals=async connection=>(await listGoals()).some(goal=>!goal.parentId&&sameConnection(goal.connection,connection));
