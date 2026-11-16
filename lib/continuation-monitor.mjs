import {continuationExcerpt} from './continuation-excerpt.mjs';
// End-of-turn policy for Autonomy. The harness adapter supplies facts; this module decides when to ask.
import {randomUUID} from 'node:crypto';
import {requireProtocol,policyLock as withAgentControlLock,observe as continuationObservation,eligibility as continuationEligibility,enqueue as enqueueContinuation,chillCommand} from './extension-api.mjs';
import {autonomyLines,focusedTurns} from './autonomy.mjs';
import {goalRule} from './goal-rule.mjs';
import {recordHidden} from './hidden-failure.mjs';
import {readTurnCheck,writeTurnCheck} from './turn-checks.mjs';
import {recordLevelsTold} from './autonomy-notice.mjs';
requireProtocol(1);
export const MAX_CHECKS_PER_REVISION=1;
// How long a request that no run, queue entry or busy chat shows stays open.
export const LOST_AFTER_MS=10*60*1000;
export function continuationSummary(f){
 const goals=f.context?.goals,letters=f.context?.letters||[];
 if(goals?.unfinished)return `Look for work to continue in ${goals.unfinished} unfinished ${goals.unfinished===1?'Goal':'Goals'}.`;
 if(letters.length)return 'Review pending Letters and continue any independent work.';
 return goals?'Check for anything missed in the completed Goals.':'Review the agreed work and continue anything you can advance.';
}
// What the saved record already says about the remaining work, so a nudge
// needs no command to know it.
function remainingWork(f){
 const letters=f.context?.letters||[],goals=f.context?.goals;
 const state=!goals?'Revisit the agreed work and carry on with anything you can move forward.'
  :goals.unfinished?`There ${goals.unfinished===1?'is 1 unfinished Goal':`are ${goals.unfinished} unfinished Goals`}${goals.waiting?`, including ${goals.waiting} Waiting`:''}.`
  :letters.length?'Every Goal is marked Done, with Letters still open. Continue work that does not depend on their answers.'
  :'Every Goal is marked Done, and no Letters are waiting for the user. Check for a concrete omission; otherwise leave the project at rest.';
 const unfinished=f.unfinished?.length?`\nFeedback handed to you that still waits for your reply: ${f.unfinished.slice(0,5).map(u=>`#${u.goalId} ${u.number?`C${u.number}`:`comment`} (eventId ${u.eventId})`).join(', ')}${f.unfinished.length>5?`, and ${f.unfinished.length-5} more`:''}. Finish it and reply on its Goal, or tell the user there what keeps it open.\n`:'';
 const waiting=letters.length?'\nLetters awaiting the user: '+letters.slice(0,3).map(l=>`Goal #${l.goalId}: “${continuationExcerpt(l.title,100)}”`).join('; ')+(letters.length>3?`; and ${letters.length-3} more.`:'.')+'\n':'';
 return {state,unfinished,waiting};
}
// The rules every harness's end-of-turn check shares, so Claude's Stop and
// Codex's poller decide the same way; each harness only observes its agent and
// carries the request.

// The request's run has ended: chill records the result itself, worked when
// the agent left something on the Web since the request (`progress`).
export function settle(last,{progress,at,endedAt=at}){
 if(!last.result&&last.progress)last.result={outcome:progress!==last.progress?'worked':'no-work',at,observed:true};
 last.completedAt=endedAt;last.phase=last.result?'completed':'ended';
}
// A new revision (user feedback, substantive Goal or Canvas content, Autonomy)
// allows a new check; the earlier attempts move to history.
export function startRevision(state,revision){
 if(revision===state.revision)return;
 state.history=[...(state.history||[]),...state.attempts];state.attempts=[];state.revision=revision;
}
export const checksLeft=state=>state.attempts.length<MAX_CHECKS_PER_REVISION;
// Reserve the one request of this revision, with its exact text; the caller
// saves the record before it carries the request, and never resends it.
export function reserve(state,{plan,facts,at,...fields}){
 const attempt={id:randomUUID(),at,...fields,level:plan.level,goalId:plan.goalId,goalTitle:plan.goalTitle,progress:facts.progress};
 attempt.message=continuationMessage({...facts,autonomy:plan});attempt.summary=continuationSummary(facts);
 state.attempts.push(attempt);
 return attempt;
}

