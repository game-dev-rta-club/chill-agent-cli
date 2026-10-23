import {dataDirectory} from './data-directory.mjs';
import {claudeEntryPaths,waiterRunning} from './claude-entry.mjs';
import {readJson} from './storage.mjs';
import {claudeModel} from './claude-transcript.mjs';
import {recordHidden} from './hidden-failure.mjs';

// Describe recorded hook and waiter evidence, never infer the native Agent's
// live state. This projection performs no delivery or connection mutation.
export function claudeConnectionStatus(record,connection,{now=Date.now}={}) {
 const status=(state,label,detail,extra={})=>({state,label,detail,observedAt:record?.lastHook?.at||null,...extra});
 if(!record||record.version!==1||record.harnessId!=='claude-code'||record.sessionId!==connection.sessionId)
  return {state:'unknown',label:'Connection not observed',detail:'Open the original Claude conversation and check its chill-agent hook setup, or ask the conversation that continues this work to take over this Goal.',observedAt:null};
 if(record.contextId!==connection.contextId)
  return {state:'context-changed',label:'Conversation context changed',detail:'This Goal belongs to the earlier context. Return to that conversation, or ask the conversation that continues this work to take over this Goal.',observedAt:null};
 if(record.lastHook?.name==='SessionEnd')return status('ended','Session ended','Resume the original Claude conversation to receive saved replies, or ask the conversation that continues this work to take over this Goal.');
 if(waiterRunning(record,now()))return status('waiting','Receives Web replies','A watcher is running in the original Claude conversation. New replies wake it.',{waiterCheckedAt:record.waiter.checkedAt});
 const restart='No watcher is running. Replies stay saved; the conversation receives them at its next tool call, or when it is opened again.';
 if(record.lastHook?.name==='Stop')return status('stopped','Response finished',restart);
 return status('connected','Connected',`Claude is connected from the original conversation. ${restart}`);
}

export async function readClaudeConnectionStatus(connection,{directory=dataDirectory(),now=Date.now}={}) {
 let record;
 try {record=await readJson(claudeEntryPaths(directory,connection.sessionId).record);}
 catch(error) {recordHidden('claude-status.read',error);return claudeConnectionStatus(null,connection,{now});}
 const status=claudeConnectionStatus(record,connection,{now});
 // The model and effort the conversation last answered with, from its own transcript.
 const settings=record?.sessionId===connection.sessionId?await claudeModel(record.transcriptPath):null;
 return settings?{...status,settings}:status;
}

