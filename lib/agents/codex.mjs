// Codex Desktop chats bound to a Root. Codex is reached natively, so its run,
// settings, usage and controls come from the Codex app; which comments it was
// handed and which Goals await a reply follow the shared rules (codex-work).
import {resolveAgentConnection,connectionKey} from './connection.mjs';
import {createAgentSettingsStore} from './settings-store.mjs';
import {readEvent,readGoalContext} from '../goal-store.mjs';
import {overlayCodexExecutions,presenceOf} from './codex-run.mjs';
import {codexCommentStates,codexSnapshot,handIdleCodex,pauseCodex,resumeCodex} from './codex-work.mjs';
import {selectWork} from './codex-execution.mjs';
import {codexContinuation} from './codex-continuation.mjs';
import {activityOf,queueOf,sendNow} from '../hand-off.mjs';
import {interruptDesktopTurn} from '../desktop-settings.mjs';
import {hidden} from '../hidden-failure.mjs';
export const codexExecutions=overlayCodexExecutions;

const settingsStore=createAgentSettingsStore();

export function codexAgent(root) {
  if(!root.threadId)return null;
  const threadId=root.threadId,connection=resolveAgentConnection(root);
  const token=connectionKey(connection);
  // Recheck ownership after I/O so a reassigned Goal never shows the old agent.
  const assertCurrent=async goalId=>{if((await readGoalContext(goalId)).root.threadId!==threadId)throw Error('Agent assignment changed. Try again.');};
  const snapshot=options=>codexSnapshot(threadId,options);
  // Pause stops the running turn and holds comments until Resume.
  async function control(input) {
    const current=await snapshot({fresh:true});
    if(input.action==='stop'){
      if(current.status!=='running'||!input.turnId||input.turnId!==current.work.id)throw Error('Status changed. Refresh to check.');
      await pauseCodex(threadId,input.turnId,{interrupt:interruptDesktopTurn});
    }else if(input.action==='resume'){
      if(current.status!=='paused')throw Error('Nothing to resume. Refresh to check.');
      await resumeCodex(threadId);
    }else throw Error('Invalid action.');
    settingsStore.invalidate(connection);
  }
  return {
    token,
    name:'Codex',
    presence:async()=>presenceOf(await snapshot()),
    async status(goalId) {
      const data=await settingsStore.read(connection);
      await assertCurrent(goalId);
      const current=await snapshot().catch(hidden('codex.presence',null));
      const work=current?presenceOf(current):{status:'unknown',goalId:null,title:null};
      const editable=Boolean(await connection.canSaveSettings(data));
      const controllable=editable&&await connection.canControl();
      await assertCurrent(goalId);
      return {agent:{name:'Codex',model:data.settings?{model:data.settings.label||data.settings.model,reasoning:data.settings.reasoning}:null,status:null},
        capabilities:{settings:editable,stop:Boolean(controllable&&current?.status==='running'),resume:Boolean(controllable&&current?.status==='paused'),approveAll:false},
        control:{turnId:current?.status==='running'?current.work.id:null,status:work.status},
        settings:data.settings,models:editable?data.models:[],checkedAt:data.checkedAt,usage:data.usage,usageScope:'Shared across your Codex account',work,
        queue:current?queueOf(current,{label:connection.messageLabel}):null};
    },
    async control(goalId,input) {
      const status=await this.status(goalId);
      if(status.control?.turnId!==(input.turnId??null)&&input.action==='stop')throw Error('Status changed. Refresh to check.');
      await control(input);
    },
    async activity(goalId) {
      const current=await snapshot().catch(hidden('codex.activity',null));
      const row=current?activityOf(current,goalId):null;
      if(!row)return null;
      const controllable=await connection.canControl();
      return {threadId,goalId,targetGoalId:goalId,work:null,...row,capabilities:{stop:Boolean(controllable&&row.status==='working'),resume:Boolean(controllable&&row.status==='paused')}};
    },
    async controlActivity(goalId,input) {
      const activity=await this.activity(goalId);
      if(!activity?.capabilities[input.action]||input.eventId!==activity.eventId)throw Error('Status changed. Refresh to check.');
      await control({...input,turnId:activity.turnId});
      return this.activity(goalId);
    },
    continuation:codexContinuation(root),
    isCaller:async(env=process.env)=>env.CODEX_THREAD_ID===threadId,
    selectWork:(goalId,{stop,env=process.env})=>selectWork(goalId,{stop,threadId:env.CODEX_THREAD_ID}),
    async setApproveAll() {throw Error('Approve all is not available for this agent.');},
    async saveSettings(goalId,input) {
      await settingsStore.save(connection,input,{assertCurrent:async()=>{
        const current=resolveAgentConnection((await readGoalContext(goalId)).root);
        if(!current||connectionKey(current)!==token)throw Error('Agent changed.');
      }});
    },
  };
}

// A comment for a Codex chat is sent when the chat is not working, or handed at
// its next hook; no per-comment record is kept. A Goal is answered by a reply on it.
const view=async id=>(await codexCommentStates([{eventId:Number(id),goalId:(await readEvent(Number(id))).goalId}]))[0];
const rootOf=async id=>(await readGoalContext((await readEvent(Number(id))).goalId)).root;
const codexCarrier={
  async deliver(id) {await handIdleCodex((await rootOf(id)).threadId);return view(id);},
  async sendNow(id) {const root=await rootOf(id);await sendNow(root.id);await handIdleCodex(root.threadId);return view(id);},
};
// Whether this process runs inside some Codex chat.
export const codexCaller=env=>Boolean(env.CODEX_THREAD_ID);
export const codexDeliveries={carrier:state=>state.threadId&&!state.connection?codexCarrier:null,decorate:codexCommentStates};