// One look back before the turn is handed over, built from the conversation's
// Autonomy plan (autonomy turnPlan): its Roots above Normal, each with what
// its level asks. It names no command, so a turn with nothing left ends in a
// single response; chill records the result when the run that received it ends.
export function continuationMessage(f){
 const {state,unfinished,waiting}=remainingWork(f);
 const plan=f.autonomy;
 return `=== chill-agent · Keep going ===

${plan?`The user set Autonomy, how far you go on your own, for the Root Goals of this conversation:
${autonomyLines(plan)}

${focusedTurns}

- If there is work, choose one purpose and carry it out now, then report the results and the next approach briefly in a Comment on its Goal.
- If there is none, end with one short line. Run no commands and write no turn summary; chill records this check by itself.

After a turn, chill sends this message again only if, since it was last sent, the user commented, anyone (you included) edited a Goal or the Canvas, or a level changed. Otherwise, even after a turn of work and your Comment, the conversation waits for the user or for a check you scheduled. End the turn anyway, and do not edit a Goal or the Canvas only to keep the conversation going.`:`Before you hand the turn back to the user, ask yourself once: is there agreed work left that you can move forward without the user?

- If there is work, carry it out now and report the results in a Comment on its Goal.
- If there is none, end with one short line. Run no commands and write no turn summary; chill records this check by itself.`}

${state}
${unfinished}${waiting}
${f.wake?`Waiting on CI or a build? Schedule a check before ending: \`${chillCommand()} agent wake --in <minutes> --reason '<what you wait for>'\`.\n`:''}${goalRule}`;
}
// A polled agent's end-of-turn check for one chat, kept in its check record
// (turn-checks). `plan()` is the chat's Autonomy plan (null when no Root asks
// for a check); the Root it names is the one observed.
export function createMonitorRunner({plan,read=readTurnCheck,write=writeTurnCheck,observe=continuationObservation,send=enqueueContinuation,lock=withAgentControlLock,tell=recordLevelsTold,now=Date.now}={}){
 return async()=>{
  const planned=await plan();
  if(!planned)return {status:'off'};
  return lock(planned.threadId,async()=>{
   const {owner,rootId}=planned,save=state=>write(owner,state);
   let state=await read(owner);
   const last=state.attempts.at(-1);let facts;
   try{facts=await observe(rootId,last);}catch(error){recordHidden('continuation-monitor.observe',error);state={...state,status:'unknown',error:error.message,checkedAt:new Date(now()).toISOString()};await save(state);return state;}
   if(facts.threadId!==state.owner.id){state={...state,status:'changed'};await save(state);return state;}
   const time=now();const status=continuationEligibility(facts);
   state={...state,checkedAt:new Date(time).toISOString(),facts,error:null,status};
   // Recover via positive native evidence only. An unseen run never permits a resend.
   if(last&&facts.pendingWork){last.turnId=facts.pendingWork.turnId;last.work=facts.pendingWork;}
   // The run that received the request has ended: chill records the result
   // itself, worked when the agent left something on the Web.
   if(last&&facts.pendingWork?.endedAt&&!last.completedAt)settle(last,{progress:facts.progress,at:new Date(time).toISOString(),endedAt:facts.pendingWork.endedAt});
   if(last&&facts.pendingWork&&!facts.pendingWork.endedAt)last.phase='running';
   if(last&&facts.queue.some(q=>q.messageId===last.id))last.phase='queued';
   // A request no run or queue entry shows while the chat sits idle never
   // reached it. After a while it is closed, never resent, so the chat is not
   // kept waiting for it and the next revision gets its check.
   if(last&&!last.completedAt&&!facts.pendingWork&&status==='idle'&&last.phase!=='queued'&&time-Date.parse(last.at)>=LOST_AFTER_MS){last.phase='lost';last.completedAt=new Date(time).toISOString();}
   const unresolved=last&&!last.completedAt;
   // User feedback, substantive Goal/Canvas content and Autonomy define a
   // revision. Never discard an unresolved send when the revision changes.
   if(!unresolved)startRevision(state,planned.revision);
   if(status!=='idle'){await save(state);return state;}
   if(unresolved){state.status='awaiting-run';await save(state);return state;}
   if(!checksLeft(state)){state.status='exhausted';await save(state);return state;}
   const key=JSON.stringify([facts.turn.id,facts.revision,planned.revision]);
   // A fresh full snapshot under the same lock immediately before enqueueing.
   let fresh,again;try{fresh=await observe(rootId,null);again=await plan();}catch(error){recordHidden('continuation-monitor.observe-fresh',error);state.status='unknown';state.error=error.message;await save(state);return state;}
   if(fresh.threadId!==state.owner.id||continuationEligibility(fresh)!=='idle'||!again||JSON.stringify([fresh.turn.id,fresh.revision,again.revision])!==key){state.status='changed';await save(state);return state;}
   const attempt=reserve(state,{plan:again,facts:fresh,at:new Date(time).toISOString(),phase:'sending'}),text=attempt.message;
   state.status='sending';state.facts=fresh;
   await save(state); // durable reservation before side effect
   await tell(owner,again.roots); // the request states these levels (autonomy-notice)
   try{const result=await send(fresh,text,attempt.id);if(!result?.queuedSubmission?.id)throw Error('No queue receipt');attempt.queueId=result.queuedSubmission.id;attempt.phase='queued';state.status='queued';}
   catch(error){recordHidden('continuation-monitor.send',error);attempt.phase='uncertain';state.status='uncertain';state.error=error.message;}
   await save(state);return state;
  });
 };
}
