import {join} from 'node:path';
import {workspaceDirectory,validThreadId} from '../goal-store.mjs';
import {writeJsonAtomically,withStoreLock} from '../storage.mjs';
import {createCodexDesktopConnection,readCodexHeartbeat} from '../codex-desktop-connection.mjs';
import {connectionKey} from './connection.mjs';

export const heartbeatTTL=120000;
const heartbeatPath=id=>join(workspaceDirectory(),'agent-heartbeats',`${validThreadId(id)}.json`);
export const readAgentHeartbeat=readCodexHeartbeat;
// The Codex hook's mark that the chat's turn is alive.
export async function recordAgentHeartbeat({threadId,turnId}){
 validThreadId(threadId);validThreadId(turnId);
 await withStoreLock(join(workspaceDirectory(),'locks',`agent-heartbeat-${threadId}`),()=>
  writeJsonAtomically(heartbeatPath(threadId),{turnId,heartbeatAt:new Date().toISOString()}));
}

// What the chat is doing, from the Codex app's thread and latest turn. A turn
// the app reports unfinished while the chat is idle is unknown, unless the
// chat's own hooks or goal work said so lately. An interrupted turn is paused.
export function agentPresence({turn,threadState,selection,heartbeat},now=Date.now()){
 if(threadState==='active')return 'working';
 if(!['idle','notLoaded'].includes(threadState))return 'unknown';
 if(turn&&turn.completedAt==null){
  if(threadState==='idle')return 'unknown';
  const signal=heartbeat?.turnId===turn.id?heartbeat:selection&&!selection.stoppedAt?selection:null;
  if(turn.status==='inProgress'||signal?.turnId===turn.id&&now-Date.parse(signal.heartbeatAt)<heartbeatTTL)return 'working';
  return 'unknown';
 }
 if(turn?.status==='interrupted')return 'paused';
 if(turn?.completedAt!=null&&['completed','failed'].includes(turn.status)||threadState==='idle')return 'idle';
 return 'unknown';
}
const unavailable=()=>({threadState:'unknown',turn:null,queue:null,heartbeat:null});
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
