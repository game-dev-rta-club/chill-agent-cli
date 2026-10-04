// A hold preserves immutable Conversation events. Only their pending transport
// is withdrawn; the next input contains the held events and the new comment.
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {readJson,writeJsonAtomically} from './storage.mjs';
import {workspaceDirectory,readGoalContext,readFeedback,readOpenLetters,validThreadId} from './goal-store.mjs';
import {eventFor,readDeliveryState,updateDelivery,feedbackNotification} from './delivery.mjs';
import {withCodex} from './codex-client.mjs';
import {withAgentControlLock,latestControlTurn,applyAgentControlUnlocked} from './agent-control.mjs';
import {resumeDesktopTurn} from './desktop-settings.mjs';

const path=id=>join(workspaceDirectory(),'feedback-holds',`${Number(id)}.json`);
export const readFeedbackHold=id=>readJson(path(id));
const save=h=>writeJsonAtomically(path(h.goalId),h);
const marker=h=>`[chill-agent:${h.batchId}]`;
const textIn=(items,text)=>items.some(e=>e.type==='userMessage'&&e.content?.some(p=>p.type==='text'&&p.text.includes(text)));
async function queue(client,threadId){
 let cursor;const all=[];
 for(let i=0;i<100;i++){
  const page=await client.request('thread/queue/list',{threadId,limit:100,...(cursor?{cursor}:{})});
  all.push(...page.data);if(!page.nextCursor)return all;
  if(cursor===page.nextCursor)throw Error('Queue cursor did not advance.');cursor=page.nextCursor;
 }
 throw Error('Queue is too large to confirm safely.');
}
async function statesFor(goalId,threadId){
 const events=(await readFeedback()).filter(e=>e.author==='user'&&e.goalId===goalId);
 return (await Promise.all(events.map(e=>readDeliveryState(e.changeId)))).filter(s=>s?.threadId===threadId);
}
async function finishDispatch(h,{turnId=null,queueId=null}){
 for(const id of h.eventIds){const previous=await readDeliveryState(id);await updateDelivery(id,{heldBy:null,transportMessageId:h.batchId,batchId:h.batchId,batchTurnId:turnId,turnId,hookTurnId:null,work:null,workError:null,workTracking:true,queueId,queueCleared:Boolean(turnId),mayHaveSent:true,status:previous.agentReported&&previous.status==='completed'?'completed':turnId?'received':'queued'});}
 h={...h,phase:'sent',turnId,queueId};await save(h);return h;
}
// Reconcile a lost start/add response by its persisted batch marker. Never send
// the batch a second time merely because an IPC response was lost.
export async function reconcileFeedbackHold(goalId){
 const h=await readFeedbackHold(goalId);if(!h||!['dispatching','uncertain'].includes(h.phase))return h;
 if(!h.batchId){
  // A confirmed no-op failure must not leave the user stuck in a hold. Only
  // release it when every previously sent member is still in the native queue
  // and no interrupt was attempted. Missing receipts remain uncertain.
  if(h.sourceTurnId)return h;
  return withCodex(async c=>{
   const pending=await queue(c,h.threadId),states=await Promise.all(h.eventIds.map(readDeliveryState));
   if(!states.every(s=>s&&(!s.mayHaveSent||pending.some(e=>e.clientUserMessageId===(s.transportMessageId||s.messageId)))))return h;
   for(const s of states)await updateDelivery(s.eventId,{heldBy:null});
   const next={...h,phase:'sent'};await save(next);return next;
  });
 }
 return withCodex(async c=>{
  const entry=(await queue(c,h.threadId)).find(e=>e.clientUserMessageId===h.batchId);
  if(entry)return finishDispatch(h,{queueId:entry.id});
  const turns=(await c.request('thread/turns/list',{threadId:h.threadId,limit:20,itemsView:'full'})).data;
  const turn=turns.find(t=>textIn(t.items||[],marker(h)));
  return turn?finishDispatch(h,{turnId:turn.id}):h;
 });
}
export async function holdActivity(goalId,threadId){
 const h=await readFeedbackHold(goalId);
 if(!h||h.threadId!==threadId||h.phase==='sent')return null;
 const current=['dispatching','uncertain'].includes(h.phase)?await withAgentControlLock(threadId,()=>reconcileFeedbackHold(goalId)).catch(()=>h):h;
 if(current.phase==='sent')return null;
 return {threadId,goalId,targetGoalId:current.target?.goalId||goalId,eventId:current.eventIds.at(-1),turnId:current.sourceTurnId||null,holdId:current.id,status:current.phase==='paused'?'paused':'unknown',work:null,capabilities:{stop:false,resume:current.phase==='paused'}};
}

