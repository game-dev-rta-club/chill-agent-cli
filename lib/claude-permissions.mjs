// "Approve all" for one Claude conversation, chosen in the Agent menu. While on,
// the PermissionRequest hook answers each permission prompt with allow, so
// unattended work does not stop at a dialog. Prompts Claude Code never lets a
// hook approve (such as rm on critical paths) still ask. Claude only: Codex
// prompts are not answered by hooks.
import {dataDirectory} from './data-directory.mjs';
import {claudeEntryPaths} from './claude-entry.mjs';
import {readJson,withStoreLock,writeJsonAtomically} from './storage.mjs';
import {hidden,recordHidden} from './hidden-failure.mjs';
import {questionTool} from './claude-question.mjs';

const current=(record,connection)=>record?.version===1&&record.sessionId===connection.sessionId&&record.contextId===connection.contextId;
export async function readClaudeApproveAll(connection,{directory=dataDirectory()}={}) {
  const record=await readJson(claudeEntryPaths(directory,connection.sessionId).record).catch(hidden('claude-permissions.read'));
  return current(record,connection)&&Boolean(record.approveAll);
}
export async function setClaudeApproveAll(connection,on,{directory=dataDirectory(),now=()=>new Date().toISOString()}={}) {
  if(typeof on!=='boolean')throw Error('Choose On or Off.');
  const location=claudeEntryPaths(directory,connection.sessionId);
  return withStoreLock(location.lock,async()=>{
    const record=await readJson(location.record);
    if(!current(record,connection))throw Error('Agent changed. Refresh to retry.');
    const next={...record};
    if(on)next.approveAll={at:now()};else delete next.approveAll;
    await writeJsonAtomically(location.record,next);
    return on;
  });
}
export async function claudePermissionDecision(input,{directory=dataDirectory()}={}) {
  if(input?.hook_event_name!=='PermissionRequest'||typeof input.session_id!=='string')return null;
  let record;
  try {record=await readJson(claudeEntryPaths(directory,input.session_id).record);} catch(error) {recordHidden('claude-permissions.decision',error);return null;}
  if(record?.version!==1||!record.approveAll||record.pause)return null;
  // A question for the user is never answered on their behalf.
  if(input.tool_name===questionTool)return null;
  return {hookSpecificOutput:{hookEventName:'PermissionRequest',decision:{behavior:'allow'}}};
}
