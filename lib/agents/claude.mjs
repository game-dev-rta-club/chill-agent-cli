// Claude Code conversations bound to a Root. Everything Claude-specific that the
// Agent menu and controls need lives behind this adapter.
import {createHash} from 'node:crypto';
import {identifyClaudeCaller} from '../claude-entry.mjs';
import {readClaudeConnectionStatus} from '../claude-status.mjs';
import {readClaudePause,setClaudePause} from '../claude-pause.mjs';
import {readClaudeApproveAll,setClaudeApproveAll} from '../claude-permissions.mjs';
import {observeClaude,claudeQueue,overlayClaudeExecutions} from './claude-run.mjs';
export const claudeExecutions=overlayClaudeExecutions;
import {readDeliveryState} from '../delivery.mjs';
import {requestClaudeAction} from '../claude-actions.mjs';
import {withClaudeReception} from '../claude-status.mjs';

export function claudeAgent(root) {
  const connection=root.connection;
  if(root.threadId||connection?.harnessId!=='claude-code')return null;
  const token=createHash('sha256').update(JSON.stringify(['claude',connection.sessionId,connection.contextId])).digest('hex').slice(0,24);
  return {
    token,
    presence:()=>observeClaude(connection),
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
    async controlActivity(goalId,input) {await setClaudePause(connection,input.action==='stop');},
    async isCaller(env=process.env) {
      const caller=await identifyClaudeCaller({env}).catch(()=>null);
      return caller?.identity.sessionId===connection.sessionId&&caller.contextId===connection.contextId;
    },
    async setApproveAll(on) {await setClaudeApproveAll(connection,on);},
    async saveSettings() {throw Error('This agent\'s settings are changed in its own app.');},
  };
}

// Claude has no way to receive a push. Saved feedback waits for the
// conversation's own hooks or its reply waiter. A receipt from the shell is a
// request that the conversation's main hook confirms on the next tool result.
const claudeCarrier={
  deliver:id=>readDeliveryState(id),
  async receipt(id,status,env) {
    if(status==='deferred')throw Error('Deferred is only for feedback waiting in a native Queue. Handle it now, or leave it unread.');
    const request=await requestClaudeAction('activity',{eventId:Number(id),state:status},{env});
    return {pending:request.marker,note:'Pending main-session hook confirmation. A shell receipt alone does not confirm this action.'};
  },
};
export const claudeDeliveries={carrier:state=>state.connection?.harnessId==='claude-code'?claudeCarrier:null,decorate:withClaudeReception};
