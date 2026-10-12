// Optional, experimental policy for a verified native Stop. The Web scheduler
// must not infer a live Claude session or an empty native queue from these records.
import {randomUUID} from 'node:crypto';
import {storage,listGoals,readGoalContext,validId,validThreadId,continuationWorkspace,readDeliveryState,readFeedbackHold,connectionPolicyLock as locked} from './extension-api.mjs';
import {MAX_CHECKS_PER_REVISION,continuationMessage,continuationSummary} from './continuation-monitor.mjs';
const journal=storage('continuation');
const same=(a,b)=>a?.harnessId==='claude-code'&&a.harnessId===b?.harnessId&&a.sessionId===b?.sessionId&&a.contextId===b?.contextId;
async function rootFor(rootId,connection){
 validId(rootId);const {root,goal}=await readGoalContext(rootId);
 if(root.id!==goal.id||root.threadId||!same(root.connection,connection))throw Error('Auto mode must belong to this native Root conversation.');
 return root;
}
export async function confirmAction({connection,promptId,operation,input}) {
 if(!promptId)throw Error('Native Auto mode requires a main prompt identity.');
 const root=await rootFor(input.rootId,connection);
 return locked(connection,async()=>{
  const old=await journal.read(root.id);
  if(old&&!same(old.connection,connection))throw Error('Auto mode assignment changed.');
  if(operation==='configure'){
   if(typeof input.enabled!=='boolean')throw Error('Auto mode enabled must be boolean.');
   const state={...old,rootId:root.id,connection,enabled:input.enabled,attempts:old?.attempts||[],updatedAt:new Date().toISOString()};
   await journal.write(root.id,state);
   return {result:{enabled:state.enabled},context:`Auto mode for Goal #${root.id} is ${state.enabled?'On':'Off'} in this Claude conversation. The experimental Stop hook can request one continuation per substantive revision. This does not change native tool permissions or provide permanent idle delivery.`};
  }
  if(operation==='pause'){
   if(typeof input.paused!=='boolean')throw Error('Continuation pause must be boolean.');
   const state={...old,rootId:root.id,connection,enabled:old?.enabled===true,attempts:old?.attempts||[],paused:input.paused};
   await journal.write(root.id,state);
   return {result:{paused:state.paused},context:`Future automatic continuations for Goal #${root.id} are ${state.paused?'paused':'resumed'}. This does not cancel a native execution.`};
  }
  if(operation==='result'){
   validThreadId(input.attemptId);if(!['worked','no-work'].includes(input.outcome))throw Error('Invalid Auto mode result.');
   const attempt=old?.attempts.find(a=>a.id===input.attemptId)||old?.history?.find(a=>a.id===input.attemptId);
   if(!attempt)throw Error('Unknown native Auto mode attempt.');
   if(attempt.result&&attempt.result.outcome!==input.outcome)throw Error('A different result is already recorded.');
   if(!attempt.result){attempt.result={outcome:input.outcome,at:new Date().toISOString()};attempt.nativePromptId=promptId;attempt.phase='reported';await journal.write(root.id,old);}
   return {result:attempt.result,context:`Auto mode result recorded for Goal #${root.id}: ${attempt.result.outcome}. The native response still needs to end; this does not complete the Goal.`};
  }
  throw Error('Unsupported native continuation action.');
 });
}
async function snapshot(rootId,connection){
 const facts=await continuationWorkspace(rootId);
 if(!same(facts.root.connection,connection)||facts.root.threadId)throw Error('Auto mode assignment changed.');
 // Any assigned Goal may hold input for this conversation, not just the Root
 // selected for this check. Preserve uncertain offers and other Roots' holds.
 const assigned=facts.goals.filter(g=>{while(g.parentId)g=facts.goals.find(p=>p.id===g.parentId);return same(g.connection,connection);});
 const holds=await Promise.all(assigned.map(g=>readFeedbackHold(g.id)));
 const events=facts.allEvents.filter(e=>e.author==='user'&&same(e.connection,connection));
 const deliveries=await Promise.all(events.map(async e=>(await readDeliveryState(e.changeId))||{status:'saved'}));
 return {rootId,nativeStop:true,rootTitle:facts.root.title,revision:facts.revision,context:facts.context,
  paused:holds.some(h=>h&&h.phase!=='sent'),pending:deliveries.some(d=>d.status!=='unlinked'&&(!d.agentReported||!['completed','failed'].includes(d.status)))};
}
export async function onStop({connection,promptId,checkpointId,generation}) {
 return locked(connection,async()=>{
  const roots=(await listGoals()).filter(g=>!g.parentId&&!g.threadId&&same(g.connection,connection));
  let unresolved=false;
  for(const root of roots){
   const state=await journal.read(root.id);if(!state||!same(state.connection,connection))continue;
   const last=state.attempts.at(-1);
   if(last?.result&&last.nativePromptId===promptId&&!last.completedAt){last.completedAt=new Date().toISOString();last.phase='completed';await journal.write(root.id,state);}
   if(last&&!last.completedAt)unresolved=true;
  }
  // Another Root shares this native conversation and may already have received
  // a request. Do not route around its missing receipt through the next Root.
  if(unresolved)return null;
  for(const root of roots){
   let state=await journal.read(root.id);if(!state||!same(state.connection,connection))continue;
   const last=state.attempts.at(-1);
   // A result alone never means the response has finished. Stop must match the
   // main prompt which confirmed that receipt. Unknown offers remain reserved.
   if(!state.enabled||state.paused)continue;
   const facts=await snapshot(root.id,connection);
   if(facts.paused||facts.pending){state.status=facts.paused?'paused':'feedback-pending';await journal.write(root.id,state);continue;}
   if(last&&!last.completedAt){state.status='awaiting-receipt';await journal.write(root.id,state);continue;}
   if(facts.revision!==state.revision){state.history=[...(state.history||[]),...state.attempts];state.attempts=[];state.revision=facts.revision;}
   if(state.attempts.length>=MAX_CHECKS_PER_REVISION){state.status='exhausted';await journal.write(root.id,state);continue;}
   // Re-read saved facts immediately before reserving. Hook execution holds the
   // native entry lock, so a new prompt/generation cannot reuse this checkpoint.
   const fresh=await snapshot(root.id,connection);
   if(fresh.paused||fresh.pending||fresh.revision!==facts.revision)continue;
   const attempt={id:randomUUID(),at:new Date().toISOString(),phase:'uncertain',checkpointId,generation,
    goalId:fresh.context.focus.id,goalTitle:fresh.context.focus.title};
   attempt.message=continuationMessage(fresh,1,attempt.id);attempt.summary=continuationSummary(fresh);
   state.attempts.push(attempt);state.status='awaiting-receipt';state.checkedAt=new Date().toISOString();
   await journal.write(root.id,state); // Persist before native Stop output; never resend automatically.
   return attempt.message;
  }
  return null;
 });
}
