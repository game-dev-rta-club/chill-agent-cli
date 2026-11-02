import {continuationExcerpt} from './continuation-excerpt.mjs';
// End-of-turn policy for Autonomy. The harness adapter supplies facts; this module decides when to ask.
import {randomUUID} from 'node:crypto';
import {requireProtocol,storage,policyLock as withAgentControlLock,observe as continuationObservation,eligibility as continuationEligibility,enqueue as enqueueContinuation,chillCommand} from './extension-api.mjs';
import {autonomyLines} from './autonomy.mjs';
import {goalRule} from './goal-rule.mjs';
import {ownerless} from './continuation-owner.mjs';
import {recordHidden} from './hidden-failure.mjs';
import {sameOwner} from './owner.mjs';
requireProtocol(1);
const journal=storage('continuation');
export const MAX_CHECKS_PER_REVISION=1;
export const readMonitor=journal.read;
const save=journal.write;
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
 const unfinished=f.unfinished?.length?`\nFeedback handed to you that still waits for your reply: ${f.unfinished.slice(0,5).map(u=>`comment ${u.eventId} on Goal #${u.goalId}`).join(', ')}${f.unfinished.length>5?`, and ${f.unfinished.length-5} more`:''}. Finish it and reply on its Goal, or tell the user there what keeps it open.\n`:'';
 const waiting=letters.length?'\nLetters awaiting the user: '+letters.slice(0,3).map(l=>`Goal #${l.goalId}: “${continuationExcerpt(l.title,100)}”`).join('; ')+(letters.length>3?`; and ${letters.length-3} more.`:'.')+'\n':'';
 return {state,unfinished,waiting};
}
// The rules every harness's end-of-turn check shares, so Claude's Stop and
// Codex's poller decide the same way; each harness only observes its agent and
// carries the request.

// The journal record for the Root's current `owner`, given how the record
// relates to it (continuation-owner journalOwnership). The same owner's stays;
// one written before any owner just takes the owner; one the owner takes over
// keeps its Autonomy, its unconfirmed request closed into history, never
// resent, and its revision cleared so the new owner gets its own check;
// another owner's starts over, at Normal. Null when there is no record.
export function journalFor(state,owner,ownership,at){
 if(ownership==='none'||ownership==='same')return state??null;
 if(ownerless(state))return {...state,owner,attempts:state.attempts||[]};
 const closed=(state.attempts||[]).map(a=>a.completedAt?a:{...a,phase:'assignment-changed',completedAt:at});
 if(ownership==='adopted')return {...state,owner,history:[...(state.history||[]),...closed],attempts:[],revision:null,status:'assignment-changed',updatedAt:at};
 return {rootId:state.rootId,owner,history:[...(state.history||[]),...closed],attempts:[],updatedAt:at};
}
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

Before you hand the turn back to the user, do once what each level asks.`:'Before you hand the turn back to the user, ask yourself once: is there agreed work left that you can move forward without the user?'}

- If there is work, carry it out now and report the results in a Comment on its Goal.
- If there is none, end with one short line. Run no commands and write no turn summary; chill records this check by itself.

${state}
${unfinished}${waiting}
${f.wake?`Waiting on CI or a build? Schedule a check before ending: \`${chillCommand()} agent wake --in <minutes> --reason '<what you wait for>'\`.\n`:''}${goalRule}`;
}
// A polled agent's end-of-turn check for one Root. `plan(rootId)` is the
// Autonomy plan of the chat that owns it (null when no Root asks for a check);
// only the Root the plan names checks, so a chat gets one message.
export function createMonitorRunner({plan,read=readMonitor,write=save,observe=continuationObservation,send=enqueueContinuation,lock=withAgentControlLock,now=Date.now}={}){
 return async rootId=>{
  const planned=await plan(rootId);
  if(!planned||planned.rootId!==rootId)return {status:'off'};
  return lock(planned.threadId,async()=>{
   const owner=planned.owner;
   // The plan lists a Root only when its record is this chat's or one it takes
   // over (an earlier owner's, or one written before any chat worked on it).
   const stored=await read(rootId);
   let state=journalFor(stored,owner,!stored?'none':sameOwner(stored.owner,owner)?'same':'adopted',new Date(now()).toISOString())??{rootId,owner,attempts:[]};
   const last=state.attempts.at(-1);let facts;
   try{facts=await observe(rootId,last);}catch(error){recordHidden('continuation-monitor.observe',error);state={...state,status:'unknown',error:error.message,checkedAt:new Date(now()).toISOString()};await write(rootId,state);return state;}
   if(facts.threadId!==state.owner.id){state={...state,status:'changed'};await write(rootId,state);return state;}
   const time=now();const status=continuationEligibility(facts);
   state={...state,checkedAt:new Date(time).toISOString(),facts,error:null,status};
   // Recover via positive native evidence only. An unseen run never permits a resend.
   if(last&&facts.pendingWork){last.turnId=facts.pendingWork.turnId;last.work=facts.pendingWork;}
   // The run that received the request has ended: chill records the result
   // itself, worked when the agent left something on the Web.
   if(last&&facts.pendingWork?.endedAt&&!last.completedAt)settle(last,{progress:facts.progress,at:new Date(time).toISOString(),endedAt:facts.pendingWork.endedAt});
   if(last&&facts.pendingWork&&!facts.pendingWork.endedAt)last.phase='running';
   if(last&&facts.queue.some(q=>q.messageId===last.id))last.phase='queued';
   const unresolved=last&&!last.completedAt;
   // User feedback, substantive Goal/Canvas content and Autonomy define a
   // revision. Never discard an unresolved send when the revision changes.
   if(!unresolved)startRevision(state,planned.revision);
   if(status!=='idle'){await write(rootId,state);return state;}
   if(unresolved){state.status='awaiting-run';await write(rootId,state);return state;}
   if(!checksLeft(state)){state.status='exhausted';await write(rootId,state);return state;}
   const key=JSON.stringify([facts.turn.id,facts.revision,planned.revision]);
   // A fresh full snapshot under the same lock immediately before enqueueing.
   let fresh,again;try{fresh=await observe(rootId,null);again=await plan(rootId);}catch(error){recordHidden('continuation-monitor.observe-fresh',error);state.status='unknown';state.error=error.message;await write(rootId,state);return state;}
   if(fresh.threadId!==state.owner.id||continuationEligibility(fresh)!=='idle'||again?.rootId!==rootId||JSON.stringify([fresh.turn.id,fresh.revision,again.revision])!==key){state.status='changed';await write(rootId,state);return state;}
   const attempt=reserve(state,{plan:again,facts:fresh,at:new Date(time).toISOString(),phase:'sending'}),text=attempt.message;
   state.status='sending';state.facts=fresh;
   await write(rootId,state); // durable reservation before side effect
   try{const result=await send(fresh,text,attempt.id);if(!result?.queuedSubmission?.id)throw Error('No queue receipt');attempt.queueId=result.queuedSubmission.id;attempt.phase='queued';state.status='queued';}
   catch(error){recordHidden('continuation-monitor.send',error);attempt.phase='uncertain';state.status='uncertain';state.error=error.message;}
   await write(rootId,state);return state;
  });
 };
}
