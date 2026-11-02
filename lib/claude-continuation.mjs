// The end-of-turn check for a Claude conversation, at its verified main Stop.
// What it asks comes from the Autonomy of the Roots the conversation owns
// (autonomy turnPlan); each Root's journal keeps that level, the attempts and
// their revision.
// The Web scheduler must not infer a live Claude session from these records.
import {storage,listGoals,connectionPolicyLock as locked} from './extension-api.mjs';
import {ownedWorkspace} from './continuation-workspace.mjs';
import {pendingComments} from './agent-rules.mjs';
import {awaitingGoals,readHandOff,rootConversation} from './hand-off.mjs';
import {checksLeft,journalFor,reserve,settle,startRevision} from './continuation-monitor.mjs';
import {readTurnPlan} from './autonomy.mjs';
import {agentKey,goalsHeldElsewhere} from './agents/index.mjs';
import {journalOwnership} from './continuation-owner.mjs';
import {claudeOwner} from './agents/owners.mjs';
import {ownsRoot} from './owner.mjs';
const journal=storage('continuation');
// The journal belongs to the Root's current conversation (continuation-monitor
// journalFor). Call while holding the current connection's policy lock.
async function current(root){
 const state=await journal.read(root.id),ownership=journalOwnership(root,state);
 const next=journalFor(state,root.owner,ownership,new Date().toISOString());
 if(next&&next!==state)await journal.write(root.id,next);
 return next;
}
// What the check knows of the conversation, over every Root it owns
// (ownedWorkspace). `rootId` is the Root whose journal keeps the check.
async function snapshot(rootId,connection){
 const facts=await ownedWorkspace(claudeOwner(connection));
 if(!facts.roots.some(root=>root.id===rootId))throw Error('Assignment changed.');
 // Only comments not handed yet wait. Handed comments whose Goal still awaits
 // a reply are work to continue, so the request names them instead of holding back.
 let pending=false;const unfinished=[];
 for(const root of facts.roots){
  const {events}=await rootConversation(root.id,{goals:facts.goals,events:facts.allEvents});
  const {cursor}=await readHandOff(root.id,events);
  pending||=pendingComments(events,cursor).length>0;
  for(const list of awaitingGoals(events).values())unfinished.push(...list.filter(e=>e.id<=cursor).map(e=>({eventId:e.id,goalId:e.goalId})));
 }
 // A Claude conversation can schedule its own wake-up.
 return {rootId,wake:true,revision:facts.revision,context:facts.context,pending,unfinished,progress:facts.progress};
}
export const claudeTurnPlan=connection=>readTurnPlan({owner:claudeOwner(connection),held:async()=>goalsHeldElsewhere(agentKey({owner:claudeOwner(connection)}))});
export async function onStop({connection,checkpointId,generation}) {
 return locked(connection,async()=>{
  const roots=(await listGoals()).filter(ownsRoot(claudeOwner(connection)));
  // A request goes out as Stop output, so the next Stop means the response that
  // received it has ended. chill records the result itself: worked when the
  // agent left something on the Web.
  for(const root of roots){
   const state=await current(root);if(!state)continue;
   const last=state.attempts.at(-1);
   if(last&&!last.completedAt){settle(last,{progress:(await snapshot(root.id,connection)).progress,at:new Date().toISOString()});await journal.write(root.id,state);}
  }
  // One message for the conversation, from its Root at the highest level.
  const plan=await claudeTurnPlan(connection);
  const root=plan&&roots.find(r=>r.id===plan.rootId);
  if(!root)return null;
  const state=await current(root)??{rootId:root.id,owner:claudeOwner(connection),attempts:[]};
  const facts=await snapshot(root.id,connection);
  if(facts.pending){state.status='feedback-pending';await journal.write(root.id,state);return null;}
  startRevision(state,plan.revision);
  if(!checksLeft(state)){state.status='exhausted';await journal.write(root.id,state);return null;}
  // Re-read saved facts immediately before reserving. Hook execution holds the
  // native entry lock, so a new prompt/generation cannot reuse this checkpoint.
  const fresh=await snapshot(root.id,connection),again=await claudeTurnPlan(connection);
  if(fresh.pending||fresh.revision!==facts.revision||again?.revision!==plan.revision||again.rootId!==plan.rootId)return null;
  const attempt=reserve(state,{plan:again,facts:fresh,at:new Date().toISOString(),phase:'uncertain',checkpointId,generation});
  state.status='awaiting-run';state.checkedAt=new Date().toISOString();
  await journal.write(root.id,state); // Persist before native Stop output; never resend automatically.
  return attempt.message;
 });
}
