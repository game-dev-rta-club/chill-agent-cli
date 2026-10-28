// What a Claude conversation is doing and which of its Goals that work is for,
// by the shared rules (agent-rules) over its own hooks' record and the Roots'
// hand-off records. Nothing here reads which comment the agent mentioned.
import {dataDirectory} from '../data-directory.mjs';
import {claudeEntryPaths} from '../claude-entry.mjs';
import {claudeConnectionStatus} from '../claude-status.mjs';
import {claudeSelection} from '../claude-work.mjs';
import {observedClaudeWork} from '../claude-agent-work.mjs';
import {agentStatus} from '../agent-rules.mjs';
import {agentView,executionMarks,focusGoal,handedIn,ownedRoots,queueOf} from '../hand-off.mjs';
import {readJson} from '../storage.mjs';
import {hidden} from '../hidden-failure.mjs';
import {nextWake,pendingWakes} from '../claude-wake.mjs';

const same=(a,b)=>a?.harnessId===b?.harnessId&&a?.sessionId===b?.sessionId&&a?.contextId===b?.contextId;
// Everything shown for one conversation, read once: its work, status, Roots,
// and per Root the cursor, what waits and why.
export async function claudeSnapshot(connection,{directory=dataDirectory(),now=Date.now}={}){
 const record=await readJson(claudeEntryPaths(directory,connection.sessionId).record).catch(hidden('claude-run.record'));
 const linked=!['unknown','context-changed'].includes(claudeConnectionStatus(record,connection,{now}).state);
 const {work,known}=linked?await observedClaudeWork(record,{now}):{work:null,known:false};
 const status=linked?agentStatus({paused:Boolean(record.pause),known,work}):'unlinked';
 const {goals,roots}=await ownedRoots(g=>!g.threadId&&same(g.connection,connection));
 const selected=linked?claudeSelection(record,work)?.goalId??null:null;
 return {record,...agentView({goals,roots,work,status,linked,paused:status==='paused',selected,checkedAt:new Date(now()).toISOString()})};
}
export {handedIn};
// The next check the Web shows while the conversation waits for it.
export const shownWake=record=>{const wake=nextWake(record);return wake&&{at:wake.at,reason:wake.reason||''};};
// What a conversation whose own work ended waits on: the checks it scheduled and
// the background tasks (subagents) it left running.
export function shownWaits(snapshot){
 const ended=snapshot.status==='idle'||snapshot.status==='running'&&snapshot.work.phase!=='working';
 if(!ended)return {};
 const background=snapshot.status==='running'?snapshot.work.background:[],wakes=pendingWakes(snapshot.record);
 return {...(wakes.length?{wake:wakes[0],wakes}:{}),...(background.length?{background}:{})};
}

export async function observeClaude(connection,options){
 const snapshot=await claudeSnapshot(connection,options);
 if(!snapshot.linked)return {connected:false,status:'unlinked'};
 const shown=snapshot.status==='running'?'working':snapshot.status;
 const goalId=focusGoal(snapshot),goal=snapshot.goals.find(g=>g.id===goalId),lastGoal=snapshot.goals.find(g=>g.id===snapshot.work.lastGoal);
 return {connected:true,status:shown,goalId:goal?.id||null,title:goal?.title||null,eventId:goal?handedIn(snapshot,goal.id):null,turnId:snapshot.status==='running'?snapshot.work.id:null,
  last:lastGoal?{goalId:lastGoal.id,title:lastGoal.title,eventId:handedIn(snapshot,lastGoal.id)}:null,running:snapshot.running,checkedAt:snapshot.checkedAt,
  // An ended response waits for the checks it scheduled and the subagents it left running.
  ...shownWaits(snapshot)};
}
// Comments not handed to this conversation yet, in the same shape as Codex's
// native queue, so the Agent menu reads one Queue.
export const claudeQueue=async(connection,options)=>queueOf(await claudeSnapshot(connection),options);

// Mark the Goals a Claude Root is working on, so the Goal list shows Running
// for either harness.
export async function overlayClaudeExecutions(goals,executions,options){
 for(const root of goals.filter(g=>!g.parentId&&!g.threadId&&g.connection?.harnessId==='claude-code')){
  const snapshot=await claudeSnapshot(root.connection,options).catch(hidden('claude-run.overlay'));
  if(!snapshot?.linked)continue;
  for(const mark of executionMarks(snapshot))if(!executions.has(mark.goalId))executions.set(mark.goalId,mark);
 }
 return executions;
}

// The public text of the conversation's current or last work: Think.
export async function claudeThink(snapshot){
 const {work,record}=snapshot;
 if(!work?.startedAt)return null;
 const {claudeMessagesSince}=await import('../claude-transcript.mjs');
 const output=await claudeMessagesSince(record?.transcriptPath,work.startedAt);
 return output&&{live:snapshot.status==='running',settings:output.settings,startedAt:work.startedAt,messages:output.messages};
}
