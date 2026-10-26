// Codex Desktop chats bound to a Root. Codex is reached natively, so its run,
// settings, usage and controls come from the Codex app; which comments it was
// handed and which Goals await a reply follow the shared rules (codex-work).
import {resolveAgentConnection,connectionKey} from './connection.mjs';
import {createAgentSettingsStore} from './settings-store.mjs';
import {readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {readEvent,readGoalContext,workspaceDirectory} from '../goal-store.mjs';
import {overlayCodexExecutions,presenceOf} from './codex-run.mjs';
import {codexSnapshot,codexThink,handIdleCodex,pauseCodex,resumeCodex,readCodexWork} from './codex-work.mjs';
import {selectWork,readExecution,heartbeatTTL} from './codex-execution.mjs';
import {codexContinuation} from './codex-continuation.mjs';
import {commentMarks,goalActivity,queueOf,runningIn,sendNow} from '../hand-off.mjs';
import {interruptDesktopTurn} from '../desktop-settings.mjs';
import {hidden,recordHidden} from '../hidden-failure.mjs';
export const codexExecutions=overlayCodexExecutions;
// The Goals each Codex chat with a fresh heartbeat works on: the one it
// selected with goal work and those its running turn was handed.
export async function codexLiveWork() {
  const base=join(workspaceDirectory(),'executions'),live=[];
  const files=await readdir(base).catch(error=>{if(error.code!=='ENOENT')recordHidden('codex.live-work',error);return [];});
  for(const file of files.filter(f=>f.endsWith('.json'))){
    const threadId=file.slice(0,-5),execution=await readExecution(threadId).catch(hidden('codex.live-work',null));
    if(!execution||execution.stoppedAt||!(Date.now()-Date.parse(execution.heartbeatAt)<heartbeatTTL))continue;
    const work=await readCodexWork(threadId);
    live.push({token:connectionKey(resolveAgentConnection({threadId})),goals:[execution.goalId,...(work.turnId===execution.turnId?work.goals:[])].filter(Boolean)});
  }
  return live;
}

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
        capabilities:{settings:editable,stop:Boolean(controllable&&current?.status==='running'),resume:Boolean(controllable&&current?.status==='paused')},
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
      const status=current?goalActivity(current,goalId):null;
      if(!status)return null;
      const within=runningIn(current,goalId);
      if(within)return {goalId,status,turnId:null,in:within,capabilities:{stop:false,resume:false},work:null};
      const controllable=await connection.canControl();
      return {goalId,status,turnId:status==='running'?current.work.id:null,capabilities:{stop:Boolean(controllable&&status==='running'),resume:Boolean(controllable&&status==='paused')},
        work:status==='queued'?null:await codexThink(current).catch(hidden('codex.think',null))};
    },
    // A comment Codex could not be reached for is sent once it can be: there is no Retry.
    async comments(goalId) {
      let current=await snapshot();
      if(current.reachable&&current.roots.some(r=>r.pending.length&&!r.hold)&&(await handIdleCodex(threadId)).length)current=await snapshot({fresh:true});
      return commentMarks(current,goalId);
    },
    continuation:codexContinuation(root),
    isCaller:async(env=process.env)=>env.CODEX_THREAD_ID===threadId,
    selectWork:(goalId,{stop,env=process.env})=>selectWork(goalId,{stop,threadId:env.CODEX_THREAD_ID}),
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
const rootOf=async id=>(await readGoalContext((await readEvent(Number(id))).goalId)).root;
const mark=async id=>{const {goalId}=await readEvent(Number(id)),{root}=await readGoalContext(goalId);return (await codexAgent(root).comments(goalId)).find(m=>m.eventId===Number(id));};
const codexCarrier={
  // A comment written after Pause resumes the chat; Resume sends it with what waited.
  async deliver(id) {
    const {threadId}=await rootOf(id);
    if((await readCodexWork(threadId)).paused)await resumeCodex(threadId).catch(hidden('codex.comment-resume'));
    else await handIdleCodex(threadId);
    return mark(id);
  },
  async sendNow(id) {const root=await rootOf(id);await sendNow(root.id,Number(id));await handIdleCodex(root.threadId);return mark(id);},
};
// Whether this process runs inside some Codex chat.
export const codexCaller=env=>Boolean(env.CODEX_THREAD_ID);
export const codexDeliveries={carrier:state=>state.threadId&&!state.connection?codexCarrier:null};
