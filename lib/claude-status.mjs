import {dataDirectory} from './data-directory.mjs';
import {claudeEntryPaths} from './claude-entry.mjs';
import {readJson} from './storage.mjs';

export const idleCheckIntervalMs=5000;
export const idleCheckFreshMs=15000;
const iso=value=>Number.isFinite(value)&&!Number.isNaN(new Date(value).getTime())?new Date(value).toISOString():null;

// Describe recorded hook evidence, never infer the native Agent's live state.
// This projection performs no delivery, renewal or connection mutation.
export function claudeConnectionStatus(record,connection,{now=Date.now}={}) {
 const status=(state,label,detail,extra={})=>({state,label,detail,observedAt:record?.lastHook?.at||null,...extra});
 if(!record||record.version!==1||record.harnessId!=='claude-code'||record.sessionId!==connection.sessionId)
  return {state:'unknown',label:'Connection not observed',detail:'Open the original Claude conversation and check its chill-agent hook setup.',observedAt:null};
 if(record.contextId!==connection.contextId)
  return {state:'context-changed',label:'Conversation context changed',detail:'This Goal belongs to the earlier context. Return to that conversation; a new context does not inherit its Goals.',observedAt:null};
 if(record.lastHook?.name==='SessionEnd')return status('ended','Session ended','Resume the original Claude conversation to receive saved replies.');
 const matches=p=>p&&p.generation===record.generation&&p.contextId===record.contextId;
 const watch=record.idleWatch;
 const checkpoint=record.stoppedPrompt||record.resumeCheckpoint;
 if(matches(checkpoint)&&watch?.checkpointId===checkpoint.checkpointId){
  const extra={watchCheckedAt:iso(watch.lastCheckedAt),expiresAt:iso(watch.expiresAt)};
  if(watch.status==='offered')return status('offered','Reply offered','Feedback was offered to Claude. Its receipt is still needed; this is not proof of delivery.',extra);
  if(watch.status==='expired'||Number.isFinite(watch.expiresAt)&&now()>=watch.expiresAt)
   return status('expired','Reply watch expired','Replies stay saved. In the original Claude conversation, ask chill-agent to check its inbox. A later verified response can start a new watch.',extra);
  if(watch.status==='watching'&&Number.isFinite(watch.expiresAt)&&Number.isFinite(watch.lastCheckedAt)&&now()>=watch.lastCheckedAt&&now()-watch.lastCheckedAt<idleCheckFreshMs)
   return status('watching','Checking for Web replies','A recent check was recorded. Keep the original Claude conversation open to receive replies.',extra);
  return status('unconfirmed','Reply watch unconfirmed','The watcher has no recent check. Open the original Claude conversation and ask chill-agent to check its inbox; saved replies are kept.',extra);
 }
 if(matches(record.stoppedPrompt))return status('stopped','Response finished','The main hook recorded the response ending. No reply watch is recorded; open the original Claude conversation to check saved replies.');
 if(matches(record.verifiedPrompt))return status('main-hook','Conversation checked in','Claude checked in from the original conversation. Its current activity is unavailable.');
 return status('entry-only','Waiting for conversation confirmation','Open the original Claude conversation and ask chill-agent to check its inbox.');
}

export async function readClaudeConnectionStatus(connection,{directory=dataDirectory(),now=Date.now}={}) {
 let record;
 try {record=await readJson(claudeEntryPaths(directory,connection.sessionId).record);}
 catch {return claudeConnectionStatus(null,connection,{now});}
 return claudeConnectionStatus(record,connection,{now});
}
