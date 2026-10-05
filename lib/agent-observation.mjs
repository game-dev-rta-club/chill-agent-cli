import {join} from 'node:path';
import {workspaceDirectory,validThreadId} from './goal-store.mjs';
import {readJson,writeJsonAtomically,withStoreLock} from './storage.mjs';
import {readControlRecord,controlView} from './agent-control.mjs';
import {withCodex} from './codex-client.mjs';

export const heartbeatTTL=120000;
const heartbeatPath=id=>join(workspaceDirectory(),'agent-heartbeats',`${validThreadId(id)}.json`);
export const readAgentHeartbeat=id=>readJson(heartbeatPath(id));
// A hook confirms the chat is alive even before a work Goal has been selected.
export async function recordAgentHeartbeat({threadId,turnId}){
 validThreadId(threadId);validThreadId(turnId);
 await withStoreLock(join(workspaceDirectory(),'locks',`agent-heartbeat-${threadId}`),()=>
  writeJsonAtomically(heartbeatPath(threadId),{turnId,heartbeatAt:new Date().toISOString()}));
}

// Presence is chat-wide and independent of feedback receipts or monitor policy.
export function agentPresence({turn,view,threadState,selection,heartbeat,holds=[]},now=Date.now()){
 if(view)return view.status;
 if(threadState==='active')return 'working';
 if(!['idle','notLoaded'].includes(threadState))return 'unknown';
 if(turn&&turn.completedAt==null){
  if(threadState==='idle')return 'unknown';
  const signal=heartbeat?.turnId===turn.id?heartbeat:selection&&!selection.stoppedAt?selection:null;
  if(turn.status==='inProgress'||signal?.turnId===turn.id&&now-Date.parse(signal.heartbeatAt)<heartbeatTTL)return 'working';
  return 'unknown';
 }
 if(holds.some(h=>h?.phase==='paused')||turn?.status==='interrupted')return 'paused';
 if(holds.some(h=>h&&['holding','dispatching','uncertain'].includes(h.phase)))return 'unknown';
 if(turn?.completedAt!=null&&['completed','failed'].includes(turn.status)||threadState==='idle')return 'idle';
 return 'unknown';
}
// Pending work uses the same visual activity group as a live run. This does
// not confirm execution or grant stop/resume capabilities to uncertain work.
export function displayPresence(observation,now=Date.now()){
 const status=agentPresence(observation,now),{turn,view,threadState,holds=[],queue}=observation;
 if(status==='working')return status;
 if(queue?.data?.length)return 'queued';
 if(status==='unknown'&&(view||holds.some(h=>h&&['holding','dispatching','uncertain'].includes(h.phase))||turn&&turn.completedAt==null&&['idle','notLoaded'].includes(threadState)))return 'checking';
 return status;
}
// Read native state and the latest turn through one connection to avoid startup
// duplication and disagreeing snapshots from two independently opened clients.
export async function readPresenceSnapshot(threadId,{connect=withCodex,readControl=readControlRecord}={}){
 const [record,native]=await Promise.all([readControl(threadId),connect(async client=>{
  const [response,turns,queue]=await Promise.all([client.request('thread/read',{threadId,includeTurns:false}),client.request('thread/turns/list',{threadId,limit:1,itemsView:'notLoaded'}),client.request('thread/queue/list',{threadId,limit:1}).catch(()=>null)]);
  return {threadState:response.thread?.status?.type,turn:turns.data?.[0]||null,queue};
 })]);
 return {...native,record,view:controlView(record,native.turn)};
}
const observations=new Map();
export function invalidateAgentObservation(threadId){observations.delete(threadId);}
export async function observeAgentRun(threadId,{fresh=false}={}){
 const cached=observations.get(threadId);
 if(!fresh&&cached&&(cached.pending||Date.now()-cached.at<1000))return cached.promise;
 const entry={at:Date.now(),pending:true};
 entry.promise=Promise.all([readPresenceSnapshot(threadId),readAgentHeartbeat(threadId)])
  .then(([native,heartbeat])=>({...native,heartbeat}));
 observations.set(threadId,entry);
 if(observations.size>40)observations.delete(observations.keys().next().value);
 try{return await entry.promise;}
 catch(error){if(observations.get(threadId)===entry)observations.delete(threadId);throw error;}
 finally{entry.pending=false;entry.at=Date.now();}
}
