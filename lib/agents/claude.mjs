// Claude Code conversations bound to a Root. Everything Claude-specific that the
// Agent menu and controls need lives behind this adapter.
import {createHash} from 'node:crypto';
import {readClaudeConnectionStatus} from '../claude-status.mjs';
import {readClaudePause,setClaudePause} from '../claude-pause.mjs';
import {readClaudeApproveAll,setClaudeApproveAll} from '../claude-permissions.mjs';
import {readAgentPresence,claudeQueue} from '../agent-presence.mjs';

export function claudeAgent(root) {
  const connection=root.connection;
  if(root.threadId||connection?.harnessId!=='claude-code')return null;
  const token=createHash('sha256').update(JSON.stringify(['claude',connection.sessionId,connection.contextId])).digest('hex').slice(0,24);
  return {
    token,
    async status(goalId) {
      const [line,work,queue,pause,approveAll]=await Promise.all([
        readClaudeConnectionStatus(connection),
        readAgentPresence(goalId).catch(()=>({status:'unknown',goalId:null,title:null})),
        claudeQueue(connection).catch(()=>null),readClaudePause(connection),readClaudeApproveAll(connection)]);
      return {agent:{name:'Claude Code',model:line.settings||null,status:{label:line.label,detail:line.detail,at:line.waiterCheckedAt||line.observedAt||null}},
        capabilities:{settings:false,stop:!pause.paused&&work.status==='working',resume:pause.paused,approveAll:true},
        approveAll,work,queue};
    },
    // Claude cannot be interrupted from outside; Pause works through its hooks.
    async control(goalId,input) {await setClaudePause(connection,input.action==='stop');},
    async controlActivity(goalId,input) {await setClaudePause(connection,input.action==='stop');},
    async setApproveAll(on) {await setClaudeApproveAll(connection,on);},
    async saveSettings() {throw Error('This agent\'s settings are changed in its own app.');},
  };
}
