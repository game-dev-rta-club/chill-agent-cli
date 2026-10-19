// Claude Code conversations bound to a Root. Everything Claude-specific that the
// Agent menu and controls need lives behind this adapter.
import {createHash} from 'node:crypto';
import {identifyClaudeCaller} from '../claude-entry.mjs';
import {readClaudeConnectionStatus} from '../claude-status.mjs';
import {readClaudePause,setClaudePause} from '../claude-pause.mjs';
import {readClaudeApproveAll,setClaudeApproveAll} from '../claude-permissions.mjs';
import {observeClaude,claudeQueue,claudeSnapshot,claudeThink,overlayClaudeExecutions} from './claude-run.mjs';
import {commentMarks,goalActivity,runningIn,sendNow} from '../hand-off.mjs';
export const claudeExecutions=overlayClaudeExecutions;
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
    async activity(goalId) {
      const snapshot=await claudeSnapshot(connection).catch(hidden('claude.activity'));
      const status=snapshot?.linked?goalActivity(snapshot,goalId):null,within=status&&runningIn(snapshot,goalId);
      if(within)return {goalId,status,turnId:null,in:within,capabilities:{stop:false,resume:false},work:null};
      return status&&{goalId,status,turnId:null,capabilities:{stop:status==='running',resume:status==='paused'},work:await claudeThink(snapshot).catch(hidden('claude.think',null))};
    },
    async comments(goalId) {
      const snapshot=await claudeSnapshot(connection);
      return commentMarks(snapshot,goalId);
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
// hooks or its watcher, which hand them over by the Root's cursor (hand-off).
const mark=async id=>{
  const {readEvent,readGoalContext}=await import('../goal-store.mjs');
  const {goalId}=await readEvent(Number(id)),{root}=await readGoalContext(goalId);
  return {root,mark:(await claudeAgent(root).comments(goalId)).find(m=>m.eventId===Number(id))};
};
const claudeCarrier={
  deliver:async id=>(await mark(id)).mark,
  sendNow:async id=>{await sendNow((await mark(id)).root.id,Number(id));return (await mark(id)).mark;},
};
// Whether this process runs inside some Claude conversation.
export const claudeCaller=env=>Boolean(env.CLAUDE_CODE_SESSION_ID);
export const claudeDeliveries={carrier:state=>state.connection?.harnessId==='claude-code'?claudeCarrier:null};
