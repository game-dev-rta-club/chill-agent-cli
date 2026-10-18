// Claude Code conversations bound to a Root. Everything Claude-specific that the
// Agent menu and controls need lives behind this adapter.
import {createHash} from 'node:crypto';
import {identifyClaudeCaller} from '../claude-entry.mjs';
import {readClaudeConnectionStatus} from '../claude-status.mjs';
import {readClaudePause,setClaudePause} from '../claude-pause.mjs';
import {readClaudeApproveAll,setClaudeApproveAll} from '../claude-permissions.mjs';
import {observeClaude,claudeQueue,claudeSnapshot,overlayClaudeExecutions,claudeCommentStates} from './claude-run.mjs';
import {activityOf} from '../hand-off.mjs';
export const claudeExecutions=overlayClaudeExecutions;
import {runClaudeAction} from '../claude-actions.mjs';
import {claudeContinuation} from './claude-continuation.mjs';
import {selectClaudeWork} from '../claude-work.mjs';
import {hidden} from '../hidden-failure.mjs';

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
        observeClaude(connection).catch(hidden('claude.presence',{status:'unknown',goalId:null,title:null})),
        claudeQueue(connection).catch(hidden('claude.queue')),readClaudePause(connection),readClaudeApproveAll(connection)]);
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
      const snapshot=await claudeSnapshot(connection).catch(hidden('claude.activity-run'));
      const row=snapshot?.linked?activityOf(snapshot,goalId):null;
      return row&&{threadId:null,goalId,targetGoalId:goalId,work:null,...row,capabilities:{stop:row.status!=='paused',resume:row.status==='paused'}};
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

// Claude has no way to receive a push. Comments wait for the conversation's own
// hooks or its watcher, which hand them over by the Root's cursor (hand-off);
// no per-comment record is kept. A Goal is answered by a reply on it.
const claudeCarrier={
  deliver:async id=>(await claudeCommentStates([{eventId:Number(id),goalId:(await (await import('../goal-store.mjs')).readEvent(Number(id))).goalId}]))[0],
  sendNow:async id=>{const {readEvent,readGoalContext}=await import('../goal-store.mjs');const {sendNow}=await import('../hand-off.mjs');await sendNow((await readGoalContext((await readEvent(Number(id))).goalId)).root.id);return (await claudeCarrier.deliver(id));},
};
// Whether this process runs inside some Claude conversation.
export const claudeCaller=env=>Boolean(env.CLAUDE_CODE_SESSION_ID);
export const claudeDeliveries={carrier:state=>state.connection?.harnessId==='claude-code'?claudeCarrier:null,decorate:claudeCommentStates};
