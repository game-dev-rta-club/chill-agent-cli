import {realpath} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {dataDirectory, listGoals, readFeedback} from './goal-store.mjs';
import {readJson, withStoreLock, writeJsonAtomically} from './storage.mjs';
import {claudeEntryPaths, desktopPausesIdle, holdRunning, identifyClaudeCaller, nativeSessionId, newEntryRecord, validEntry} from './claude-entry.mjs';
import {validTranscriptPath} from './claude-transcript.mjs';
import {applyWork,backgroundTasks,recordedWork} from './claude-agent-work.mjs';
import {quietGoalsReason} from './quiet-stop.mjs';
import {readClaudePause,takeClaudeResume,resumeNotice} from './claude-pause.mjs';
import {feedbackText} from './delivery.mjs';
import {handRoots,handedAwaitingComments,ownedRoots,quietStop,wouldHand} from './hand-off.mjs';
import {connectionExtensions} from './connection-extensions.mjs';
import {command} from './chill-command.mjs';
import {claudeWatcherInstalled} from './claude-setup.mjs';
import {claudeOwner} from './agents/owners.mjs';
import {ownsRoot} from './owner.mjs';
import {neverStop,ownedRootLevels} from './autonomy.mjs';
import {nextWake,pendingWakes} from './claude-wake.mjs';
import {takeLevelNotice} from './autonomy-notice.mjs';

const owner = record => ({harnessId:record.harnessId, sessionId:record.sessionId, contextId:record.contextId});
const hookContext = (context, hookEventName='PostToolUse') => context ? {hookSpecificOutput:{hookEventName,additionalContext:context}} : null;
// The watcher hook wakes the conversation for Web replies, so nothing about
// waiting is shown to the agent, except in Claude Desktop: it pauses an idle
// conversation unless a background task runs, so there a task holds it. A
// response that continues is also asked, since the stop after it does not ask again.
export const holdAction = () => `Claude Desktop pauses an idle conversation unless a background task runs, and Web replies cannot wake a paused one. Start this task that keeps it from pausing as a background task (Bash run_in_background) and continue without waiting for it:\n${command()} agent wait`;
const holdCovered = record => !desktopPausesIdle() || holdRunning(record);
const withHold = (context, record) => holdCovered(record) ? context : `${context}\n\n${holdAction()}`;
// The feedback text every harness shows (delivery feedbackText), with this conversation's commands.
export const claudeFeedbackText = events => feedbackText(events, {cli:`${command()} goal`, reply:`${command()} goal reply --id <goalId> --text '<reply>'`});
// A Goal command's result in this conversation, with the hold it may still need.
export async function withClaudeHold(text, env=process.env) {
  const caller=await identifyClaudeCaller({env});
  return withHold(text, await readJson(claudeEntryPaths(dataDirectory(),caller.identity.sessionId).record));
}
function validateAction(action, input) {
  if(action === 'inbox')return {};
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
    if(!validEntry(record,caller.identity.sessionId))throw Error('This Claude conversation is not connected yet. Run agent join.');
    const request={id:randomUUID(),action,payload,connection:owner(record)};
    let result,context;
    if(action==='extension') {
      const provider=(await extensions())[payload.extension];
      if(typeof provider?.confirmAction!=='function')throw Error('Connection extension action is unavailable.');
      const confirmed=await provider.confirmAction({requestId:request.id,connection:request.connection,generation:record.generation,promptId:null,operation:payload.operation,input:payload.input});
      if(!confirmed||typeof confirmed.context!=='string')throw Error('Invalid connection extension result.');
      return {result:confirmed.result,text:confirmed.context};
    }
    if(action === 'inbox') {
      // Reading the inbox takes what was not handed yet, even while the work
      // runs, and lists again everything still awaiting a reply.
      const paused=Boolean(record.pause),handedNow=paused?[]:await handComments(record,'read');
      if(handedNow.length)await writeJsonAtomically(location.record,{...record,agentWork:applyWork(recordedWork(record),[handed(handedNow)])});
      result=paused?[]:await awaitingItems(request.connection);
      const resumed=await takeClaudeResume(request.connection,{locked:true});
      // Comments handed earlier (by a hook or the watcher) are listed apart, so a
      // second wake does not read as new feedback.
      const now=new Set(handedNow.map(e=>e.id)),fresh=result.filter(e=>now.has(e.id)),earlier=result.filter(e=>!now.has(e.id));
      const listed=[fresh.length?await claudeFeedbackText(fresh):'',earlier.length?`Handed to you earlier and still awaiting your reply:\n${await claudeFeedbackText(earlier)}`:''].filter(Boolean).join('\n\n');
      context=`${resumed?`${resumeNotice}\n`:''}${listed || (resumed ? '' : paused ? 'This conversation is paused from the Web. Nothing is handed until Resume.' : 'Nothing awaits a reply in this Claude conversation.')}`.trim();
    }
    return {result,text:withHold(context,await readJson(location.record)??record)};
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
    await writeJsonAtomically(location.record,newEntryRecord({sessionId,source:'join',cwd:await realpath(cwd),desktop:desktopPausesIdle(env)}));
    return `Connected this Claude conversation to chill-agent. Check it with:\n${command()} agent show\nThen create or reuse its Goal.`;
  });
}

