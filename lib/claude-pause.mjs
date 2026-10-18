// Pause a Claude conversation from the Web. Claude Desktop offers no way to
// interrupt a running response from outside, so the pause works through the
// conversation's own hooks: its next tool call is refused with a reason to stop,
// AutoContinue does not continue, and new feedback waits in Queue. Resume clears
// it and wakes the conversation once to continue. Codex pauses natively instead.
import {dataDirectory} from './data-directory.mjs';
import {claudeEntryPaths} from './claude-entry.mjs';
import {readJson,withStoreLock,writeJsonAtomically} from './storage.mjs';
import {hidden,recordHidden} from './hidden-failure.mjs';

const current=(record,connection)=>record?.version===1&&record.sessionId===connection.sessionId&&record.contextId===connection.contextId;
export async function readClaudePause(connection,{directory=dataDirectory()}={}) {
  const record=await readJson(claudeEntryPaths(directory,connection.sessionId).record).catch(hidden('claude-pause.read'));
  if(!current(record,connection))return {paused:false,resumeRequested:false};
  return {paused:Boolean(record.pause),resumeRequested:Boolean(record.resumeRequested),pausedAt:record.pause?.at||null};
}

export async function setClaudePause(connection,paused,{directory=dataDirectory(),now=()=>new Date().toISOString()}={}) {
  const location=claudeEntryPaths(directory,connection.sessionId);
  return withStoreLock(location.lock,async()=>{
    const record=await readJson(location.record);
    if(!current(record,connection))throw Error('Agent changed. Refresh to retry.');
    const next={...record};
    if(paused){next.pause={at:now()};delete next.resumeRequested;}
    else if(record.pause){delete next.pause;next.resumeRequested={at:now()};}
    await writeJsonAtomically(location.record,next);
    return {paused:Boolean(next.pause),resumeRequested:Boolean(next.resumeRequested)};
  });
}

// The resume notice is delivered once, with the next inbox or tool-hook context.
// Hook callers already hold the connection lock and pass locked:true.
export async function takeClaudeResume(connection,{directory=dataDirectory(),locked=false}={}) {
  const location=claudeEntryPaths(directory,connection.sessionId);
  const take=async()=>{
    const record=await readJson(location.record);
    if(!current(record,connection)||!record.resumeRequested)return false;
    const next={...record};delete next.resumeRequested;
    await writeJsonAtomically(location.record,next);
    return true;
  };
  return locked?take():withStoreLock(location.lock,take);
}
export const resumeNotice='The user selected Resume on the Web. Read the latest Goal context, then continue the work you paused; do not repeat finished steps.';

// PreToolUse for every tool, main conversation and subagents alike.
export async function claudePauseGuard(input,{directory=dataDirectory()}={}) {
  if(input?.hook_event_name!=='PreToolUse'||typeof input.session_id!=='string')return null;
  let record;
  try {record=await readJson(claudeEntryPaths(directory,input.session_id).record);} catch(error) {recordHidden('claude-pause.guard',error);return null;}
  if(record?.version!==1||!record.pause)return null;
  return {hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',
    permissionDecisionReason:'chill-agent: The user paused this work from the Web. Stop here: do not call more tools, end your response with a one-line note of where you stopped. The work continues when the user selects Resume.'}};
}
