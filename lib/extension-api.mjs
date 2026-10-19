export {projectExtensionEnabled,workspacePort,resolveWorkspacePort} from './project-workspace.mjs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {listGoals,readGoalContext,dataDirectory,workspaceDirectory,validId,validThreadId} from './goal-store.mjs';
import {readJson,writeJsonAtomically,withStoreLock} from './storage.mjs';
import {withAgentControlLock} from './agent-lock.mjs';
import {continuationEligibility} from './continuation-eligibility.mjs';
import {recordServerUse} from './server-lifecycle.mjs';
export const protocolVersion=1;
export const extensionCapabilities=Object.freeze(['panels','requests','tunnel-control','browser-context','confirm-dialog','public-origin','agent-guidance','goal-context','run-output','connection-hooks','project-isolation','runtime-updates']);
export {continuationWorkspace} from './continuation-workspace.mjs';
export {listEventsSince as readEventsSince} from './goal-store.mjs';
// Agent adapters load core modules that use this API, so they are loaded on use.
const agents=()=>import('./agents/index.mjs');
export const callerOwns=async(root,env)=>(await agents()).callerOwns(root,env);
export const runNativeAction=async(...args)=>(await agents()).runNativeAction(...args);
export {agentGuide} from './agent-guidance.mjs';
export const readRuntimeUpdateSource=(directory=dataDirectory())=>readJson(join(directory,'runtime','update-source.json'));
export const saveRuntimeUpdateSource=(source,directory=dataDirectory())=>writeJsonAtomically(join(directory,'runtime','update-source.json'),source);
export function requireProtocol(version){if(version!==protocolVersion)throw Error('Unsupported extension protocol.');}
export {listGoals,readGoalContext,dataDirectory,validId,validThreadId};
export {readFeedback} from './goal-store.mjs';
export {readMessageSettings,readNotificationSettings,saveMessageSetting,validateNotifications,notificationUrl,readPublicOrigin} from './message-settings.mjs';
export const touch=()=>recordServerUse(dataDirectory());
async function polled(rootId){
 const {root}=await readGoalContext(rootId);
 if(root.id!==rootId)throw Error('A Root Goal is required.');
 const continuation=(await agents()).agentContinuation(root);
 if(!continuation?.observe)throw Error('An assigned Root Goal is required.');
 return continuation;
}
export const observe=async(rootId,pending)=>(await polled(rootId)).observe(pending);
export const eligibility=continuationEligibility;
// Trusted extensions identify their own saved request. Read public turn output
// on demand; opening a log never creates a Conversation event or starts work.
export const readRunOutput=async request=>(await agents()).readRunOutput(request);
export const policyLock=(thread,run)=>withStoreLock(join(workspaceDirectory(),'locks',`policy-${validThreadId(thread)}`),run);
// Serializes a policy journal for one bound conversation context.
export function connectionPolicyLock(connection,run){
 if(!connection||typeof connection!=='object'||typeof connection.sessionId!=='string'||!connection.sessionId)throw Error('Invalid native connection.');
 validThreadId(connection.contextId);
 const key=createHash('sha256').update(JSON.stringify([connection.sessionId,connection.contextId])).digest('hex');
 return withStoreLock(join(workspaceDirectory(),'locks',`native-policy-${key}`),run);
}
export function storage(namespace){
 if(!/^[a-z][a-z0-9-]*$/.test(namespace))throw Error('Invalid namespace');
 // Preserve the pre-split continuation journal and its attempt IDs.
 const file=id=>join(workspaceDirectory(),namespace,`${validId(id)}.json`);
 return {read:id=>readJson(file(id)),write:(id,value)=>writeJsonAtomically(file(id),value),lock:(id,run)=>withStoreLock(join(workspaceDirectory(),'locks',`${namespace}-${validId(id)}`),run)};
}
export function createRequestSender({lock=withAgentControlLock,read=readJson,write=writeJsonAtomically,observeState=observe,send=async(facts,text,id)=>(await polled(facts.rootId)).enqueue(facts,text,id)}={}){
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