// Hand this conversation's comments over now, by the rules (agent-rules):
//   'tool'  a tool hook while the work runs: only what the user sent now
//   'stop'  the work is ending: everything not handed yet
//   'idle'  the watcher wakes an idle conversation
//   'read'  the agent reads its inbox: everything not handed yet
// Returns the handed comments. The cursor moves before the
// text is emitted, so nothing automatic hands a comment twice; a lost text
// still leaves its Goal awaiting a reply, and the inbox lists it again.
async function handComments(record,mode) {
  if(record.pause)return [];
  const {roots}=await ownedRoots(claudeOwner(record));
  return handRoots(roots,{working:mode==='tool',startedAt:recordedWork(record).startedAt});
}
// Every handed comment still awaiting a reply in this conversation's Roots.
const awaitingItems=async connection=>handedAwaitingComments((await ownedRoots(claudeOwner(connection))).roots);
// Read-only check for the watcher: would a comment be handed now? `midTurn`
// says the conversation's work runs (since `startedAt`), so only comments
// saved before it started and Send now count.
export async function hasSavedClaudeFeedback(connection,{readEvents=readFeedback,midTurn=false,startedAt=null}={}) {
  const pause=await readClaudePause(connection);
  if(pause.resumeRequested)return true;
  if(pause.paused)return false;
  return wouldHand((await ownedRoots(claudeOwner(connection),{readEvents})).roots,{working:midTurn,startedAt});
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
// A level the user changed since chill last stated it (autonomy-notice), with
// the checks still scheduled, which only the agent knows whether it still needs.
async function levelNotice(record){
  const text=await takeLevelNotice(claudeOwner(owner(record)));
  if(!text)return '';
  const wakes=pendingWakes(record);
  return wakes.length?`${text}\nA level change does not cancel the checks you scheduled: ${wakes.map(w=>`${w.at}${w.reason?` (${w.reason})`:''}`).join('; ')}. Cancel any you no longer need: ${command()} agent wake --cancel <time|all>`:text;
}
// The notice for a conversation the watcher wakes for a scheduled check.
export async function claudeWakeNotice(sessionId){
  const location=claudeEntryPaths(dataDirectory(),sessionId);
  return withStoreLock(location.lock,async()=>{
    const record=await readJson(location.record);
    return validEntry(record,sessionId)?levelNotice(record):'';
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
    const items=await handComments(record,'tool');
    if(items.length)await writeJsonAtomically(location.record,{...record,agentWork:applyWork(recordedWork(record),[handed(items)])});
    const resumed=await takeClaudeResume(owner(record),{locked:true});
    const text=[resumed?resumeNotice:'',await levelNotice(record),items.length?await claudeFeedbackText(items):''].filter(Boolean).join('\n');
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
    const told=resumed||items.length?await levelNotice(record):'';
    const text=[resumed?resumeNotice:'',told,items.length?await claudeFeedbackText(items):''].filter(Boolean).join('\n');
    // The wake that carries this text starts the conversation's work. Text that
    // joins a running response keeps it, so Think keeps what it already wrote.
    if(text)await writeJsonAtomically(location.record,{...record,agentWork:applyWork(recordedWork(record),[...(items.length?[handed(items)]:[]),{type:'started',fresh:!midTurn}])});
    return text;
  });
}
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
    // Held once while a Goal it was handed comments on still awaits a reply.
    const quiet=items.length||record.pause?null:quietStop((await ownedRoots(claudeOwner(record))).roots,{background,held:Boolean(record.stopHeld)});
    const output=items.length?{decision:'block',reason:withHold(await claudeFeedbackText(items),record)}:await stopOutput(input,record,quiet,options);
    // A blocked stop continues the work; otherwise it ends, with its background tasks still listed.
    await writeJsonAtomically(location.record,{...record,...(quiet?{stopHeld:quiet.length>0}:{}),agentWork:applyWork(recordedWork(record),[...(items.length?[handed(items)]:[]),{type:'background',tasks:background,at:new Date().toISOString()},output?{type:'started'}:{type:'finished'}])});
    return output;
  });
}
async function stopOutput(input,record,quiet,{extensions=connectionExtensions}={}) {
  if(record.pause)return null;
  if(quiet.length)return {decision:'block',reason:withHold(quietGoalsReason(quiet,{reply:`${command()} goal reply --id <goalId> --text '<reply>'`,progress:`${command()} goal reply --id <goalId> --text '<progress>'`}),record)};
  for(const provider of Object.values(await extensions())){
    if(typeof provider.onStop!=='function')continue;
    const reason=await provider.onStop({connection:owner(record),generation:record.generation,promptId:typeof input.prompt_id==='string'?input.prompt_id:null,checkpointId:randomUUID()});
    if(reason==null)continue;
    if(typeof reason!=='string'||!reason.trim())throw Error('Invalid connection extension continuation.');
    return {decision:'block',reason:withHold(reason,record)};
  }
  const never=await neverStopReason(record);
  if(never)return {decision:'block',reason:withHold(never,record)};
  // In Claude Desktop, a conversation that waits for Web replies without the
  // task would be paused with its watcher. Ask once per stop.
  if(!input.stop_hook_active&&!holdCovered(record)&&await ownsGoals(owner(record)))return {decision:'block',reason:`chill-agent: ${holdAction()}\nThen end the response.`};
  return null;
}
// Never Stop never ends a turn without a scheduled check; wakes are Claude
// Code's own, so the rule lives here. It holds on every stop, not once per
// revision, and ends with the Root, a lower level or a pause (handled above).
async function neverStopReason(record) {
  if(nextWake(record))return null;
  const roots=(await ownedRootLevels(claudeOwner(record))).filter(({root,level})=>level===neverStop&&root.state!=='done').map(({root})=>`#${root.id}`);
  if(!roots.length)return null;
  return `chill-agent: Root Goal ${roots.join(', ')} is at Never Stop, so its work must resume on its own: this turn ends only once the next check is scheduled. First make each Goal you worked on show the real state of its work, finished ones Done. Then schedule your next look at whether the work or anything it depends on has changed, such as a CI run, a review or the user's reply, choosing the minutes by how soon that may be: ${command()} agent wake --in <minutes> --reason '<what to look at>'. If the command fails, say so once in a Comment on the Root, adding that lowering the level or pausing lets the turn end. Then end the response.`;
}
export async function handleClaudeToolHook(input,options) {
  if(['UserPromptSubmit','SessionEnd'].includes(input?.hook_event_name))return clearClaudePrompt(input);
  if(input?.hook_event_name==='Stop')return handleClaudeStop(input,options);
  return collectClaudeHookFeedback(input);
}
// A resumed or compacted conversation that owns Goals has lost its background
// task with the old process. Fresh, cleared and forked contexts own nothing.
export async function claudeSessionStartContext(record) {
  if(!record||!await ownsGoals(owner(record)))return null;
  // Only the watcher hook delivers Web replies; hooks set up before it cannot.
  if(!await claudeWatcherInstalled(record.cwd))return hookContext(`chill-agent: this project's Claude hooks predate the reply watcher, so Web replies cannot wake this conversation. Tell the user to rerun chill's Claude setup for this project (setup prepare --harness claude-code) and restart the conversation.`,'SessionStart');
  return holdCovered(record)?null:hookContext(`This conversation owns chill-agent Goals. ${holdAction()}`,'SessionStart');
}
const ownsGoals=async connection=>(await listGoals()).some(ownsRoot(claudeOwner(connection)));
const handed=events=>({type:'handed',goals:[...new Set(events.map(e=>e.goalId))]});
