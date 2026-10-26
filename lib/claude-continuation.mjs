// The end-of-turn check for a Claude conversation, at its verified main Stop.
// What it asks comes from the Autonomy of the conversation's Goals (autonomy
// turnPlan); the per-Root journal keeps only the attempts and their revision.
// The Web scheduler must not infer a live Claude session from these records.
import {randomUUID} from 'node:crypto';
import {storage,listGoals,continuationWorkspace,dataDirectory,connectionPolicyLock as locked} from './extension-api.mjs';
import {pendingComments} from './agent-rules.mjs';
import {awaitingGoals,readHandOff,rootConversation} from './hand-off.mjs';
import {MAX_CHECKS_PER_REVISION,continuationMessage,continuationSummary} from './continuation-monitor.mjs';
import {readTurnPlan} from './autonomy.mjs';
import {agentKey,goalsHeldElsewhere} from './agents/index.mjs';
import {claudeEntryPaths} from './claude-entry.mjs';
import {recordedWork} from './claude-agent-work.mjs';
import {claudeSelection} from './claude-work.mjs';
import {readJson} from './storage.mjs';
const journal=storage('continuation');
const same=(a,b)=>a?.harnessId==='claude-code'&&a.harnessId===b?.harnessId&&a.sessionId===b?.sessionId&&a.contextId===b?.contextId;
// The journal belongs to the Root's current conversation. When a continued
// conversation takes the Root over, a request the earlier one never confirmed
// is closed, never resent. The owner is part of the revision, so the new
// conversation gets its own single check. A record of any other owner starts over.
// Call while holding the current connection's policy lock.
async function current(root){
 const state=await journal.read(root.id);
 if(state&&same(state.connection,root.connection))return state;
 const at=new Date().toISOString();
 const closed=(state?.attempts||[]).map(a=>a.completedAt?a:{...a,phase:'assignment-changed',completedAt:at});
 if(!state)return null;
 const adopted=(root.previousConnections||[]).some(previous=>same(previous,state.connection));
 const next=adopted?{...state,connection:root.connection,attempts:closed,status:closed.some(a=>a.completedAt===at)?'assignment-changed':state.status,updatedAt:at}
  :{rootId:root.id,connection:root.connection,history:[...(state.history||[]),...closed],attempts:[],updatedAt:at};
 await journal.write(root.id,next);return next;
}
async function snapshot(rootId,connection){
 const facts=await continuationWorkspace(rootId);
 if(!same(facts.root.connection,connection)||facts.root.threadId)throw Error('Assignment changed.');
 // Any owned Root may hold input for this conversation, not just the Root
 // selected for this check. Only comments not handed yet wait. Handed comments whose Goal still awaits a reply are
 // work to continue, so the request names them instead of holding back.
 let pending=false;const unfinished=[];
 for(const root of facts.goals.filter(g=>!g.parentId&&same(g.connection,connection))){
  const {events}=await rootConversation(root.id,{goals:facts.goals,events:facts.allEvents});
  const {cursor}=await readHandOff(root.id,events);
  pending||=pendingComments(events,cursor).length>0;
  for(const list of awaitingGoals(events).values())unfinished.push(...list.filter(e=>e.id<=cursor).map(e=>({eventId:e.id,goalId:e.goalId})));
 }
 // A Claude conversation can schedule its own wake-up.
 return {rootId,wake:true,rootTitle:facts.root.title,revision:facts.revision,context:facts.context,
  pending,unfinished,progress:facts.progress};
}
// The conversation's recorded Goals: those its current work was handed, the
// last it worked in, and the one it selected with goal work.
export async function claudeRecentGoals(connection,{directory=dataDirectory()}={}){
 const record=await readJson(claudeEntryPaths(directory,connection.sessionId).record);
 if(record?.version!==1||record.contextId!==connection.contextId)return [];
 const work=recordedWork(record);
 return [...work.goals,work.lastGoal,claudeSelection(record,work)?.goalId];
}
export const claudeTurnPlan=async connection=>readTurnPlan({owns:g=>!g.threadId&&same(g.connection,connection),recent:await claudeRecentGoals(connection),held:async()=>goalsHeldElsewhere(agentKey({connection}))});
export async function onStop({connection,checkpointId,generation}) {
 return locked(connection,async()=>{
  const roots=(await listGoals()).filter(g=>!g.parentId&&!g.threadId&&same(g.connection,connection));
  // A request goes out as Stop output, so the next Stop means the response that
  // received it has ended. chill records the result itself: worked when the
  // agent left something on the Web.
  for(const root of roots){
   const state=await current(root);if(!state)continue;
   const last=state.attempts.at(-1);
   if(last&&!last.completedAt){
    const at=new Date().toISOString();
    if(!last.result&&last.progress)last.result={outcome:(await snapshot(root.id,connection)).progress!==last.progress?'worked':'no-work',at,observed:true};
    last.completedAt=at;last.phase=last.result?'completed':'ended';await journal.write(root.id,state);
   }
  }
  // One message for the conversation, from the Root of its highest-level Goal.
  const plan=await claudeTurnPlan(connection);
  const root=plan&&roots.find(r=>r.id===plan.rootId);
  if(!root)return null;
  const state=await current(root)??{rootId:root.id,connection,attempts:[]};
  const facts=await snapshot(root.id,connection);
  if(facts.pending){state.status='feedback-pending';await journal.write(root.id,state);return null;}
  if(plan.revision!==state.revision){state.history=[...(state.history||[]),...state.attempts];state.attempts=[];state.revision=plan.revision;}
  if(state.attempts.length>=MAX_CHECKS_PER_REVISION){state.status='exhausted';await journal.write(root.id,state);return null;}
  // Re-read saved facts immediately before reserving. Hook execution holds the
  // native entry lock, so a new prompt/generation cannot reuse this checkpoint.
  const fresh=await snapshot(root.id,connection),again=await claudeTurnPlan(connection);
  if(fresh.pending||fresh.revision!==facts.revision||again?.revision!==plan.revision||again.rootId!==plan.rootId)return null;
  const attempt={id:randomUUID(),at:new Date().toISOString(),phase:'uncertain',checkpointId,generation,level:again.level,
   goalId:again.goalId,goalTitle:again.goalTitle,progress:fresh.progress};
  attempt.message=continuationMessage({...fresh,autonomy:again});attempt.summary=continuationSummary(fresh);
  state.attempts.push(attempt);state.status='awaiting-run';state.checkedAt=new Date().toISOString();
  await journal.write(root.id,state); // Persist before native Stop output; never resend automatically.
  return attempt.message;
 });
}
