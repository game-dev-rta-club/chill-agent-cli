// Claude Code conversations bound to a Root. Everything Claude-specific that the
// Agent menu and controls need lives behind this adapter.
import {createHash} from 'node:crypto';
import {identifyClaudeCaller} from '../claude-entry.mjs';
import {readClaudeConnectionStatus} from '../claude-status.mjs';
import {readClaudePause,setClaudePause} from '../claude-pause.mjs';
import {readClaudeUsage} from '../claude-usage.mjs';
import {observeClaude,claudeQueue,claudeSnapshot,claudeThink,overlayClaudeExecutions,shownWake} from './claude-run.mjs';
import {commentMarks,goalActivity,runningIn,sendNow} from '../hand-off.mjs';
export const claudeExecutions=overlayClaudeExecutions;
import {selectClaudeWork} from '../claude-work.mjs';
import {hidden,recordHidden} from '../hidden-failure.mjs';
import {readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {dataDirectory} from '../data-directory.mjs';
import {readJson} from '../storage.mjs';
import {recordedWork,observedClaudeWork} from '../claude-agent-work.mjs';
import {claudeSelection} from '../claude-work.mjs';

const claudeToken=connection=>createHash('sha256').update(JSON.stringify(['claude',connection.sessionId,connection.contextId])).digest('hex').slice(0,24);
export function claudeAgent(root) {
  const connection=root.connection;
  if(root.threadId||connection?.harnessId!=='claude-code')return null;
  const token=claudeToken(connection);
  return {
    token,
    name:'Claude Code',
    presence:()=>observeClaude(connection),
    // It continues at its own Stop hook (claude-continuation), so nothing polls it.
    continuation:{live:false},
    async status(goalId) {
      const [line,work,queue,pause,usage]=await Promise.all([
        readClaudeConnectionStatus(connection),
        observeClaude(connection).catch(hidden('claude.presence',{status:'unknown',goalId:null,title:null})),
        claudeQueue(connection).catch(hidden('claude.queue')),readClaudePause(connection),
        readClaudeUsage().catch(hidden('claude.usage',null))]);
      return {agent:{name:'Claude Code',model:line.settings||null,status:{label:line.label,detail:line.detail,at:line.waiterCheckedAt||line.observedAt||null}},
        capabilities:{settings:false,stop:!pause.paused&&work.status==='working',resume:pause.paused},
        usage:usage?.usage??null,usageScope:'Shared across your Claude account',usageAt:usage?.at??null,
        work,queue};
    },
    // Claude cannot be interrupted from outside; Pause works through its hooks.
    async control(goalId,input) {await setClaudePause(connection,input.action==='stop');},
    async activity(goalId) {
      const snapshot=await claudeSnapshot(connection).catch(hidden('claude.activity'));
      const status=snapshot?.linked?goalActivity(snapshot,goalId):null,within=status&&runningIn(snapshot,goalId);
      if(within)return {goalId,status,turnId:null,in:within,capabilities:{stop:false,resume:false},work:null};
      // An ended response that scheduled checks (connection wake) is waiting for the next one, not done.
      const wake=status==='idle'?shownWake(snapshot.record):null;
      // A response that ended with background tasks still running shows what they are.
      const background=status==='running'&&snapshot.work.phase!=='working'?snapshot.work.background:[];
      return status&&{goalId,status,turnId:null,capabilities:{stop:status==='running',resume:status==='paused'},...(wake?{wake}:{}),...(background.length?{background}:{}),work:await claudeThink(snapshot).catch(hidden('claude.think',null))};
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
  // A comment written after Pause resumes the conversation, as Resume does:
  // the watcher wakes it once and hands the comment with the resume notice.
  deliver:async id=>{
    const {root}=await mark(id);
    if((await readClaudePause(root.connection)).paused)await setClaudePause(root.connection,false).catch(hidden('claude.comment-resume'));
    return (await mark(id)).mark;
  },
  sendNow:async id=>{await sendNow((await mark(id)).root.id,Number(id));return (await mark(id)).mark;},
};
// The Goals each Claude conversation's running response works on: those it
// was handed and the one it selected with goal work. Silent or ended work is left out.
export async function claudeLiveWork({directory=dataDirectory()}={}) {
  const base=join(directory,'workspace','connections','claude-code'),live=[];
  const files=await readdir(base).catch(error=>{if(error.code!=='ENOENT')recordHidden('claude.live-work',error);return [];});
  for(const file of files.filter(f=>f.endsWith('.json'))){
    const record=await readJson(join(base,file)).catch(hidden('claude.live-work',null));
    if(record?.version!==1||recordedWork(record).phase!=='working')continue;
    const {work,known}=await observedClaudeWork(record);
    if(known&&work.phase==='working')live.push({token:claudeToken(record),goals:[...work.goals,claudeSelection(record,work)?.goalId].filter(Boolean)});
  }
  return live;
}
// Whether this process runs inside some Claude conversation.
export const claudeCaller=env=>Boolean(env.CLAUDE_CODE_SESSION_ID);
export const claudeDeliveries={carrier:state=>state.connection?.harnessId==='claude-code'?claudeCarrier:null};
