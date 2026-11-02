// Tool approvals from Autonomy. A permission prompt carries no Goal, so the
// owned Root the user wrote to last decides (autonomy approvesTools): at Auto
// Continue or Ultra Continue, the PermissionRequest hook answers Allow.
// Otherwise, or owning no Root, it makes no decision and Claude Code asks as usual. Prompts
// Claude Code never lets a hook approve (such as rm on critical paths) still
// ask. Claude only: Codex prompts are not answered by hooks.
import {dataDirectory} from './data-directory.mjs';
import {claudeEntryPaths} from './claude-entry.mjs';
import {readJson} from './storage.mjs';
import {recordHidden} from './hidden-failure.mjs';
import {readToolApproval} from './autonomy.mjs';
import {claudeOwner} from './agents/owners.mjs';

export async function claudePermissionDecision(input,{directory=dataDirectory()}={}) {
  if(input?.hook_event_name!=='PermissionRequest'||typeof input.session_id!=='string')return null;
  // A question for the user is never answered on their behalf (claude-asks
  // refuses it before it is asked).
  if(input.tool_name==='AskUserQuestion')return null;
  let approved;
  try {
    const record=await readJson(claudeEntryPaths(directory,input.session_id).record);
    if(record?.version!==1||record.pause)return null;
    const connection={harnessId:record.harnessId,sessionId:record.sessionId,contextId:record.contextId};
    approved=await readToolApproval(claudeOwner(connection));
  } catch(error) {recordHidden('claude-permissions.decision',error);return null;}
  return approved?{hookSpecificOutput:{hookEventName:'PermissionRequest',decision:{behavior:'allow'}}}:null;
}
