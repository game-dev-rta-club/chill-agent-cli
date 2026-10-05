import {join} from 'node:path';
import {listGoals,readGoalContext,dataDirectory,workspaceDirectory,validId,validThreadId} from './goal-store.mjs';
import {readJson,writeJsonAtomically,withStoreLock} from './storage.mjs';
import {withAgentControlLock} from './agent-control.mjs';
import {continuationObservation,continuationEligibility,enqueueContinuation} from './continuation-observation.mjs';
import {recordServerUse} from './server-lifecycle.mjs';
export const protocolVersion=1;
export function requireProtocol(version){if(version!==protocolVersion)throw Error('Unsupported extension protocol.');}
export {listGoals,readGoalContext,dataDirectory,validId,validThreadId};
export {readFeedback} from './goal-store.mjs';
export {readMessageSettings,readNotificationSettings,saveMessageSetting,validateNotifications,notificationUrl} from './message-settings.mjs';
export const touch=()=>recordServerUse(dataDirectory());
export const observe=continuationObservation;
export const eligibility=continuationEligibility;
export const policyLock=(thread,run)=>withStoreLock(join(workspaceDirectory(),'locks',`policy-${validThreadId(thread)}`),run);
export function storage(namespace){
 if(!/^[a-z][a-z0-9-]*$/.test(namespace))throw Error('Invalid namespace');
 // Preserve the pre-split continuation journal and its attempt IDs.
 const file=id=>join(workspaceDirectory(),namespace,`${validId(id)}.json`);
 return {read:id=>readJson(file(id)),write:(id,value)=>writeJsonAtomically(file(id),value),lock:(id,run)=>withStoreLock(join(workspaceDirectory(),'locks',`${namespace}-${validId(id)}`),run)};
}
export function createRequestSender({lock=withAgentControlLock,read=readJson,write=writeJsonAtomically,observeState=observe,send=enqueueContinuation}={}){
return async function enqueue(facts,text,id){
 validThreadId(id);
 return lock(facts.threadId,async()=>{
  const path=join(workspaceDirectory(),'requests',`${id}.json`);
  const previous=await read(path);
  if(previous){if(previous.rootId!==facts.rootId||previous.text!==text)throw Error('Request ID already used');if(previous.result)return previous.result;throw Error('Request receipt uncertain; do not resend');}
  const fresh=await observeState(facts.rootId,null);
  if(eligibility(fresh)!=='idle'||fresh.threadId!==facts.threadId||fresh.revision!==facts.revision||fresh.turn?.id!==facts.turn?.id)throw Error('Execution changed; request not sent');
  await write(path,{rootId:facts.rootId,text,status:'sending'});
  const result=await send(fresh,text,id);
  await write(path,{rootId:facts.rootId,text,status:'queued',result});return result;
 });
}

}
export const enqueue=createRequestSender();
