import {readGoalContext,listGoals,readFeedback} from './goal-store.mjs';
import {readDelivery} from './delivery.mjs';
import {readExecution} from './goal-execution.mjs';
import {readFeedbackHold} from './feedback-hold.mjs';
import {displayPresence,observeAgentRun} from './agent-observation.mjs';
import {dataDirectory} from './data-directory.mjs';
import {claudeEntryPaths} from './claude-entry.mjs';
import {claudeConnectionStatus} from './claude-status.mjs';
import {claudeTurn,claudeWork} from './claude-transcript.mjs';
import {readJson} from './storage.mjs';
export {agentPresence,readPresenceSnapshot} from './agent-observation.mjs';

async function observe(threadId){
 const [activity,selection,goals]=await Promise.all([observeAgentRun(threadId),readExecution(threadId),listGoals()]);
 const holds=(await Promise.all(goals.map(g=>readFeedbackHold(g.id)))).filter(h=>h?.threadId===threadId);
 const status=displayPresence({...activity,selection,holds});
 const selected=status==='working'&&selection&&!selection.stoppedAt&&selection.turnId===activity.turn?.id;
 const target=goals.find(g=>g.id===(selected?selection.goalId:activity.view?.goalId));
 // The last selected Goal stays reachable after the work ends.
 const previous=goals.find(g=>g.id===selection?.goalId);
 return {status,goalId:target?.id||null,title:target?.title||null,last:previous?{goalId:previous.id,title:previous.title,eventId:null}:null,checkedAt:new Date().toISOString()};
}
// A Claude conversation is Running while its transcript shows an open response.
// Its Goal is the one whose feedback that response received, as for Codex.
const recentFeedback=20;
export async function observeClaude(connection,{directory=dataDirectory(),now=Date.now}={}){
 const record=await readJson(claudeEntryPaths(directory,connection.sessionId).record).catch(()=>null);
 if(['unknown','context-changed'].includes(claudeConnectionStatus(record,connection,{now}).state))return {connected:false,status:'unlinked'};
 const turn=await claudeTurn(record.transcriptPath,{now});
 const status=turn==null?'unknown':turn.running?'working':'idle';
 let target=null,latest=null;
 const feedback=(await readFeedback()).filter(e=>e.author==='user'&&e.connection?.sessionId===connection.sessionId).slice(-recentFeedback).reverse();
 for(const event of feedback){
  const delivery=await readDelivery(event.changeId).catch(()=>null);
  if(!delivery?.nativeOfferId||(delivery.nativeOfferSessionId||connection.sessionId)!==connection.sessionId)continue;
  latest??=delivery;
  if(!turn?.running)break;
  if((await claudeWork(record.transcriptPath,delivery.nativeOfferId))?.turnId===turn.turnId){target=delivery;break;}
 }
 const goals=await listGoals(),goal=target&&goals.find(g=>g.id===target.goalId),previous=latest&&goals.find(g=>g.id===latest.goalId);
 // The last Goal whose feedback this conversation received stays reachable after the work ends.
 return {connected:true,status,goalId:goal?.id||null,title:goal?.title||null,eventId:goal?target.eventId:null,turnId:turn?.turnId||null,
  last:previous?{goalId:previous.id,title:previous.title,eventId:latest.eventId}:null,checkedAt:new Date(now()).toISOString()};
}
// Mark the Goal a Claude Root is working on, as Codex selection does, so the
// Goal list shows Running for either harness.
export async function overlayClaudeExecutions(goals,executions,options){
 for(const root of goals.filter(g=>!g.parentId&&!g.threadId&&g.connection?.harnessId==='claude-code')){
  const run=await observeClaude(root.connection,options).catch(()=>null);
  if(run?.status!=='working'||!run.goalId||executions.has(run.goalId))continue;
  let ancestor=goals.find(g=>g.id===run.goalId);while(ancestor?.parentId)ancestor=goals.find(g=>g.id===ancestor.parentId);
  if(ancestor?.id!==root.id)continue;
  executions.set(run.goalId,{goalId:run.goalId,rootId:root.id,threadId:null,turnId:run.turnId,status:'working',
   activity:{goalId:run.goalId,eventId:run.eventId},checkedAt:run.checkedAt,expiresAt:new Date(Date.parse(run.checkedAt)+15000).toISOString()});
 }
 return executions;
}
export async function readAgentPresence(goalId,options){
 const {root}=await readGoalContext(goalId);
 if(!root.threadId&&root.connection?.harnessId==='claude-code')return observeClaude(root.connection,options);
 if(!root.threadId)return {connected:false,status:'unlinked'};
 const result=await observe(root.threadId);
 if((await readGoalContext(goalId)).root.threadId!==root.threadId)throw Error('Agent assignment changed.');
 return {connected:true,...result};
}
