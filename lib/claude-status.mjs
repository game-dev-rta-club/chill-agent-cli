import {dataDirectory} from './data-directory.mjs';
import {claudeEntryPaths,waiterRunning} from './claude-entry.mjs';
import {readJson} from './storage.mjs';
import {claudeModel,claudeWork} from './claude-transcript.mjs';

// Describe recorded hook and waiter evidence, never infer the native Agent's
// live state. This projection performs no delivery or connection mutation.
export function claudeConnectionStatus(record,connection,{now=Date.now}={}) {
 const status=(state,label,detail,extra={})=>({state,label,detail,observedAt:record?.lastHook?.at||null,...extra});
 if(!record||record.version!==1||record.harnessId!=='claude-code'||record.sessionId!==connection.sessionId)
  return {state:'unknown',label:'Connection not observed',detail:'Open the original Claude conversation and check its chill-agent hook setup, or ask the conversation that continues this work to take over this Goal.',observedAt:null};
 if(record.contextId!==connection.contextId)
  return {state:'context-changed',label:'Conversation context changed',detail:'This Goal belongs to the earlier context. Return to that conversation, or ask the conversation that continues this work to take over this Goal.',observedAt:null};
 if(record.lastHook?.name==='SessionEnd')return status('ended','Session ended','Resume the original Claude conversation to receive saved replies, or ask the conversation that continues this work to take over this Goal.');
 if(waiterRunning(record,now()))return status('waiting','Waiting for Web replies','A reply waiter is running in the original Claude conversation. New replies wake it.',{waiterCheckedAt:record.waiter.checkedAt});
 const restart='No reply waiter is running. Replies stay saved; in the original Claude conversation, ask chill-agent to check its inbox and it will restart the waiter.';
 const matches=p=>p&&p.generation===record.generation&&p.contextId===record.contextId;
 if(matches(record.stoppedPrompt))return status('stopped','Response finished',restart);
 if(matches(record.verifiedPrompt))return status('main-hook','Conversation checked in',`Claude checked in from the original conversation. ${restart}`);
 return status('entry-only','Waiting for conversation confirmation','Open the original Claude conversation and ask chill-agent to check its inbox.');
}

export async function readClaudeConnectionStatus(connection,{directory=dataDirectory(),now=Date.now}={}) {
 let record;
 try {record=await readJson(claudeEntryPaths(directory,connection.sessionId).record);}
 catch {return claudeConnectionStatus(null,connection,{now});}
 const status=claudeConnectionStatus(record,connection,{now});
 // The model and effort the conversation last answered with, from its own transcript.
 const settings=record?.sessionId===connection.sessionId?await claudeModel(record.transcriptPath):null;
 return settings?{...status,settings}:status;
}

// Tell the Web whether a saved Claude reply has a waiter to wake. Codex and
// unassigned deliveries pass through unchanged.
export async function withClaudeReception(deliveries,{directory=dataDirectory(),now=Date.now}={}) {
 const states=new Map(),records=new Map();
 const record=sessionId=>{if(!records.has(sessionId))records.set(sessionId,readJson(claudeEntryPaths(directory,sessionId).record).catch(()=>null));return records.get(sessionId);};
 return Promise.all(deliveries.map(async delivery=>{
  const connection=delivery.connection;
  if(connection?.harnessId!=='claude-code')return delivery;
  // Show the agent's public text from the response that received this feedback,
  // like a Codex turn. The offer is found in the receiving conversation's transcript.
  if(delivery.nativeOfferId&&delivery.status!=='saved'){
   const owner=await record(delivery.nativeOfferSessionId||connection.sessionId);
   const work=owner?await claudeWork(owner.transcriptPath,delivery.nativeOfferId):null;
   return work?{...delivery,work}:delivery;
  }
  if(delivery.status!=='saved')return delivery;
  const key=JSON.stringify([connection.sessionId,connection.contextId]);
  if(!states.has(key))states.set(key,readClaudeConnectionStatus(connection,{directory,now}));
  return {...delivery,waiting:(await states.get(key)).state==='waiting'};
 }));
}
