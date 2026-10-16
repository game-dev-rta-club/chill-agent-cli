// Claude Code conversations bound to a Root. Everything Claude-specific that the
// Agent menu and controls need lives behind this adapter.
import {createHash} from 'node:crypto';
import {identifyClaudeCaller} from '../claude-entry.mjs';
import {readClaudeConnectionStatus} from '../claude-status.mjs';
import {readClaudePause,setClaudePause} from '../claude-pause.mjs';
import {readClaudeApproveAll,setClaudeApproveAll} from '../claude-permissions.mjs';
import {observeClaude,claudeQueue,claudeWaiting,overlayClaudeExecutions} from './claude-run.mjs';
export const claudeExecutions=overlayClaudeExecutions;
import {readDeliveryState} from '../delivery.mjs';
import {runClaudeAction} from '../claude-actions.mjs';
import {withClaudeReception} from '../claude-status.mjs';
import {claudeContinuation} from './claude-continuation.mjs';
import {selectClaudeWork} from '../claude-work.mjs';

export function claudeAgent(root) {
  const connection=root.connection;
  if(root.threadId||connection?.harnessId!=='claude-code')return null;
  const token=createHash('sha256').update(JSON.stringify(['claude',connection.sessionId,connection.contextId])).digest('hex').slice(0,24);
  return {
    token,
    name:'Claude Code',
    presence:()=>observeClaude(connection),
    continuation:claudeContinuation(root),
    async status(goalId) {
      const [line,work,queue,pause,approveAll]=await Promise.all([
        readClaudeConnectionStatus(connection),
        observeClaude(connection).catch(()=>({status:'unknown',goalId:null,title:null})),
        claudeQueue(connection).catch(()=>null),readClaudePause(connection),readClaudeApproveAll(connection)]);
      return {agent:{name:'Claude Code',model:line.settings||null,status:{label:line.label,detail:line.detail,at:line.waiterCheckedAt||line.observedAt||null}},
        capabilities:{settings:false,stop:!pause.paused&&work.status==='working',resume:pause.paused,approveAll:true},
        approveAll,work,queue};
    },
    // Claude cannot be interrupted from outside; Pause works through its hooks.
    async control(goalId,input) {await setClaudePause(connection,input.action==='stop');},
    // One message's run, for the Activity row under it. Claude pauses the whole
    // conversation, so the row's Pause/Resume is the conversation's pause shown
    // at the message it is working on, or at the newest one waiting for it.
    async activity(goalId) {
      const [run,pause,waiting]=await Promise.all([observeClaude(connection).catch(()=>null),readClaudePause(connection),claudeWaiting(connection,goalId)]);
      if(!run?.connected)return null;
      const row=(eventId,status,turnId=null)=>({threadId:null,turnId,eventId,goalId,targetGoalId:goalId,status,work:null,
        capabilities:{stop:status!=='paused',resume:status==='paused'}});
      if(pause.paused){
        // The paused message is the one still waiting here, else the last one it worked on.
        const eventId=waiting||(run.last?.goalId===goalId?run.last.eventId:null);
        return eventId?row(eventId,'paused'):null;
      }
      if(run.status==='working'&&run.goalId===goalId&&run.eventId)return row(run.eventId,'working',run.turnId);
      return waiting?row(waiting,'saved'):null;
    },
    async controlActivity(goalId,input) {
      const activity=await this.activity(goalId);
      if(!activity?.capabilities[input.action]||input.eventId!==activity.eventId)throw Error('Status changed. Refresh to check.');
      await setClaudePause(connection,input.action==='stop');
      return this.activity(goalId);
    },
    async isCaller(env=process.env) {
      const caller=await identifyClaudeCaller({env}).catch(()=>null);
      return caller?.identity.sessionId===connection.sessionId&&caller.contextId===connection.contextId;
    },
    selectWork:(goalId,{stop,env=process.env})=>selectClaudeWork(goalId,connection,{stop,env}),
    async setApproveAll(on) {await setClaudeApproveAll(connection,on);},
    async saveSettings() {throw Error('This agent\'s settings are changed in its own app.');},
  };
}

// Claude has no way to receive a push. Saved feedback waits for the
// conversation's own hooks or its watcher. A receipt is recorded at once.
const claudeCarrier={
  deliver:id=>readDeliveryState(id),
  async receipt(id,status,env) {
    if(status==='deferred')throw Error('Deferred is only for feedback waiting in a native Queue. Handle it now, or leave it unread.');
    return {text:(await runClaudeAction('activity',{eventId:Number(id),state:status},{env})).text};
  },
};
export const claudeDeliveries={carrier:state=>state.connection?.harnessId==='claude-code'?claudeCarrier:null,decorate:withClaudeReception};
