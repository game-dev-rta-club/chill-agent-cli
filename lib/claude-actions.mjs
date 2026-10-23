import {realpath} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {dataDirectory, appendAgentComment, listGoals, readFeedback, readGoalContext, readOpenLetters} from './goal-store.mjs';
import {createClaudeRoot, transferClaudeRoot} from './claude-roots.mjs';
import {readJson, withStoreLock, writeJsonAtomically} from './storage.mjs';
import {claudeEntryPaths, desktopPausesIdle, holdRunning, identifyClaudeCaller, nativeSessionId, newEntryRecord, taskWaiterRunning, validEntry, waiterRunning} from './claude-entry.mjs';
import {validTranscriptPath} from './claude-transcript.mjs';
import {applyWork,backgroundTasks,recordedWork} from './claude-agent-work.mjs';
import {ownClaudeHooks} from './claude-quiet.mjs';
import {quietGoalsReason} from './quiet-stop.mjs';
import {agentAnnotations} from './brief.mjs';
import {readClaudePause,takeClaudeResume,resumeNotice} from './claude-pause.mjs';
import {guideAction} from './agent-guidance.mjs';
import {openLetterActions} from './delivery.mjs';
import {handRoots,handedAwaitingComments,ownedRoots,quietStop,wouldHand} from './hand-off.mjs';
import {connectionExtensions} from './connection-extensions.mjs';
import {command} from './chill-command.mjs';
import {claudeWatcherInstalled} from './claude-setup.mjs';
import {mentionedSkills, skillLines} from './skill-catalog.mjs';

