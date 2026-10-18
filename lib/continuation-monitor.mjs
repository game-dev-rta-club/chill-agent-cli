import {continuationExcerpt} from './continuation-excerpt.mjs';
// Optional policy layer. The harness adapter supplies facts; this module decides when to ask.
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {requireProtocol,storage,policyLock as withAgentControlLock,observe as continuationObservation,eligibility as continuationEligibility,enqueue as enqueueContinuation,dataDirectory,validThreadId,readGoalContext,agentGuide,workspacePort} from './extension-api.mjs';
import {recordHidden} from './hidden-failure.mjs';
requireProtocol(1);
const journal=storage('continuation');
export const MAX_CHECKS_PER_REVISION=1;
export const readMonitor=journal.read;
const save=journal.write;
export async function configureMonitor(id,enabled){
 const {root,goal}=await readGoalContext(id);if(root.id!==goal.id||!root.threadId)throw Error('An assigned Root Goal is required.');
 return withAgentControlLock(root.threadId,async()=>{
  const old=await readMonitor(id);
  // Enabling does not erase an uncertain transmission or reset the attempt cap.
  const next={...old,rootId:id,threadId:root.threadId,enabled,attempts:old?.attempts||[],idleSince:null,updatedAt:new Date().toISOString()};
  await save(id,next);return next;
 });
}
const quote=value=>"'"+String(value).replaceAll("'", "'\\''")+"'";
export function continuationSummary(f){
 const goals=f.context?.goals,letters=f.context?.letters||[];
 if(goals?.unfinished)return `Look for work to continue in ${goals.unfinished} unfinished ${goals.unfinished===1?'Goal':'Goals'}.`;
 if(letters.length)return 'Review pending Letters and continue any independent work.';
 return goals?'Check for anything missed in the completed Goals.':'Review the agreed work and continue anything you can advance.';
}
export function continuationMessage(f,_attempt,id){
 const command=`PORT=${quote(workspacePort())} CHILL_AGENT_DATA_DIR=${quote(dataDirectory())} ${quote(process.execPath)} ${quote(join(dataDirectory(),'runtime','chill.mjs'))}`;
 const letters=f.context?.letters||[],goals=f.context?.goals;
 const filter=goals?.unfinished?' --state unfinished':letters.length?' --letters':'';
 // Older CLI releases do not expose the compact review contract. Their tree is still bounded to metadata.
 const review=goals?`chill goal review --id ${f.rootId}${filter}`:`chill goal tree --id ${f.rootId}`;
 const entry=agentGuide();
 const guide=entry?join(dirname(entry),'references/auto-mode/continue.md'):null;
 const workflow=guide?`Workflow: ${JSON.stringify(guide)}. Read this guide for the combined continuation and stopping review; reuse it if already read.`:'Select agreed work with `chill goal work --id <GOAL>`. Use `chill goal letter` only for a necessary user reply, choice or permission; report results with `chill goal comment`. Review the next action before stopping. Check criteria and descendants before marking Done.';
 const state=!goals?'Revisit the agreed work and carry on with anything you can move forward.'
  :goals.unfinished?`There ${goals.unfinished===1?'is 1 unfinished Goal':`are ${goals.unfinished} unfinished Goals`}${goals.waiting?`, including ${goals.waiting} Waiting`:''}. Start with the short list below and pick up anything you can move forward.`
  :letters.length?'Every Goal is marked Done, with Letters still open. Read the questions and identify which actions actually depend on their answers; continue other agreed work.'
  :'Every Goal is marked Done, and no Letters are waiting for the user. Check for a concrete omission in the agreed outcome; otherwise leave the project at rest.';
 const unfinished=f.unfinished?.length?`\nFeedback you took up but have not recorded as done: ${f.unfinished.slice(0,5).map(u=>`#${u.eventId} (Goal #${u.goalId})`).join(', ')}${f.unfinished.length>5?`, and ${f.unfinished.length-5} more`:''}. Finish it and reply, or tell the user in a comment what keeps it open.\n`:'';
 const waiting=letters.length?'\nOpen Letters for the user’s attention: '+letters.slice(0,3).map(l=>`Goal #${l.goalId}: “${continuationExcerpt(l.title,100)}”`).join('; ')+(letters.length>3?`; and ${letters.length-3} more.`:'.')+'\n':'';
 return `=== chill-agent · Keep going ===

Auto mode is On. Choose and carry out the next useful action toward the agreed goal. In this same pass, check any reason to stop against the original request and actual results; do not wait for a second nudge or user acknowledgement. Report results in Comments. Before stopping, review the next action; use a Letter only when a user reply, choice or permission is needed.

${state}
${unfinished}${waiting}
${f.nativeStop?'Observed: the native main response has ended; no saved Web input or continuation pause was found. Claude retains control of its own input ordering and permissions.\nIf the next step waits for something outside chill (CI, a build), schedule a check before ending, or nothing wakes you when it finishes: `chill connection wake --in <minutes> --reason \'<what you wait for>\'`.':'Observed: the run has ended; no pending delivery, queued message or manual pause was found.'}

