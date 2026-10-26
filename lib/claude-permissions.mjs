// Tool approvals from Autonomy. A permission prompt carries no Goal, so the
// conversation's Goals decide (autonomy approvesTools): any at 3 (Drive), or
// all at 2 (Continue) or higher, and the PermissionRequest hook answers Allow. Otherwise,
// or with no Goals, it makes no decision and Claude Code asks as usual. Prompts
// Claude Code never lets a hook approve (such as rm on critical paths) still
// ask. Claude only: Codex prompts are not answered by hooks.
import {dataDirectory} from './data-directory.mjs';
import {claudeEntryPaths} from './claude-entry.mjs';
import {readJson} from './storage.mjs';
import {recordHidden} from './hidden-failure.mjs';
import {listGoals,readFeedback} from './goal-store.mjs';
import {approvesTools,conversationGoals} from './autonomy.mjs';
import {recordedWork} from './claude-agent-work.mjs';
import {claudeSelection} from './claude-work.mjs';

const same=(a,b)=>a?.harnessId===b?.harnessId&&a?.sessionId===b?.sessionId&&a?.contextId===b?.contextId;
export async function claudePermissionDecision(input,{directory=dataDirectory()}={}) {
  if(input?.hook_event_name!=='PermissionRequest'||typeof input.session_id!=='string')return null;
  // A question for the user is never answered on their behalf (claude-asks
  // refuses it before it is asked).
  if(input.tool_name==='AskUserQuestion')return null;
  let goals;
  try {
    const record=await readJson(claudeEntryPaths(directory,input.session_id).record);
    if(record?.version!==1||record.pause)return null;
    const work=recordedWork(record),connection={harnessId:record.harnessId,sessionId:record.sessionId,contextId:record.contextId};
    const all=await listGoals(),owns=goal=>!goal.parentId&&!goal.threadId&&same(goal.connection,connection);
    const recent=[...work.goals,work.lastGoal,claudeSelection(record,work)?.goalId];
    goals=conversationGoals({goals:all,owns,recent});
    // Only with nothing recorded does it read the Roots' comments for their focus.
    if(!goals.length)goals=conversationGoals({goals:all,events:await readFeedback(),owns,recent});
  } catch(error) {recordHidden('claude-permissions.decision',error);return null;}
  return approvesTools(goals)?{hookSpecificOutput:{hookEventName:'PermissionRequest',decision:{behavior:'allow'}}}:null;
}
