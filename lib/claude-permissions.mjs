// Tool approvals from Autonomy. A permission prompt carries no Goal, so the
// Roots the conversation owns decide (autonomy approvesTools): when every one
// is at Auto Continue or Ultra Continue, the PermissionRequest hook answers Allow.
// Otherwise, or owning no Root, it makes no decision and Claude Code asks as usual. Prompts
// Claude Code never lets a hook approve (such as rm on critical paths) still
// ask. Claude only: Codex prompts are not answered by hooks.
import {dataDirectory} from './data-directory.mjs';
import {claudeEntryPaths} from './claude-entry.mjs';
import {readJson} from './storage.mjs';
import {recordHidden} from './hidden-failure.mjs';
import {approvesTools,ownedRootLevels} from './autonomy.mjs';
import {claudeConnection} from './agents/owners.mjs';

const same=(a,b)=>a?.harnessId===b?.harnessId&&a?.sessionId===b?.sessionId&&a?.contextId===b?.contextId;
export async function claudePermissionDecision(input,{directory=dataDirectory()}={}) {
  if(input?.hook_event_name!=='PermissionRequest'||typeof input.session_id!=='string')return null;
  // A question for the user is never answered on their behalf (claude-asks
  // refuses it before it is asked).
  if(input.tool_name==='AskUserQuestion')return null;
  let levels;
  try {
    const record=await readJson(claudeEntryPaths(directory,input.session_id).record);
    if(record?.version!==1||record.pause)return null;
    const connection={harnessId:record.harnessId,sessionId:record.sessionId,contextId:record.contextId};
    levels=(await ownedRootLevels(goal=>same(claudeConnection(goal),connection))).map(r=>r.level);
  } catch(error) {recordHidden('claude-permissions.decision',error);return null;}
  return approvesTools(levels)?{hookSpecificOutput:{hookEventName:'PermissionRequest',decision:{behavior:'allow'}}}:null;
}
