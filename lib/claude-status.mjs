import {dataDirectory} from './data-directory.mjs';
import {claudeEntryPaths,waiterRunning} from './claude-entry.mjs';
import {readJson} from './storage.mjs';

// Describe recorded hook and waiter evidence, never infer the native Agent's
// live state. This projection performs no delivery or connection mutation.
export function claudeConnectionStatus(record,connection,{now=Date.now}={}) {
 const status=(state,label,detail,extra={})=>({state,label,detail,observedAt:record?.lastHook?.at||null,...extra});
 if(!record||record.version!==1||record.harnessId!=='claude-code'||record.sessionId!==connection.sessionId)
  return {state:'unknown',label:'Connection not observed',detail:'Open the original Claude conversation and check its chill-agent hook setup.',observedAt:null};
 if(record.contextId!==connection.contextId)
  return {state:'context-changed',label:'Conversation context changed',detail:'This Goal belongs to the earlier context. Return to that conversation; a new context does not inherit its Goals.',observedAt:null};
 if(record.lastHook?.name==='SessionEnd')return status('ended','Session ended','Resume the original Claude conversation to receive saved replies.');
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
 return claudeConnectionStatus(record,connection,{now});
}

// Tell the Web whether a saved Claude reply has a waiter to wake. Codex and
// unassigned deliveries pass through unchanged.
export async function withClaudeReception(deliveries,{directory=dataDirectory(),now=Date.now}={}) {
 const states=new Map();
 return Promise.all(deliveries.map(async delivery=>{
  const connection=delivery.connection;
  if(connection?.harnessId!=='claude-code'||delivery.status!=='saved')return delivery;
  const key=JSON.stringify([connection.sessionId,connection.contextId]);
  if(!states.has(key))states.set(key,readClaudeConnectionStatus(connection,{directory,now}));
  return {...delivery,waiting:(await states.get(key)).state==='waiting'};
 }));
}
