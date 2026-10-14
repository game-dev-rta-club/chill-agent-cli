// Codex Desktop chats bound to a Root. Codex is reached natively, so its run,
// queue, settings, usage and controls come from the Codex app.
import {pauseFeedback,resumeHeldFeedback} from '../feedback-hold.mjs';
import {readAgentActivity,invalidateActivity} from '../agent-activity.mjs';
import {latestControlTurn,applyAgentControl} from '../agent-control.mjs';
import {resolveAgentConnection,connectionKey} from '../agent-connection.mjs';
import {createAgentSettingsStore} from '../agent-settings.mjs';
import {readGoalContext,readFeedback,listGoals} from '../goal-store.mjs';
import {readDelivery} from '../delivery.mjs';
import {observeCodex,overlayCodexExecutions} from './codex-run.mjs';
export const codexExecutions=overlayCodexExecutions;
import {observeAgentRun} from '../agent-observation.mjs';

const settingsStore=createAgentSettingsStore();
async function waitForTurn(threadId,input){
  for(let i=0;input.turnId&&i<10;i++){
    const turn=await latestControlTurn(threadId).catch(()=>null);
    if(turn&&(input.action==='stop'?turn.id!==input.turnId||turn.completedAt!=null:turn.id!==input.turnId))break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
}

export function codexAgent(root) {
  if(!root.threadId)return null;
  const threadId=root.threadId,connection=resolveAgentConnection(root);
  const token=connectionKey(connection);
  // Recheck ownership after I/O so a reassigned Goal never shows the old agent.
  const assertCurrent=async goalId=>{if((await readGoalContext(goalId)).root.threadId!==threadId)throw Error('Agent assignment changed. Try again.');};
  return {
    token,
    async presence(){return {connected:true,...await observeCodex(threadId)};},
    async status(goalId) {
      const data=await settingsStore.read(connection);
      await assertCurrent(goalId);
      const goals=await listGoals();
      const feedback=(await readFeedback()).filter(e=>e.author==='user'&&e.threadId===threadId);
      const deliveries=(await Promise.all(feedback.map(e=>readDelivery(e.changeId)))).filter(Boolean);
      const work=await this.presence().catch(()=>({status:'unknown',goalId:null,title:null}));
      const editable=Boolean(await connection.canSaveSettings(data));
      const observed=await observeAgentRun(connection).catch(()=>null);
      const controlTurn=observed?.turn,view=observed?.view;
      const controllable=editable&&await connection.canControl();
      await assertCurrent(goalId);
      let queue=null;
      if(data.queue){
        const mapping=new Map();
        for(const d of deliveries)if(d.messageId)mapping.set(d.transportMessageId||d.messageId,d.goalId);
        queue={truncated:data.queue.truncated,items:data.queue.items.map(item=>{const id=mapping.get(item.messageId),g=goals.find(g=>g.id===id);return {goalId:g?.id||null,title:g?.title||connection.messageLabel};})};
      }
      return {agent:{name:'Codex',model:data.settings?{model:data.settings.label||data.settings.model,reasoning:data.settings.reasoning}:null,status:null},
        capabilities:{settings:editable,stop:Boolean(controllable&&work.status==='working'&&controlTurn&&controlTurn.completedAt==null),resume:Boolean(controllable&&view?.status==='paused'),approveAll:false},
        control:{turnId:controlTurn?.id||null,status:view?.status||null},
        settings:data.settings,models:editable?data.models:[],checkedAt:data.checkedAt,usage:data.usage,usageScope:'Shared across your Codex account',work,queue};
    },
    async control(goalId,input) {
      const status=await this.status(goalId);
      if(status.control?.turnId!==input.turnId)throw Error('Status changed. Refresh to check.');
      await applyAgentControl(goalId,{...input,threadId,activity:null},{goalId:status.work?.goalId||goalId,title:status.work?.title||null});
      await waitForTurn(threadId,input);
      settingsStore.invalidate(connection);invalidateActivity(threadId);
    },
    async controlActivity(goalId,input) {
      const activity=await readAgentActivity(goalId,{fresh:true});
      if(!activity?.capabilities[input.action]||(input.turnId!==null&&input.turnId!==activity.turnId)||input.eventId!==activity.eventId)throw Error('Status changed. Refresh to check.');
      const target=(await listGoals()).find(g=>g.id===activity.targetGoalId);
      if(input.action==='stop')await pauseFeedback(goalId,input,{goalId:target?.id||goalId,title:target?.title||null});
      else if(activity.holdId)await resumeHeldFeedback(goalId,input);
      else await applyAgentControl(goalId,{...input,activity:{goalId,eventId:activity.eventId}},{goalId:target?.id||goalId,title:target?.title||null});
      await waitForTurn(activity.threadId,input);
      settingsStore.invalidate(connection);invalidateActivity(activity.threadId);
      return readAgentActivity(goalId,{fresh:true});
    },
    async setApproveAll() {throw Error('Approve all is not available for this agent.');},
    async saveSettings(goalId,input) {
      await settingsStore.save(connection,input,{assertCurrent:async()=>{
        const current=resolveAgentConnection((await readGoalContext(goalId)).root);
        if(!current||connectionKey(current)!==token)throw Error('Agent changed.');
      }});
    },
  };
}
