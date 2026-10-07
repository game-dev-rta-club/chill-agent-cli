import {pauseFeedback,resumeHeldFeedback} from './feedback-hold.mjs';
import {readAgentActivity,invalidateActivity} from './agent-activity.mjs';
import {latestControlTurn,applyAgentControl} from './agent-control.mjs';
import {resolveAgentConnection,connectionKey} from './agent-connection.mjs';
import {createAgentSettingsStore} from './agent-settings.mjs';
import {readGoalContext,readFeedback,listGoals} from './goal-store.mjs';
import {readDelivery} from './delivery.mjs';
import {readAgentPresence} from './agent-presence.mjs';
import {observeAgentRun} from './agent-observation.mjs';
import {withCodex} from './codex-client.mjs';
import {readClaudeConnectionStatus} from './claude-status.mjs';

const settingsStore=createAgentSettingsStore();
export async function readAgentStatus(goalId) {
  const {goal,root}=await readGoalContext(goalId);
  const result={goalId:goal.id,rootId:root.id,rootTitle:root.title,connected:Boolean(root.threadId),capabilities:{settings:false,stop:false,resume:false}};
  if(root.connection){
    const status=await readClaudeConnectionStatus(root.connection);
    if(JSON.stringify((await readGoalContext(goalId)).root.connection)!==JSON.stringify(root.connection))throw Error('Agent assignment changed. Try again.');
    return {...result,nativeConnection:{harnessId:root.connection.harnessId,stage:'experimental',status,
      detail:'Model settings, usage and activity controls are not available for this connection yet.'}};
  }
  if(!root.threadId)return result;
  const connection=resolveAgentConnection(root),data=await settingsStore.read(connection);
  // Recheck ownership after I/O so a reassigned Goal never displays the old agent.
  if(connectionKey(resolveAgentConnection((await readGoalContext(goalId)).root))!==connectionKey(connection))throw new Error('Agent assignment changed. Try again.');
  const goals=await listGoals();
  const feedback=(await readFeedback()).filter(e=>e.author==='user'&&e.threadId===root.threadId);
  const deliveries=(await Promise.all(feedback.map(e=>readDelivery(e.changeId)))).filter(Boolean);
  const work=await readAgentPresence(goalId).catch(()=>({status:'unknown',goalId:null,title:null}));
  const editable=await connection.canSaveSettings(data);
  result.capabilities.settings=Boolean(editable);
  const observed=await observeAgentRun(connection).catch(()=>null);
  const controlTurn=observed?.turn,control=observed?.view;
  const controllable=editable&&await connection.canControl();
  result.control={turnId:controlTurn?.id||null,status:control?.status||null};
  result.capabilities.stop=Boolean(controllable&&work.status==='working'&&controlTurn&&controlTurn.completedAt==null);
  result.capabilities.resume=Boolean(controllable&&control?.status==='paused');
  let currentMessages=[];
  if(controlTurn&&(controlTurn.completedAt==null||control?.status==='paused')){
    currentMessages=await withCodex(async client=>{
      const page=await client.request('thread/items/list',{threadId:root.threadId,turnId:controlTurn.id,sortDirection:'desc',limit:30});
      return (page.data||[]).filter(e=>e.turnId===controlTurn.id&&e.item?.type==='agentMessage'&&typeof e.item.text==='string').slice(0,3).reverse().map(e=>({text:e.item.text.slice(-2000)}));
    }).catch(()=>[]);
  }
  if((await readGoalContext(goalId)).root.threadId!==root.threadId)throw Error('Agent assignment changed. Try again.');
  let queue=null;
  if(data.queue){
    const mapping=new Map();
    for(const d of deliveries)if(d.messageId)mapping.set(d.transportMessageId||d.messageId,d.goalId);
    queue={truncated:data.queue.truncated,items:data.queue.items.map(item=>{const id=mapping.get(item.messageId),g=goals.find(g=>g.id===id);return {goalId:g?.id||null,title:g?.title||connection.messageLabel};})};
  }
  return {...result,threadId:root.threadId,models:editable?data.models:[],checkedAt:data.checkedAt,settings:data.settings,
    work,currentMessages,usage:data.usage,queue};
}

export async function saveAgentSettings(goalId,input){
 const {root}=await readGoalContext(goalId),connection=resolveAgentConnection(root);
 if(!connection||input.threadId!==root.threadId)throw Error('Agent changed. Refresh to retry.');
 await settingsStore.save(connection,input,{assertCurrent:async()=>{
  const current=resolveAgentConnection((await readGoalContext(goalId)).root);
  if(!current||connectionKey(current)!==connectionKey(connection))throw Error('Agent changed.');
 }});
 return readAgentStatus(goalId);
}

export async function controlAgent(goalId,input){
 if(input.scope==='current'){
  const status=await readAgentStatus(goalId);
  if(!['stop','resume'].includes(input.action)||!status.capabilities[input.action]||status.threadId!==input.threadId||status.control?.turnId!==input.turnId)throw Error('Status changed. Refresh to check.');
  await applyAgentControl(goalId,{...input,activity:null},{goalId:status.work?.goalId||goalId,title:status.work?.title||null});
  for(let i=0;i<10;i++){
   const turn=await latestControlTurn(input.threadId).catch(()=>null);
   if(turn&&(input.action==='stop'?turn.id!==input.turnId||turn.completedAt!=null:turn.id!==input.turnId))break;
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  settingsStore.invalidate(resolveAgentConnection({threadId:input.threadId}));invalidateActivity(input.threadId);
  return readAgentStatus(goalId);
 }
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
 settingsStore.invalidate(resolveAgentConnection({threadId:activity.threadId}));invalidateActivity(activity.threadId);
 return await readAgentActivity(goalId,{fresh:true});
}
