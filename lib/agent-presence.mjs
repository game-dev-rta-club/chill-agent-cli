import {readGoalContext,listGoals} from './goal-store.mjs';
import {readExecution} from './goal-execution.mjs';
import {readFeedbackHold} from './feedback-hold.mjs';
import {displayPresence,observeAgentRun} from './agent-observation.mjs';
import {dataDirectory} from './data-directory.mjs';
import {claudeEntryPaths} from './claude-entry.mjs';
import {claudeConnectionStatus} from './claude-status.mjs';
import {claudeRunning} from './claude-transcript.mjs';
import {readJson} from './storage.mjs';
export {agentPresence,readPresenceSnapshot} from './agent-observation.mjs';

async function observe(threadId){
 const [activity,selection,goals]=await Promise.all([observeAgentRun(threadId),readExecution(threadId),listGoals()]);
 const holds=(await Promise.all(goals.map(g=>readFeedbackHold(g.id)))).filter(h=>h?.threadId===threadId);
 const status=displayPresence({...activity,selection,holds});
 const selected=status==='working'&&selection&&!selection.stoppedAt&&selection.turnId===activity.turn?.id;
 const target=goals.find(g=>g.id===(selected?selection.goalId:activity.view?.goalId));
 return {status,goalId:target?.id||null,title:target?.title||null,checkedAt:new Date().toISOString()};
}
// A Claude conversation is Running while its transcript shows an open response.
async function observeClaude(connection,{directory=dataDirectory(),now=Date.now}={}){
 const record=await readJson(claudeEntryPaths(directory,connection.sessionId).record).catch(()=>null);
 if(['unknown','context-changed'].includes(claudeConnectionStatus(record,connection,{now}).state))return {connected:false,status:'unlinked'};
 const running=await claudeRunning(record.transcriptPath,{now});
 return {connected:true,status:running==null?'unknown':running?'working':'idle',goalId:null,title:null,checkedAt:new Date(now()).toISOString()};
}
export async function readAgentPresence(goalId,options){
 const {root}=await readGoalContext(goalId);
 if(!root.threadId&&root.connection?.harnessId==='claude-code')return observeClaude(root.connection,options);
 if(!root.threadId)return {connected:false,status:'unlinked'};
 const result=await observe(root.threadId);
 if((await readGoalContext(goalId)).root.threadId!==root.threadId)throw Error('Agent assignment changed.');
 return {connected:true,...result};
}