Open the index, then a relevant Goal with \`chill goal show --id <GOAL> --format text --section context\`.
${workflow}
Continue within the agreement, preserving other Goals' queues and manual pauses.

\`\`\`sh
chill() { ${command} "$@"; }
${review}
\`\`\`

Save actual results to the Web, then return the outcome below. If there is no work, replace \`worked\` with \`no-work\` and do not post a no-work report to the Web. This check does not expand the agreed scope.
\`\`\`sh
chill monitor result --id ${f.rootId} --attempt ${id} --outcome worked
\`\`\``;
}

export async function reportMonitorResult(rootId,attemptId,outcome,threadId){
 validThreadId(attemptId);
 if(!['worked','no-work'].includes(outcome))throw Error('Outcome must be worked or no-work.');
 const before=await readMonitor(rootId);
 if(!before||before.threadId!==threadId)throw Error('Result must come from the assigned chat.');
 return withAgentControlLock(before.threadId,async()=>{
  const state=await readMonitor(rootId);
  if(state.threadId!==threadId)throw Error('Assignment changed.');
  const attempt=state.attempts.find(a=>a.id===attemptId)||state.history?.find(a=>a.id===attemptId);
  if(!attempt)throw Error('Unknown monitor attempt.');
  if(attempt.result){
   if(attempt.result.outcome!==outcome)throw Error('A different result is already recorded.');
   return attempt.result;
  }
  attempt.result={outcome,at:new Date().toISOString()};
  await save(rootId,state);return attempt.result;
 });
}
export function createMonitorRunner({read=readMonitor,write=save,observe=continuationObservation,send=enqueueContinuation,lock=withAgentControlLock,now=Date.now}={}){
 return async rootId=>{
  const configured=await read(rootId);if(!configured?.enabled)return {status:'disabled'};
  return lock(configured.threadId,async()=>{
   let state=await read(rootId);if(!state?.enabled)return {status:'disabled'};
   const last=state.attempts.at(-1);let facts;
   try{facts=await observe(rootId,last);}catch(error){recordHidden('continuation-monitor.observe',error);state={...state,idleSince:null,status:'unknown',error:error.message,checkedAt:new Date(now()).toISOString()};await write(rootId,state);return state;}
   if(facts.threadId!==state.threadId){state={...state,enabled:false,status:'assignment-changed'};await write(rootId,state);return state;}
   const time=now();const status=continuationEligibility(facts);
   state={...state,checkedAt:new Date(time).toISOString(),facts,error:null,status};
   // Recover via positive native evidence only. A missing receipt never permits a resend.
   if(last&&facts.pendingWork){last.turnId=facts.pendingWork.turnId;last.work=facts.pendingWork;}
   if(last&&facts.pendingWork?.endedAt){last.completedAt=facts.pendingWork.endedAt;last.phase='completed';}
   if(last&&facts.pendingWork&&!facts.pendingWork.endedAt)last.phase='running';
   if(last&&facts.queue.some(q=>q.messageId===last.id))last.phase='queued';
   const unresolved=last&&!last.completedAt;
   // Only user feedback and substantive Goal/Deliverable content define a revision.
   // Never discard an unresolved send when the revision changes.
   if(!unresolved&&facts.revision!==state.revision){
    state.history=[...(state.history||[]),...state.attempts];state.attempts=[];state.revision=facts.revision;
   }
   if(status!=='idle'){state.idleSince=null;await write(rootId,state);return state;}
   if(unresolved){state.status='awaiting-receipt';state.idleSince=null;await write(rootId,state);return state;}
   if(state.attempts.length>=MAX_CHECKS_PER_REVISION){state.status='exhausted';await write(rootId,state);return state;}
   const key=JSON.stringify([facts.turn.id,facts.revision]);
   // A fresh full snapshot under the same lock immediately before enqueueing.
   let fresh;try{fresh=await observe(rootId,null);}catch(error){recordHidden('continuation-monitor.observe-fresh',error);state.status='unknown';state.idleSince=null;state.error=error.message;await write(rootId,state);return state;}
   if(fresh.threadId!==state.threadId||continuationEligibility(fresh)!=='idle'||JSON.stringify([fresh.turn.id,fresh.revision])!==key){state.status='changed';state.idleSince=null;await write(rootId,state);return state;}
   const focus=fresh.context?.focus;
   const attempt={id:randomUUID(),at:new Date(time).toISOString(),phase:'sending',
     goalId:focus?.id||rootId,goalTitle:focus?.title||fresh.rootTitle||null};
   const text=continuationMessage(fresh,state.attempts.length+1,attempt.id);
   // Keep the exact request, not a reconstruction using later templates/facts.
   attempt.message=text;attempt.summary=continuationSummary(fresh);
   state.attempts.push(attempt);state.idleSince=null;state.status='sending';state.facts=fresh;
   await write(rootId,state); // durable reservation before side effect
   try{const result=await send(fresh,text,attempt.id);if(!result?.queuedSubmission?.id)throw Error('No queue receipt');attempt.queueId=result.queuedSubmission.id;attempt.phase='queued';state.status='queued';}
   catch(error){recordHidden('continuation-monitor.send',error);attempt.phase='uncertain';state.status='uncertain';state.error=error.message;}
   await write(rootId,state);return state;
  });
 };
}
export const tickMonitor=createMonitorRunner();
