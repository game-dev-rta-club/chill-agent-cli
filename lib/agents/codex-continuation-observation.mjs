// Codex facts for continuation. No scheduling policy lives in this adapter.
import {continuationWorkspace} from '../continuation-workspace.mjs';
import {readExecution,heartbeatTTL} from './codex-execution.mjs';
import {readCodexWork} from './codex-work.mjs';
import {handedAwaitingComments,ownedRoots} from '../hand-off.mjs';
import {pendingComments} from '../agent-rules.mjs';
import {withCodex} from '../codex-client.mjs';
import {workReader} from './codex-work-output.mjs';
import {largeCount} from '../limits.mjs';

export async function continuationObservation(rootId,pending,{connect=withCodex,now=Date.now()}={}) {
 const {root,branch,revision,userEvent,context}=await continuationWorkspace(rootId);
 if(!root.threadId)throw Error('An assigned Root Goal is required.');
 const threadId=root.threadId;
 // Comments not handed yet wait for the chat; handed ones still awaiting a
 // reply are work to continue, which the request names.
 const {roots}=await ownedRoots(g=>g.threadId===threadId);
 const record=await readCodexWork(threadId),execution=await readExecution(threadId);
 const selected=branch.find(g=>g.id===execution?.goalId);
 if(selected)context.focus={id:selected.id,title:selected.title};
 const facts={rootId,threadId,observedAt:new Date(now).toISOString(),rootState:root.state,
  rootTitle:root.title,context,revision,lastUserEvent:userEvent,
  paused:record.paused,
  pendingFeedback:roots.flatMap(r=>pendingComments(r.events,r.state.cursor)).map(e=>({eventId:e.id,status:'saved'})),
  unfinished:handedAwaitingComments(roots).map(e=>({eventId:e.id,goalId:e.goalId})),
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
   if(seen.size>largeCount)throw Error('Queue snapshot incomplete');
  }while(cursor);
  const pendingWork=pending?await workReader(client)({threadId,matchText:`chill monitor result --id ${rootId} --attempt ${pending.id} --outcome worked`,history:[{status:'saved',at:pending.at}]}):null;
  // Re-read after the queue: never treat a changing latest turn as idle.
  const again=await client.request('thread/turns/list',{threadId,limit:1,itemsView:'notLoaded'});
  const latest=again.data?.[0]||null;
  return {...facts,heartbeatFresh:facts.heartbeatFresh&&!(execution?.turnId===turn?.id&&turn?.completedAt!=null),harnessState:response.thread.status?.type||'unknown',turn,
   stable:JSON.stringify([turn?.id,turn?.completedAt,turn?.status])===JSON.stringify([latest?.id,latest?.completedAt,latest?.status]),
   paused:facts.paused||(turn?.completedAt!=null&&turn?.status==='interrupted'),
   queue:queue.map(q=>({id:q.id,messageId:q.clientUserMessageId})),pendingWork};
 });
}
export const enqueueContinuation=(facts,text,id)=>withCodex(client=>client.request('thread/queue/add',{threadId:facts.threadId,clientUserMessageId:id,input:[{type:'text',text,text_elements:[]}]}));
