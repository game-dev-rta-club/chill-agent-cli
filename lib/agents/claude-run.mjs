// Claude run state from its transcript and chill's own records (adapter side).
import {listGoals,readFeedback} from '../goal-store.mjs';
import {readDelivery} from '../delivery.mjs';
import {dataDirectory} from '../data-directory.mjs';
import {claudeEntryPaths} from '../claude-entry.mjs';
import {claudeConnectionStatus} from '../claude-status.mjs';
import {claudeTurn,claudeWork} from '../claude-transcript.mjs';
import {readJson} from '../storage.mjs';

// A Claude conversation is Running while its transcript shows an open response.
// Its Goal is the one whose feedback that response received, as for Codex.
const recentFeedback=20;
export async function observeClaude(connection,{directory=dataDirectory(),now=Date.now}={}){
 const record=await readJson(claudeEntryPaths(directory,connection.sessionId).record).catch(()=>null);
 if(['unknown','context-changed'].includes(claudeConnectionStatus(record,connection,{now}).state))return {connected:false,status:'unlinked'};
 const turn=await claudeTurn(record.transcriptPath,{now});
 const status=record.pause?'paused':turn==null?'unknown':turn.running?'working':'idle';
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
// Feedback saved for this conversation that it has not received yet, in the
// same shape as Codex's native queue, so the Agent menu reads one Queue.
export async function claudeQueue(connection,{limit=50}={}){
 const feedback=(await readFeedback()).filter(e=>e.author==='user'&&e.connection?.sessionId===connection.sessionId&&e.connection?.contextId===connection.contextId);
 const waiting=[];
 for(const event of feedback){
  const delivery=await readDelivery(event.changeId).catch(()=>null);
  if(!delivery||delivery.agentReported||!(delivery.status==='saved'||delivery.heldBy))continue;
  waiting.push(event);
 }
 const goals=await listGoals();
 return {truncated:waiting.length>limit,items:waiting.slice(0,limit).map(e=>{const g=goals.find(g=>g.id===e.goalId);return {goalId:g?.id||null,title:g?.title||'Saved reply'};})};
}

// Mark the Goal a Claude Root is working on, as Codex selection does, so the
// Goal list shows Running for either harness.
export async function overlayClaudeExecutions(goals,executions,options){
 for(const root of goals.filter(g=>!g.parentId&&!g.threadId&&g.connection?.harnessId==='claude-code')){
  const run=await observeClaude(root.connection,options).catch(()=>null);
  // A paused conversation marks the Goal it last worked on, as a Codex pause does.
  const target=run?.status==='working'?{goalId:run.goalId,eventId:run.eventId}:run?.status==='paused'?run.last:null;
  if(!target?.goalId||executions.has(target.goalId))continue;
  let ancestor=goals.find(g=>g.id===target.goalId);while(ancestor?.parentId)ancestor=goals.find(g=>g.id===ancestor.parentId);
  if(ancestor?.id!==root.id)continue;
  executions.set(target.goalId,{goalId:target.goalId,rootId:root.id,threadId:null,turnId:run.turnId,status:run.status,
   activity:{goalId:target.goalId,eventId:target.eventId},checkedAt:run.checkedAt,expiresAt:new Date(Date.parse(run.checkedAt)+15000).toISOString()});
 }
 return executions;
}