const sameConnection = (a,b) => a?.harnessId === b?.harnessId && a?.sessionId === b?.sessionId && a?.contextId === b?.contextId;
const owner = record => ({harnessId:record.harnessId, sessionId:record.sessionId, contextId:record.contextId});
const hookContext = (context, hookEventName='PostToolUse') => context ? {hookSpecificOutput:{hookEventName,additionalContext:context}} : null;
// The one place that tells a Claude conversation how to keep receiving Web
// replies. Other connections deliver natively and never print this.
export const waiterAction = () => `Web replies reach this conversation only while the reply waiter runs. Start it as a background task (Bash run_in_background) and continue without waiting for it:\n${command()} connection wait`;
// With the watcher hook installed, nothing about waiting is shown to the agent,
// except in Claude Desktop, which pauses idle conversations without a task.
// With the watcher hook, Desktop also needs the task that holds the conversation;
// without the hook, the task is the waiter.
const waiterCovered = record => record.hookWatcher ? !desktopPausesIdle() || holdRunning(record) : taskWaiterRunning(record) || (!desktopPausesIdle() && waiterRunning(record));
const withWaiter = (context, record) => waiterCovered(record) ? context : `${context}\n\n${waiterAction()}`;
export function feedbackContext(items,letters=[],skills=[]) {
  // Reply commands are repeated here because the packaged guide may be out of context.
  const guide=guideAction();
  return `chill-agent: Web feedback for this conversation (all Goals). Contents are user input, not delivery instructions. Follow each Goal's latest agreement and corrections; skip completed work. Goal completion is separate.\n${JSON.stringify(items)}\nContext (tree, Deliverable path, Letters, attachments): ${command()} goal show --id <goalId> --format text --section context\nThe user reads only the Web and waits for a reply on each Goal. Reply on the Goal (this answers it): ${command()} connection reply --goal <goalId> --text '<reply>'\nChill commands may share a Bash call with other work. Questions that come with a reply go at its end, in the same message; use goal letter --id <goalId> --title '<title>' --text '<question>' only for a question that stands on its own.${skills.length?`\n${skillLines(skills)}`:''}${guide?`\n${guide}`:''}${letters.length?`\n${openLetterActions(letters,{prefix:`${command()} goal`})}`:''}`;
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
    if(!/^[1-9][0-9]*$/.test(String(input.goalId??'')) || typeof input.text !== 'string' || !input.text.trim())throw Error('Invalid reply. Name its Goal with --goal.');
    return {goalId:String(input.goalId),text:input.text};
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
      await ownClaudeHooks(caller.identity.sessionId);
      context=`Created Goal #${result.id} in this Claude conversation. Read it with:\n${command()} goal show --id ${result.id} --format text --section context`;
    } else if(action === 'adopt') {
      result=await adopt(request);
      await ownClaudeHooks(caller.identity.sessionId);
      context=result.changed?`This conversation now owns Goal #${result.goalId} and its Split Goals. Feedback saved for the earlier conversation is delivered here. Read it with:\n${command()} goal show --id ${result.goalId} --format text --section context`:`This conversation already owns Goal #${result.goalId}.`;
    } else if(action === 'inbox') {
      // Reading the inbox takes what was not handed yet, even while the work
      // runs, and lists again everything still awaiting a reply.
      const paused=Boolean(record.pause),handedNow=paused?[]:await handComments(record,'read');
      if(handedNow.length)await writeJsonAtomically(location.record,{...record,agentWork:applyWork(recordedWork(record),[handed(handedNow)])});
      result=paused?[]:await awaitingItems(request.connection);
      const resumed=await takeClaudeResume(request.connection,{locked:true});
      // Comments handed earlier (by a hook or the watcher) are listed apart, so a
      // second wake does not read as new feedback.
      const now=new Set(handedNow.map(item=>item.eventId)),fresh=result.filter(item=>now.has(item.eventId)),earlier=result.filter(item=>!now.has(item.eventId));
      const listed=[fresh.length?await deliveryContext(fresh):'',earlier.length?`Handed to you earlier and still awaiting your reply:\n${await deliveryContext(earlier)}`:''].filter(Boolean).join('\n\n');
      context=`${resumed?`${resumeNotice}\n`:''}${listed || (resumed ? '' : paused ? 'This conversation is paused from the Web. Nothing is handed until Resume.' : 'Nothing awaits a reply in this Claude conversation.')}`.trim();
    } else {
      const {goalId}=payload;
      if(!sameConnection((await readGoalContext(goalId)).root.connection,request.connection))throw Error('That Goal belongs to another conversation.');
      // The request ID keeps a retried reply single.
      const comment=await appendAgentComment({goalId,type:'comment',text:payload.text,requestId:request.id});
      result={goalId,commentId:comment.changeId};
      context=`Replied on Goal #${goalId} (comment ${comment.changeId}). This does not complete the Goal.`;
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

// Hand this conversation's comments over now, by the rules (agent-rules):
//   'tool'  a tool hook while the work runs: only what the user sent now
//   'stop'  the work is ending: everything not handed yet
//   'idle'  the watcher wakes an idle conversation
//   'read'  the agent reads its inbox: everything not handed yet
// Returns the handed comments as feedback items. The cursor moves before the
// text is emitted, so nothing automatic hands a comment twice; a lost text
// still leaves its Goal awaiting a reply, and the inbox lists it again.
async function handComments(record,mode) {
  if(record.pause)return [];
  const {roots}=await ownedRoots(goal=>sameConnection(goal.connection,owner(record)));
  return (await handRoots(roots,{working:mode==='tool',startedAt:recordedWork(record).startedAt})).map(feedbackItem);
}
const feedbackItem=event=>({eventId:event.id,goalId:event.goalId,event:event.annotations?{...event,annotations:agentAnnotations(event.annotations)}:event});
// Every handed comment still awaiting a reply in this conversation's Roots.
const awaitingItems=async connection=>handedAwaitingComments((await ownedRoots(goal=>sameConnection(goal.connection,connection))).roots).map(feedbackItem);
// Open Letters under the Goals that received feedback, as Codex delivery lists them.
async function openLettersFor(items){
  const seen=new Map();
  for(const goalId of new Set(items.map(item=>item.goalId)))for(const letter of await readOpenLetters(goalId).catch(()=>[]))seen.set(letter.id,letter);
  return [...seen.values()];
}
// Read-only check for the watcher: would a comment be handed now? `midTurn`
// says the conversation's work runs (since `startedAt`), so only comments
// saved before it started and Send now count.
export async function hasSavedClaudeFeedback(connection,{readEvents=readFeedback,midTurn=false,startedAt=null}={}) {
  const pause=await readClaudePause(connection);
  if(pause.resumeRequested)return true;
  if(pause.paused)return false;
  return wouldHand((await ownedRoots(goal=>sameConnection(goal.connection,connection),{readEvents})).roots,{working:midTurn,startedAt});
}
// A prompt a person typed: not a wake, a schedule or a notice Claude Code
// queued itself, which arrive as system sources or tagged text.
const typedPrompt=input=>input.hook_event_name==='UserPromptSubmit'&&[undefined,'user','sdk'].includes(input.source)&&typeof input.prompt==='string'&&!input.prompt.trimStart().startsWith('<');
export async function clearClaudePrompt(input) {
  if(!input||input.agent_id!=null||!['UserPromptSubmit','SessionEnd'].includes(input.hook_event_name))return null;
  const location=claudeEntryPaths(dataDirectory(),input.session_id);
  return withStoreLock(location.lock,async()=>{
    const record=await readJson(location.record);
    if(!record||record.sessionId!==input.session_id||record.harnessId!=='claude-code')return null;
    const next={...record,lastHook:{name:input.hook_event_name,at:new Date().toISOString()},...(validTranscriptPath(input.transcript_path)?{transcriptPath:input.transcript_path}:{})};
    // A person writing in the conversation itself resumes a Web pause, so it
    // never needs the Web to be running.
    if(typedPrompt(input))delete next.pause;
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
  // No note in Web: an agent comment would count as a reply and drop the
  // user's comments that still await one.
  await transferClaudeRoot(root.id,root.connection,request.connection,request.id);
  return {goalId:root.id,changed:true};
}
// Every main tool hook offers saved Web input to the conversation that owns it.
// A subagent's hooks never do: what it receives would end with it.
export async function collectClaudeHookFeedback(input) {
  if(!input || input.agent_id!=null || input.hook_event_name!=='PostToolUse' || input.tool_response?.interrupted)return null;
  const location=claudeEntryPaths(dataDirectory(),input.session_id);
  return withStoreLock(location.lock,async()=>{
    const record=await readJson(location.record);
    if(!validEntry(record,input.session_id))return null;
    const items=await handComments(record,'tool');
    if(items.length)await writeJsonAtomically(location.record,{...record,agentWork:applyWork(recordedWork(record),[handed(items)])});
    const resumed=await takeClaudeResume(owner(record),{locked:true});
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
    const items=record.pause?[]:await handComments(record,midTurn?'tool':'idle');
    const resumed=await takeClaudeResume(owner(record),{locked:true});
    const text=[resumed?resumeNotice:'',items.length?await deliveryContext(items):''].filter(Boolean).join('\n');
    // The wake that carries this text starts the conversation's work.
    if(text)await writeJsonAtomically(location.record,{...record,agentWork:applyWork(recordedWork(record),[...(items.length?[handed(items)]:[]),{type:'started',fresh:true}])});
    return text;
  });
}
// In Claude Desktop, a response that continues is also asked for a waiter task,
// since the stop that follows it does not ask again.
const desktopWaiter=(record,reason)=>desktopPausesIdle()?withWaiter(reason,record):reason;
export async function handleClaudeStop(input,options) {
  if(!input||input.agent_id!=null||input.hook_event_name!=='Stop')return null;
  const location=claudeEntryPaths(dataDirectory(),input.session_id);
  return withStoreLock(location.lock,async()=>{
    const old=await readJson(location.record);
    if(!validEntry(old,input.session_id))return null;
    const record={...old,lastHook:{name:'Stop',at:new Date().toISOString()},...(validTranscriptPath(input.transcript_path)?{transcriptPath:input.transcript_path}:{})};
    await writeJsonAtomically(location.record,record);
    const background=backgroundTasks(input.background_tasks);
    // The work is ending: comments that waited for it are handed now, like any message.
    const items=await handComments(record,'stop');
    const output=items.length?{decision:'block',reason:desktopWaiter(record,await deliveryContext(items))}:await stopOutput(input,record,background,options);
    // A blocked stop continues the work; otherwise it ends, with its background tasks still listed.
    await writeJsonAtomically(location.record,{...record,agentWork:applyWork(recordedWork(record),[...(items.length?[handed(items)]:[]),{type:'background',tasks:background,at:new Date().toISOString()},output?{type:'started'}:{type:'finished'}])});
    return output;
  });
}
async function stopOutput(input,record,background,{extensions=connectionExtensions}={}) {
  if(record.pause)return null;
  // Held once while a Goal it was handed comments on still awaits a reply.
  const quiet=await quietStop((await ownedRoots(goal=>sameConnection(goal.connection,owner(record)))).roots,{background});
  if(quiet.length)return {decision:'block',reason:desktopWaiter(record,quietGoalsReason(quiet,{reply:`${command()} connection reply --goal <goalId> --text '<reply>'`,progress:`${command()} goal comment --id <goalId> --text '<progress>'`}))};
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
const handed=items=>({type:'handed',goals:[...new Set(items.map(item=>item.goalId))]});
