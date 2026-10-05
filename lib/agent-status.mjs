import {pauseFeedback,resumeHeldFeedback} from './feedback-hold.mjs';
import {readAgentActivity,invalidateActivity} from './agent-activity.mjs';
import {readControlRecord,latestControlTurn,controlView,applyAgentControl} from './agent-control.mjs';
import {canUpdateDesktopSettings,updateDesktopSettings,canControlDesktop} from './desktop-settings.mjs';
import {withCodex} from './codex-client.mjs';
import {readGoalContext,readFeedback,listGoals} from './goal-store.mjs';
import {readDelivery,refreshWorkOutputs} from './delivery.mjs';
import {readExecution,executionForGoals} from './goal-execution.mjs';
import {readAgentPresence} from './agent-presence.mjs';

export function usageWindows(result) {
  const buckets=result?.rateLimitsByLimitId;
  const entries=buckets&&Object.keys(buckets).length?Object.entries(buckets):result?.rateLimits?[[result.rateLimits.limitId||'codex',result.rateLimits]]:[];
  return entries.map(([id,bucket])=>({id,name:bucket.limitName||id,windows:['primary','secondary'].filter(key=>bucket[key]).map(key=>{
    const w=bucket[key];return {id:key,remaining:typeof w.usedPercent==='number'&&Number.isFinite(w.usedPercent)?Math.max(0,Math.min(100,100-w.usedPercent)):null,
      minutes:Number.isFinite(w.windowDurationMins)?w.windowDurationMins:null,resetAt:Number.isFinite(w.resetsAt)?w.resetsAt:null};
  })}));
}
export function agentWorkFromRecords(goals,selection,deliveries,execution){
 const active=deliveries.filter(d=>d.status==='working').sort((a,b)=>{
  const time=d=>Date.parse(d.work?.startedAt||d.history?.findLast(h=>h.status==='working')?.at||d.updatedAt)||0;
  return time(b)-time(a)||b.eventId-a.eventId;
 })[0];
 const target=id=>{const g=goals.find(g=>g.id===id);return {goalId:g?.id||null,title:g?.title||null};};
 if(active){
  const turnId=active.work?.turnId||active.hookTurnId||active.turnId;
  const selected=selection&&!selection.stoppedAt&&turnId&&selection.turnId===turnId;
  return {status:'working',...target(selected?selection.goalId:active.goalId)};
 }
 if(execution?.status==='working')return {status:'working',...target(execution.goalId)};
 return {status:deliveries.length||selection?.stoppedAt||execution?.status==='idle'?'idle':'unknown',goalId:null,title:null};
}

const snapshots=new Map();
async function snapshot(threadId) {
  const existing=snapshots.get(threadId);
  if(existing&&Date.now()-existing.at<10000)return existing.promise;
  const promise=withCodex(async client=>{
    const results=await Promise.allSettled([
      client.request('thread/read',{threadId,includeTurns:false}),
      client.request('model/list',{limit:100}),
      client.request('account/rateLimits/read',{}),
      (async()=>{let cursor,data=[],pages=0;do{const page=await client.request('thread/queue/list',{threadId,limit:100,...(cursor?{cursor}:{})});data.push(...page.data);cursor=page.nextCursor;if(++pages>=10)return {data,truncated:Boolean(cursor)};}while(cursor);return {data,truncated:false};})(),
    ]);
    const values=results.map(r=>r.status==='fulfilled'?r.value:null);
    return {thread:values[0]?.thread,models:values[1]?.data||[],usage:values[2]===null?null:usageWindows(values[2]),queue:values[3],checkedAt:new Date().toISOString()};
  });
  snapshots.set(threadId,{at:Date.now(),promise});
  if(snapshots.size>30)snapshots.delete(snapshots.keys().next().value);
  try{return await promise;}catch(error){snapshots.delete(threadId);throw error;}
}
export async function readAgentStatus(goalId) {
  const {goal,root}=await readGoalContext(goalId);
  const result={goalId:goal.id,rootId:root.id,rootTitle:root.title,connected:Boolean(root.threadId),capabilities:{settings:false,stop:false,resume:false}};
  if(!root.threadId)return result;
  const data=await snapshot(root.threadId);
  // Recheck ownership after I/O so a reassigned Goal never displays the old agent.
  if((await readGoalContext(goalId)).root.threadId!==root.threadId)throw new Error('Agent assignment changed. Try again.');
  const goals=await listGoals(),selection=await readExecution(root.threadId);
  const feedback=(await readFeedback()).filter(e=>e.author==='user'&&e.threadId===root.threadId);
  let deliveries=await Promise.all(feedback.map(e=>readDelivery(e.changeId)));
  // Use the same refreshed delivery records as Conversation, including brief
  // replies that never select a work Goal. Do not infer Desktop state here.
  const activeGoals=[...new Set(deliveries.filter(d=>d&&['working','received','queued'].includes(d.status)).map(d=>d.goalId))];
  // Refresh through the shared reader in the background: long historical
  // catch-up must not block the settings menu or an autosave response.
  void Promise.all(activeGoals.map(id=>refreshWorkOutputs(id))).catch(()=>{});
  deliveries=(await Promise.all(feedback.map(e=>readDelivery(e.changeId)))).filter(Boolean);
  const executions=await executionForGoals(goals);
  const work=agentWorkFromRecords(goals,selection,deliveries,executions.get(selection?.goalId));
  const editable=data.thread&&await canUpdateDesktopSettings(root.threadId,{model:data.thread.model,effort:data.thread.reasoningEffort});
  result.capabilities.settings=Boolean(editable);
  const controlRecord=await readControlRecord(root.threadId);
  const controlTurn=editable||controlRecord?await latestControlTurn(root.threadId).catch(()=>null):null;
  const control=controlView(controlRecord,controlTurn);
  const controllable=editable&&await canControlDesktop(root.threadId);
  result.control={turnId:controlTurn?.id||null,status:control?.status||null};
  if(control){Object.assign(work,control);}
  // Header and menu use the same live, chat-wide evidence, including auto runs.
  const presence=await readAgentPresence(goalId).catch(()=>({status:'unknown',goalId:null,title:null}));
  Object.assign(work,{status:presence.status,goalId:presence.goalId,title:presence.title});
  result.capabilities.stop=Boolean(controllable&&work.status==='working'&&controlTurn&&controlTurn.completedAt==null);
  result.capabilities.resume=Boolean(controllable&&control?.status==='paused');
  const model=data.models.find(m=>m.id===data.thread?.model||m.model===data.thread?.model);
  let queue=null;
  if(data.queue){
    const mapping=new Map();
    for(const d of deliveries)if(d.messageId)mapping.set(d.transportMessageId||d.messageId,d.goalId);
    queue={truncated:data.queue.truncated,items:data.queue.data.map(item=>{const id=mapping.get(item.clientUserMessageId),g=goals.find(g=>g.id===id);return {goalId:g?.id||null,title:g?.title||'Codex message'};})};
  }
  return {...result,threadId:root.threadId,models:editable?data.models.filter(m=>!m.hidden).map(m=>({id:m.model||m.id,label:m.displayName||m.model||m.id,efforts:(m.supportedReasoningEfforts||[]).map(e=>e.reasoningEffort),defaultEffort:m.defaultReasoningEffort})):[],checkedAt:data.checkedAt,settings:data.thread?{model:data.thread.model||null,label:model?.displayName||data.thread.model||null,reasoning:data.thread.reasoningEffort||null}:null,
    work,usage:data.usage,queue};
}

