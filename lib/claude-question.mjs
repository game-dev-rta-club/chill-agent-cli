// A question Claude asks in its own app (AskUserQuestion) stops the work there,
// out of the Web's sight. While it waits, the Goal it works on carries the
// question as a Letter, so the Web counts and notifies it like any Letter; the
// answer, or any later step of the conversation, closes that Letter.
import {dataDirectory} from './data-directory.mjs';
import {claudeEntryPaths,validEntry} from './claude-entry.mjs';
import {readJson,withStoreLock,writeJsonAtomically} from './storage.mjs';
import {appendAgentComment,closeLetter} from './goal-store.mjs';
import {hidden} from './hidden-failure.mjs';

export const questionTool='AskUserQuestion';
const asking=input=>['PreToolUse','PermissionRequest'].includes(input.hook_event_name)&&input.tool_name===questionTool;

function letterText(questions){
  const parts=questions.map(q=>[`**${q.question}**`,...(q.options||[]).map(o=>`- ${o.label}${o.description?` — ${o.description}`:''}`)].join('\n'));
  return ['Claude is waiting for your answer in its own app. Answer there to continue.',...parts].join('\n\n');
}
const answerText=answers=>Object.entries(answers||{}).map(([q,a])=>`${q} = ${a}`).join('; ');

export async function settleClaudeQuestion(input,{directory=dataDirectory()}={}){
  if(!input||input.agent_id!=null||typeof input.session_id!=='string')return null;
  const location=claudeEntryPaths(directory,input.session_id);
  return withStoreLock(location.lock,async()=>{
    const record=await readJson(location.record);
    if(!validEntry(record,input.session_id))return null;
    const open=record.question;
    if(asking(input)){
      // PreToolUse and its PermissionRequest are the same question.
      if(open)return open;
      const goalId=record.agentWork?.lastGoal,questions=input.tool_input?.questions;
      if(!goalId||!Array.isArray(questions)||!questions.length)return null;
      const letter=await appendAgentComment({goalId,type:'letter',title:questions[0].header||'Question in Claude',text:letterText(questions)});
      const question={toolUseId:input.tool_use_id,goalId,letterId:letter.id};
      await writeJsonAtomically(location.record,{...record,question});
      return question;
    }
    if(!open)return null;
    // The answer arrives with the tool's result; anything else means the question is gone.
    const answered=input.hook_event_name==='PostToolUse'&&input.tool_use_id===open.toolUseId;
    const reason=answered?`Answered in Claude: ${answerText(input.tool_response?.answers)}`:'No longer asked in Claude.';
    await closeLetter(open.goalId,open.letterId,reason).catch(hidden('claude-question.close'));
    const next={...record};delete next.question;
    await writeJsonAtomically(location.record,next);
    return null;
  });
}
