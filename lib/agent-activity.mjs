import {holdActivity,readFeedbackHold} from './feedback-hold.mjs';
import {readControlRecord} from './agent-control.mjs';
import {canControlDesktop} from './desktop-settings.mjs';
import {readGoalContext,readFeedback} from './goal-store.mjs';
import {readDelivery} from './delivery.mjs';
import {readExecution} from './goal-execution.mjs';
import {withCodex} from './codex-client.mjs';
import {workReader} from './work-output.mjs';

export {invalidateAgentObservation as invalidateActivity} from './agent-observation.mjs';
import {agentPresence,observeAgentRun as observeAgentActivity} from './agent-observation.mjs';
export {observeAgentActivity};
export function activityOwner(deliveries,turnId,record,view){
 const matching=turnId?deliveries.filter(d=>(d.work?.turnId||d.hookTurnId||d.turnId)===turnId):[];
 if(matching.length)return matching.sort((a,b)=>b.eventId-a.eventId)[0].eventId;
 return (view||record?.resumedTurnId===turnId)&&record?.activity?.eventId||null;
}
export function activityOwnerFromInput(deliveries,items){
 const texts=items.filter(e=>e.type==='userMessage').flatMap(e=>e.content||[]).filter(p=>p.type==='text').map(p=>p.text||'');
 return deliveries.filter(d=>d.messageId&&texts.some(text=>text.includes(`[chill-agent:${d.messageId}]`))).sort((a,b)=>b.eventId-a.eventId)[0]?.eventId||null;
}
export async function readAgentActivity(goalId,{fresh=false}={}){
 const {root}=await readGoalContext(goalId),threadId=root.threadId;
 if(!threadId)return null;
 const held=await holdActivity(goalId,threadId);if(held)return held;
 const feedback=(await readFeedback()).filter(e=>e.author==='user'&&e.threadId===threadId&&e.goalId===goalId);
 const deliveries=(await Promise.all(feedback.map(e=>readDelivery(e.changeId)))).filter(Boolean);
 const unsent=deliveries.filter(d=>!d.agentReported&&!d.heldBy&&!d.mayHaveSent&&d.status==='saved').sort((a,b)=>b.eventId-a.eventId)[0];
 if(unsent)return {threadId,turnId:null,eventId:unsent.eventId,goalId,targetGoalId:goalId,status:'saved',work:null,capabilities:{stop:true,resume:false}};
 const observation=await observeAgentActivity(threadId,{fresh});
 const {record,turn,view}=observation;
 const applicable=record?.activity?.goalId===goalId?record:null;
 let eventId=activityOwner(deliveries,turn?.id,applicable,view);
 // The turn may have started before the first tool/receipt or delivery-log
 // refresh. Read just its initial input, not the entire conversation history.
 if(!eventId&&turn&&turn.completedAt==null&&deliveries.some(d=>['queued','received','working','unknown'].includes(d.status))){
  const items=await withCodex(async c=>(await c.request('thread/items/list',{threadId,turnId:turn.id,sortDirection:'asc',limit:20})).data).catch(()=>[]);
  eventId=activityOwnerFromInput(deliveries,items.filter(e=>e.turnId===turn.id).map(e=>e.item));
 }
 if(!eventId||turn?.completedAt!=null&&!view){
  const waiting=deliveries.filter(d=>!d.agentReported&&!d.heldBy&&['saved','sending','queued','unknown'].includes(d.status)).sort((a,b)=>b.eventId-a.eventId)[0];
  if(waiting)return {threadId,turnId:null,eventId:waiting.eventId,goalId,targetGoalId:goalId,status:'queued',work:null,capabilities:{stop:await canControlDesktop(threadId),resume:false}};
 }
 if(!turn||!eventId)return null;
 const selection=await readExecution(threadId);
 const status=view?.status||(turn.completedAt==null?agentPresence({...observation,selection}):turn.status==='completed'?'completed':'failed');
 const selected=selection&&!selection.stoppedAt&&selection.turnId===turn.id;
 const targetGoalId=status==='working'&&selected?selection.goalId:view?.goalId||goalId;
 const available=['working','paused'].includes(status)&&await canControlDesktop(threadId);
 if((await readGoalContext(goalId)).root.threadId!==threadId)throw Error('Agent assignment changed.');
 let work=null;
 // A continuation has no new feedback receipt. Keep its output at the original
 // Activity instead of replaying that receipt or inventing another message.
 if(applicable&&(applicable.resumedTurnId===turn.id||view)&&!deliveries.some(d=>d.eventId===eventId&&(d.work?.turnId||d.hookTurnId||d.turnId)===turn.id)){
  work=await withCodex(c=>workReader(c)({threadId,turnId:turn.id,history:[]})).catch(()=>null);
 }
 return {threadId,turnId:turn.id,eventId,goalId,targetGoalId,status,work,
  capabilities:{stop:Boolean(available&&status==='working'&&turn.completedAt==null),resume:Boolean(available&&status==='paused')}};
}

// Only the stopped Goal gets Paused. No persisted Goal state is changed, and
// fresh native turn evidence supersedes the stop when Desktop starts new work.
export async function overlayPausedGoals(goals,executions){
 for(const root of goals.filter(g=>!g.parentId&&g.threadId)){
  if(!await readControlRecord(root.threadId))continue;
  const observed=await observeAgentActivity(root.threadId).catch(()=>null);
  if(!observed?.view)continue;
  const selection=await readExecution(root.threadId);
  const selected=observed.view.status==='working'&&selection&&!selection.stoppedAt&&selection.turnId===observed.turn?.id;
  const target=goals.find(g=>g.id===(selected?selection.goalId:observed.view.goalId));if(!target)continue;
  let ancestor=target;while(ancestor.parentId)ancestor=goals.find(g=>g.id===ancestor.parentId);
  if(ancestor.id!==root.id)continue;
  if(['paused','working'].includes(observed.view.status))executions.set(target.id,{goalId:target.id,threadId:root.threadId,turnId:observed.turn?.id,status:observed.view.status,activity:observed.record.activity,expiresAt:new Date(Date.now()+15000).toISOString()});
 }
 for(const goal of goals){
  const h=await readFeedbackHold(goal.id);if(!h||h.phase!=='paused')continue;
  let root=goal;while(root.parentId)root=goals.find(g=>g.id===root.parentId);
  if(root.threadId!==h.threadId)continue;
  const id=h.target?.goalId||goal.id;
  if(executions.get(id)?.status==='working')continue;
  executions.set(id,{goalId:id,threadId:h.threadId,status:'paused',activity:{goalId:goal.id,eventId:h.eventIds.at(-1)},expiresAt:new Date(Date.now()+15000).toISOString()});
 }
 return executions;
}
