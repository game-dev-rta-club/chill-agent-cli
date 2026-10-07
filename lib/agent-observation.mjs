import {join} from 'node:path';
import {workspaceDirectory,validThreadId} from './goal-store.mjs';
import {writeJsonAtomically,withStoreLock} from './storage.mjs';
import {createCodexDesktopConnection,readCodexHeartbeat} from './codex-desktop-connection.mjs';
import {connectionKey} from './agent-connection.mjs';

export const heartbeatTTL=120000;
const heartbeatPath=id=>join(workspaceDirectory(),'agent-heartbeats',`${validThreadId(id)}.json`);
export const readAgentHeartbeat=readCodexHeartbeat;
// Legacy Codex hook entry. Additional harnesses supply their own heartbeat
// through their adapter instead of sharing a Codex thread's file.
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
// Keep the legacy read entry for callers that already hold a Codex thread ID.
export function readPresenceSnapshot(threadId,{connect,readControl,readHeartbeat}={}){
 return createCodexDesktopConnection(threadId,{run:connect,readControl,readHeartbeat}).readRunSnapshot();
}
const unavailable=()=>({threadState:'unknown',turn:null,queue:null,record:null,view:null,heartbeat:null});
export function createAgentObservationStore({now=Date.now,ttl=1000,limit=40}={}){
 const observations=new Map();
 const invalidate=connection=>observations.delete(connectionKey(connection));
 async function read(connection,{fresh=false}={}){
  const key=connectionKey(connection);
  if(!key)throw Error('An agent connection is required.');
  const cached=observations.get(key);
  if(!fresh&&cached&&(cached.pending||now()-cached.at<ttl))return cached.promise;
  const entry={at:now(),pending:true};
  entry.promise=Promise.resolve().then(()=>connection.readRunSnapshot?.()).then(snapshot=>snapshot||unavailable());
  observations.set(key,entry);
  if(observations.size>limit)observations.delete(observations.keys().next().value);
  try{return await entry.promise;}
  catch(error){if(observations.get(key)===entry)observations.delete(key);throw error;}
  finally{entry.pending=false;entry.at=now();}
 }
 return {read,invalidate};
}
const observations=createAgentObservationStore();
const asConnection=value=>typeof value==='string'?createCodexDesktopConnection(value):value;
export const invalidateAgentObservation=value=>observations.invalidate(asConnection(value));
export const observeAgentRun=(value,options)=>observations.read(asConnection(value),options);
