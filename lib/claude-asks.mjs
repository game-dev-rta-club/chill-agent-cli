// The user of a conversation that owns Goals follows it on the Web, which never
// shows what Claude Code asks inside its own app. Each step that would wait
// there for a person is refused before it runs, with a fixed reason that sends
// the agent to the Web instead:
//   AskUserQuestion  a question: ask it in a reply marked --ask (a Letter)
//   wrap_up          a closing question or choice buttons in the next-step box:
//                    ask it the same way (a recap alone goes through)
//   spawn_task       a suggestion to start a separate task: do the work itself
//   ExitPlanMode     a plan to approve: send it the same way; once the user has
//                    replied on the Web, the next ExitPlanMode and its permission
//                    prompt go through, so plan mode never traps the work
// Conversations that own no Goal never reach this (claude-quiet).
import {dataDirectory} from './data-directory.mjs';
import {claudeEntryPaths} from './claude-entry.mjs';
import {readFeedback} from './goal-store.mjs';
import {ownedRoots} from './hand-off.mjs';
import {readJson,withStoreLock,writeJsonAtomically} from './storage.mjs';
import {command} from './chill-command.mjs';
import {claudeConnection} from './agents/owners.mjs';

const question='AskUserQuestion',wrapUp='mcp__ccd_turn__wrap_up',separateTask='mcp__ccd_session__spawn_task',plan='ExitPlanMode';
const asks=new Set([question,wrapUp,separateTask,plan]);
const waitsForPerson=input=>input.tool_name!==wrapUp||Boolean(input.tool_input?.ask)||Boolean(input.tool_input?.actions?.length);
const owner=record=>({harnessId:record.harnessId,sessionId:record.sessionId,contextId:record.contextId});
const same=(a,b)=>a?.harnessId===b?.harnessId&&a?.sessionId===b?.sessionId&&a?.contextId===b?.contextId;
const lastEventId=events=>events.reduce((last,e)=>Math.max(last,e.id),0);
// A user comment in this conversation's Goals after the plan was sent back.
async function repliedSince(record,eventId) {
  const {roots}=await ownedRoots(goal=>same(claudeConnection(goal),owner(record)));
  return roots.some(r=>r.events.some(e=>e.author==='user'&&e.type==='comment'&&!e.deletedAt&&e.id>eventId));
}

function reason(tool,goalId) {
  const ask=text=>`${command()} goal reply --id ${goalId} --ask '<what to decide, one line>' ${text}`;
  const web='chill-agent: The user follows this conversation on the chill-agent Web, which cannot show this app\'s';
  if(tool===question||tool===wrapUp)return `${web} questions, so nothing was asked. Ask it on the Web instead, in the same message as anything you still have to report there; --ask makes it a Letter:\n${ask("--text '<the question, your recommendation and the choices>'")}\nThen continue the work that does not depend on the answer; the user's answer reaches you here.`;
  if(tool===separateTask)return `${web} task suggestions, so nothing was suggested. Do the work yourself instead: now, with a subagent, or as a Split Goal (${command()} goal create --parent ${goalId} --title '<title>' --scope '<scope>' --criteria '<criteria>'). Report it in a Comment and keep working.`;
  return `${web} plan approval, so the plan was not shown. Send the plan on the Web for approval instead; --ask makes it a Letter:\n${ask('--text-file <plan file>')}\nContinue anything that does not depend on it. When the user has replied on the Web, call ExitPlanMode again; it then goes through.`;
}

// PreToolUse, main conversation and subagents alike.
export async function claudeAskGuard(input,{directory=dataDirectory()}={}) {
  if(input?.hook_event_name!=='PreToolUse'||!asks.has(input.tool_name)||!waitsForPerson(input)||typeof input.session_id!=='string')return null;
  const location=claudeEntryPaths(directory,input.session_id);
  return withStoreLock(location.lock,async()=>{
    const record=await readJson(location.record);
    if(record?.version!==1)return null;
    if(input.tool_name===plan){
      // Each plan is sent once; the reply lets this one through and its prompt.
      const next={...record};delete next.planSent;delete next.planApproved;
      const replied=record.planSent&&await repliedSince(record,record.planSent.afterEventId);
      await writeJsonAtomically(location.record,replied?{...next,planApproved:true}:{...next,planSent:{afterEventId:lastEventId(await readFeedback())}});
      if(replied)return null;
    }
    return {hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:reason(input.tool_name,record.agentWork?.lastGoal??'<GOAL>')}};
  });
}

// PermissionRequest: the plan the user replied to on the Web leaves plan mode
// without a second approval in the app.
export async function claudePlanApproval(input,{directory=dataDirectory()}={}) {
  if(input?.hook_event_name!=='PermissionRequest'||input.tool_name!==plan||typeof input.session_id!=='string')return null;
  const location=claudeEntryPaths(directory,input.session_id);
  return withStoreLock(location.lock,async()=>{
    const record=await readJson(location.record);
    if(!record?.planApproved)return null;
    const next={...record};delete next.planApproved;
    await writeJsonAtomically(location.record,next);
    return {hookSpecificOutput:{hookEventName:'PermissionRequest',decision:{behavior:'allow'}}};
  });
}