const saving=new Set();
export async function saveAgentSettings(goalId,input){
 const {root}=await readGoalContext(goalId),threadId=root.threadId;
 if(!threadId||input.threadId!==threadId)throw Error('Agent changed. Refresh to retry.');
 if(saving.has(threadId))throw Error('Saving…');
 saving.add(threadId);
 try{
  snapshots.delete(threadId);const data=await snapshot(threadId);
  const model=data.models.find(m=>!m.hidden&&(m.model||m.id)===input.model);
  if(!model||!model.supportedReasoningEfforts?.some(e=>e.reasoningEffort===input.effort))throw Error('Choose a supported model and reasoning level.');
  if(!data.thread||data.thread.model!==input.expected?.model||data.thread.reasoningEffort!==input.expected?.effort)throw Error('Settings changed. Refresh to retry.');
  if((await readGoalContext(goalId)).root.threadId!==threadId)throw Error('Agent changed.');
  const r=await updateDesktopSettings(threadId,{model:input.model,effort:input.effort},input.expected);
  if(r?.applied!==true)throw Error('Could not save. Refresh to retry.');
  snapshots.delete(threadId);const after=await snapshot(threadId);
  if(after.thread?.model!==input.model||after.thread?.reasoningEffort!==input.effort)throw Error('Save unconfirmed. Refresh to check.');
  return await readAgentStatus(goalId);
 }finally{saving.delete(threadId);snapshots.delete(threadId);}
}

export async function controlAgent(goalId,input){
 const activity=await readAgentActivity(goalId,{fresh:true});
 if(!activity?.capabilities[input.action]||(input.turnId!==null&&input.turnId!==activity.turnId)||input.eventId!==activity.eventId)throw Error('Status changed. Refresh to check.');
 const target=(await listGoals()).find(g=>g.id===activity.targetGoalId);
 if(input.action==='stop')await pauseFeedback(goalId,input,{goalId:target?.id||goalId,title:target?.title||null});
 else if(activity.holdId)await resumeHeldFeedback(goalId,input);
 else await applyAgentControl(goalId,{...input,activity:{goalId,eventId:activity.eventId}},{goalId:target?.id||goalId,title:target?.title||null});
 for(let i=0;input.turnId&&i<10;i++){
  const turn=await latestControlTurn(activity.threadId).catch(()=>null);
  if(turn&&(input.action==='stop'?turn.id!==input.turnId||turn.completedAt!=null:turn.id!==input.turnId))break;
  await new Promise(resolve=>setTimeout(resolve,100));
 }
 snapshots.delete(activity.threadId);invalidateActivity(activity.threadId);
 return await readAgentActivity(goalId,{fresh:true});
}