export async function pauseFeedback(goalId,input,target){
 validThreadId(input.requestId);validThreadId(input.threadId);
 return withAgentControlLock(input.threadId,async()=>{
  const {root}=await readGoalContext(goalId);if(root.threadId!==input.threadId)throw Error('Agent changed.');
  const previous=await readFeedbackHold(goalId);
  if(previous?.requestId===input.requestId)return;
  if(previous&&previous.phase!=='sent')throw Error('Checking pause. Refresh to check.');
  const states=await statesFor(goalId,input.threadId),selected=states.find(s=>s.eventId===input.eventId);
  if(!selected)throw Error('Comment not found.');
  const outstanding=states.filter(s=>!s.agentReported&&['saved','sending','queued','unknown','received','working'].includes(s.status)||['received','working'].includes(s.status));
  if(!selected.mayHaveSent&&!selected.agentReported&&outstanding.length&&outstanding.every(s=>!s.mayHaveSent)){
   if(input.turnId)throw Error('Status changed. Refresh to check.');
   const h={id:randomUUID(),requestId:input.requestId,goalId,threadId:input.threadId,target,eventIds:outstanding.map(s=>s.eventId).sort((a,b)=>a-b),phase:'holding',sourceTurnId:null,at:new Date().toISOString()};
   await save(h);
   for(const s of outstanding)await updateDelivery(s.eventId,{heldBy:h.id});
   await save({...h,phase:'paused'});return;
  }
  const turn=await latestControlTurn(input.threadId);
  const related=s=>turn&&[s.batchTurnId,s.hookTurnId,s.turnId,s.work?.turnId].includes(turn.id);
  const base=states.filter(s=>s.eventId===input.eventId||!s.agentReported&&['saved','sending','queued','unknown','received','working'].includes(s.status)||turn?.completedAt==null&&related(s));
  const batches=new Set(base.map(s=>s.batchId).filter(Boolean));
  const members=states.filter(s=>base.includes(s)||s.batchId&&batches.has(s.batchId));
  if(input.turnId&&turn?.id!==input.turnId)throw Error('Run changed. Refresh to retry.');
  let h={id:randomUUID(),requestId:input.requestId,goalId,threadId:input.threadId,target,eventIds:members.map(s=>s.eventId).sort((a,b)=>a-b),phase:'holding',sourceTurnId:null,at:new Date().toISOString()};
  await save(h);
  for(const s of members)await updateDelivery(s.eventId,{heldBy:h.id});
  try{
   await withCodex(async c=>{
    const pending=await queue(c,input.threadId),removed=new Set();
    for(const s of members){
     const key=s.transportMessageId||s.messageId,entries=pending.filter(e=>e.clientUserMessageId===key);
     for(const entry of entries){
      if(removed.has(entry.id))continue;
      const result=await c.request('thread/queue/delete',{threadId:input.threadId,queuedSubmissionId:entry.id});
      if(result.deleted===true)removed.add(entry.id);
     }
    }
    // Deletion can race the owner claiming the item. Inspect only the actual
    // latest turn's input before interrupting: never stop an unrelated Goal.
    let current,items=[];
    for(let attempt=0;attempt<8;attempt++){
     current=await latestControlTurn(input.threadId);
     if(current)items=(await c.request('thread/items/list',{threadId:input.threadId,turnId:current.id,sortDirection:'asc',limit:30})).data.filter(e=>e.turnId===current.id).map(e=>e.item);
     const matching=current&&members.some(s=>[s.batchTurnId,s.hookTurnId,s.turnId,s.work?.turnId].includes(current?.id)||textIn(items,`[chill-agent:${s.messageId}]`));
     const unconfirmed=members.some(s=>s.mayHaveSent&&!s.agentReported&&!pending.some(e=>e.clientUserMessageId===(s.transportMessageId||s.messageId)&&removed.has(e.id)));
     if(matching){
      if(current.completedAt==null){
       h.sourceTurnId=current.id;await save(h);
       await applyAgentControlUnlocked(goalId,{...input,turnId:current.id,activity:{goalId,eventId:input.eventId}},target);
       for(let i=0;i<15;i++){
        const ended=await latestControlTurn(input.threadId);
        if(ended?.id!==current.id)throw Error('Run changed. Check pause status.');
        if(ended.completedAt!=null){if(ended.status!=='interrupted')throw Error('Run ended before pausing.');break;}
        if(i===14)throw Error('Pause unconfirmed.');
        await new Promise(r=>setTimeout(r,100));
       }
      }else if(!removed.size)throw Error('Run ended.');
      break;
     }
     if(!unconfirmed)break;
     if(attempt===7)throw Error('Queue removal unconfirmed. Held to avoid duplicate runs.');
     await new Promise(r=>setTimeout(r,100));
    }
   });
   h.phase='paused';await save(h);
  }catch(error){await save({...h,phase:'uncertain',error:error.message});throw error;}
 });
}

