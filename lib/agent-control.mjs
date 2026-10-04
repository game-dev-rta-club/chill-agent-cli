import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {readJson,writeJsonAtomically,withStoreLock} from './storage.mjs';
import {workspaceDirectory,validThreadId,readGoalContext} from './goal-store.mjs';
import {withCodex} from './codex-client.mjs';
import {interruptDesktopTurn,resumeDesktopTurn} from './desktop-settings.mjs';

const path=id=>join(workspaceDirectory(),'agent-controls',`${validThreadId(id)}.json`);
export const readControlRecord=id=>readJson(path(id));
export const latestControlTurn=id=>withCodex(async c=>(await c.request('thread/turns/list',{threadId:id,limit:1,itemsView:'notLoaded'})).data[0]??null);
// Native interruption keeps the native queue waiting. This record only ties
// the resume action to the stopped turn/Goal; it is not a second queue.
export function controlView(record,turn){
 if(!record)return null;
 if(!turn)return {status:'unknown',...record.target};
 if(turn.id!==record.turnId){
  if(record.action==='resume'&&turn.id===record.resumedTurnId&&turn.completedAt==null)return {status:'working',turnId:turn.id,...record.target};
  return null; // Desktop or another client already continued this thread.
 }
 if(turn.completedAt!=null&&turn.status==='interrupted')return {status:record.action==='resume'?'unknown':'paused',turnId:turn.id,...record.target};
 if(turn.completedAt!=null)return null;
 return {status:'unknown',turnId:turn.id,...record.target};
}

export function createControlService({read=readControlRecord,write=(id,r)=>writeJsonAtomically(path(id),r),latest=latestControlTurn,stop=interruptDesktopTurn,resume=resumeDesktopTurn,context=readGoalContext}={}){
 return async (goalId,input,target)=>{
  if(!['stop','resume'].includes(input.action)||!input.requestId||!input.turnId)throw Error('Invalid action.');
  validThreadId(input.requestId);validThreadId(input.turnId);
  const {root}=await context(goalId),id=root.threadId;
  if(!id||id!==input.threadId)throw Error('Agent changed. Refresh to retry.');
  const previous=await read(id);
  if(previous?.requestId===input.requestId)return; // never retry an uncertain send
  const turn=await latest(id);
  if(!turn||turn.id!==input.turnId)throw Error('Run changed. Refresh to retry.');
  if(input.action==='stop'){
   if(turn.completedAt!=null)throw Error('Run ended. Refresh to check.');
  }else if(!previous||controlView(previous,turn)?.status!=='paused')throw Error('Nothing to resume. Refresh to check.');
  if((await context(goalId)).root.threadId!==id)throw Error('Agent changed.');
  const record={action:input.action,requestId:input.requestId,turnId:turn.id,target:input.action==='resume'?previous.target:target,activity:input.action==='resume'?previous.activity:input.activity,at:new Date().toISOString()};
  // Persist before dispatch. Timeout / disconnect must not cause a second resume.
  await write(id,record);
  if(input.action==='stop'){
   const result=await stop(id,turn.id);
   if(result?.ok!==true||result.interruptedTurnId!==turn.id)throw Error('Pause unconfirmed. Refresh to check.');
  }else{
   const goal=record.target?.goalId;
   const text=`The user selected Resume in Activity. ${goal?`Read the latest Goal #${goal}, then ` : ''}continue the interrupted work. Do not repeat completed work. Leave pending messages in the existing queue.`;
   const result=await resume(id,text,input.requestId),resumed=result?.result?.turn?.id;
   if(!resumed)throw Error('Resume unconfirmed. Refresh to check.');
   await write(id,{...record,resumedTurnId:resumed});
  }
 };
}
export const applyAgentControlUnlocked=createControlService();
export const withAgentControlLock=(id,run)=>withStoreLock(join(workspaceDirectory(),'locks',`agent-control-${validThreadId(id)}`),run);
export const applyAgentControl=(goalId,input,target)=>withAgentControlLock(input.threadId,()=>applyAgentControlUnlocked(goalId,input,target));
