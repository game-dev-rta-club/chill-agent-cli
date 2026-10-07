// Codex facts for continuation. No scheduling policy lives in this adapter.
import {continuationWorkspace} from './continuation-workspace.mjs';
import {readDeliveryState} from './delivery.mjs';
import {readExecution,heartbeatTTL} from './goal-execution.mjs';
import {readControlRecord} from './agent-control.mjs';
import {readFeedbackHold} from './feedback-hold.mjs';
import {withCodex} from './codex-client.mjs';
import {workReader} from './work-output.mjs';

export async function continuationObservation(rootId,pending,{connect=withCodex,now=Date.now()}={}) {
 const {root,goals,branch,allEvents,revision,userEvent,context}=await continuationWorkspace(rootId);
 if(!root.threadId)throw Error('An assigned Root Goal is required.');
 const threadId=root.threadId;
 const events=allEvents.filter(e=>e.author==='user'&&e.threadId===threadId);
 const deliveries=await Promise.all(events.map(async e=>(await readDeliveryState(e.changeId))||{eventId:e.changeId,status:'saved'}));
 const holds=await Promise.all(goals.map(g=>readFeedbackHold(g.id)));
 const control=await readControlRecord(threadId),execution=await readExecution(threadId);
 const selected=branch.find(g=>g.id===execution?.goalId);
 if(selected)context.focus={id:selected.id,title:selected.title};
 const facts={rootId,threadId,observedAt:new Date(now).toISOString(),rootState:root.state,
  rootTitle:root.title,context,revision,lastUserEvent:userEvent,
  paused:holds.some(h=>h?.threadId===threadId&&['holding','paused','dispatching','uncertain'].includes(h.phase)),
  pendingFeedback:deliveries.filter(d=>!d.agentReported&&!['completed','unlinked'].includes(d.status)).map(d=>({eventId:d.eventId,status:d.status})),
  heartbeatAt:execution?.heartbeatAt||null,heartbeatFresh:Boolean(execution&&!execution.stoppedAt&&now-Date.parse(execution.heartbeatAt)<heartbeatTTL)};
 return connect(async client=>{
  const response=await client.request('thread/read',{threadId,includeTurns:false});
  const turns=await client.request('thread/turns/list',{threadId,limit:1,itemsView:'notLoaded'});
  if(!response.thread||!Array.isArray(turns.data))throw Error('Invalid harness snapshot');
  const turn=turns.data[0]||null;const queue=[];let cursor;const seen=new Set();
  do{
   const page=await client.request('thread/queue/list',{threadId,limit:100,...(cursor?{cursor}:{})});
   if(!Array.isArray(page.data))throw Error('Invalid queue snapshot');queue.push(...page.data);cursor=page.nextCursor;
   if(cursor&&seen.has(cursor))throw Error('Queue cursor did not advance');if(cursor)seen.add(cursor);
   if(seen.size>100)throw Error('Queue snapshot incomplete');
  }while(cursor);
  const pendingWork=pending?await workReader(client)({threadId,messageId:pending.id,matchText:`chill monitor result --id ${rootId} --attempt ${pending.id} --outcome worked`,history:[{status:'saved',at:pending.at}]}):null;
  // Re-read after the queue: never treat a changing latest turn as idle.
  const again=await client.request('thread/turns/list',{threadId,limit:1,itemsView:'notLoaded'});
  const latest=again.data?.[0]||null;
  return {...facts,heartbeatFresh:facts.heartbeatFresh&&!(execution?.turnId===turn?.id&&turn?.completedAt!=null),harnessState:response.thread.status?.type||'unknown',turn,
   stable:JSON.stringify([turn?.id,turn?.completedAt,turn?.status])===JSON.stringify([latest?.id,latest?.completedAt,latest?.status]),
   paused:facts.paused||Boolean(control?.action==='stop'&&control.turnId===turn?.id)||(turn?.completedAt!=null&&turn?.status==='interrupted'),
   queue:queue.map(q=>({id:q.id,messageId:q.clientUserMessageId})),pendingWork};
 });
}
export function continuationEligibility(f){
 if(f.paused)return 'paused';
 if(f.pendingFeedback.length)return 'feedback-pending';
 if(f.queue.length)return 'queued';
 if(!f.stable||!['idle','notLoaded','active'].includes(f.harnessState))return 'unknown';
 if(f.harnessState==='active'||f.heartbeatFresh||f.turn&&f.turn.completedAt==null)return 'running';
 if(!f.turn||!Number.isFinite(f.turn.completedAt)||!['completed','failed'].includes(f.turn.status))return 'unknown';
 return 'idle';
}

export const enqueueContinuation=(facts,text,id)=>withCodex(client=>client.request('thread/queue/add',{threadId:facts.threadId,clientUserMessageId:id,input:[{type:'text',text,text_elements:[]}]}));