async function dispatch(h){
 const context={...await readGoalContext(h.goalId),letters:await readOpenLetters(h.goalId)};
 if(context.root.threadId!==h.threadId)throw Error('Agent changed. Held comments were not resent.');
 const entries=[];
 for(const id of h.eventIds){
  const state=await readDeliveryState(id),event=await eventFor(id);
  entries.push({state,event});
 }
 h={...h,batchId:randomUUID(),phase:'dispatching'};await save(h);
 const text=feedbackNotification(entries,context.goal.title,'',context,h.batchId);
 try{
  const turn=await latestControlTurn(h.threadId);
  if(turn&&turn.completedAt==null){
   const result=await withCodex(c=>c.request('thread/queue/add',{threadId:h.threadId,clientUserMessageId:h.batchId,input:[{type:'text',text,text_elements:[]}]}));
   if(!result?.queuedSubmission?.id)throw Error('Queue receipt unconfirmed.');
   return finishDispatch(h,{queueId:result.queuedSubmission.id});
  }
  const result=await resumeDesktopTurn(h.threadId,text,h.batchId),turnId=result?.result?.turn?.id;
  if(!turnId)throw Error('Resume unconfirmed.');
  return finishDispatch(h,{turnId});
 }catch(error){await save({...h,phase:'uncertain',error:error.message});throw error;}
}
// Called inside the same thread lease as normal delivery. A second concurrent
// submission cannot overtake the batch or add its contents a second time.
export async function deliverHeldFeedback(event){
 let h=await readFeedbackHold(event.goalId);if(!h||h.phase==='sent')return null;
 const state=await readDeliveryState(event.changeId);
 if(h.threadId!==state.threadId)throw Error('Agent changed for held comments.');
 if(['dispatching','uncertain'].includes(h.phase)&&h.batchId){h=await reconcileFeedbackHold(event.goalId);if(h.phase==='sent')return h.eventIds.includes(event.changeId)?readDeliveryState(event.changeId):null;}
 if(h.phase!=='paused')throw Error('Checking action. Comments are saved.');
 const already=h.eventIds.includes(event.changeId);
 if(already)return state; // Retry/check of a held event does not resume it.
 h={...h,eventIds:[...h.eventIds,event.changeId].sort((a,b)=>a-b)};await save(h);
 await updateDelivery(event.changeId,{heldBy:h.id});
 await dispatch(h);return readDeliveryState(event.changeId);
}
export async function resumeHeldFeedback(goalId,input){
 validThreadId(input.threadId);validThreadId(input.holdId);
 return withAgentControlLock(input.threadId,async()=>{
  const h=await readFeedbackHold(goalId);
  if(!h||h.threadId!==input.threadId||h.id!==input.holdId||h.phase!=='paused')throw Error('Nothing to resume. Refresh to check.');
  await dispatch(h);
 });
}
