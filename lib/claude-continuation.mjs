// The end-of-turn check for a Claude conversation, at its verified main Stop.
// What it asks comes from the Autonomy of the Roots the conversation owns
// (autonomy turnPlan); the conversation's check record (turn-checks) keeps the
// attempts and their revision.
// The Web scheduler must not infer a live Claude session from these records.
import {listGoals,connectionPolicyLock as locked} from './extension-api.mjs';
import {ownedWorkspace} from './continuation-workspace.mjs';
import {pendingComments} from './agent-rules.mjs';
import {awaitingGoals,readHandOff,rootConversation} from './hand-off.mjs';
import {checksLeft,reserve,settle,startRevision} from './continuation-monitor.mjs';
import {readTurnPlan} from './autonomy.mjs';
import {agentKey,goalsHeldElsewhere} from './agents/index.mjs';
import {readTurnCheck,writeTurnCheck} from './turn-checks.mjs';
import {claudeOwner} from './agents/owners.mjs';
import {ownsRoot} from './owner.mjs';
// What the check knows of the conversation, over every Root it owns
// (ownedWorkspace).
async function snapshot(connection){
 const facts=await ownedWorkspace(claudeOwner(connection));
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
 return {wake:true,revision:facts.revision,context:facts.context,pending,unfinished,progress:facts.progress};
}
export const claudeTurnPlan=connection=>readTurnPlan({owner:claudeOwner(connection),held:async()=>goalsHeldElsewhere(agentKey({owner:claudeOwner(connection)}))});
export async function onStop({connection,checkpointId,generation}) {
 return locked(connection,async()=>{
  const owner=claudeOwner(connection);
  const state=await readTurnCheck(owner,{roots:(await listGoals()).filter(ownsRoot(owner))});
  const save=()=>writeTurnCheck(owner,state);
  // A request goes out as Stop output, so the next Stop means the response that
  // received it has ended. chill records the result itself: worked when the
  // agent left something on the Web.
  const last=state.attempts.at(-1);
  if(last&&!last.completedAt){settle(last,{progress:(await snapshot(connection)).progress,at:new Date().toISOString()});await save();}
  // One message for the conversation, from its Root at the highest level.
  const plan=await claudeTurnPlan(connection);
  if(!plan)return null;
  const facts=await snapshot(connection);
  if(facts.pending){state.status='feedback-pending';await save();return null;}
  startRevision(state,plan.revision);
  if(!checksLeft(state)){state.status='exhausted';await save();return null;}
  // Re-read saved facts immediately before reserving. Hook execution holds the
  // native entry lock, so a new prompt/generation cannot reuse this checkpoint.
  const fresh=await snapshot(connection),again=await claudeTurnPlan(connection);
  if(fresh.pending||fresh.revision!==facts.revision||again?.revision!==plan.revision)return null;
  const attempt=reserve(state,{plan:again,facts:fresh,at:new Date().toISOString(),phase:'uncertain',checkpointId,generation});
  state.status='awaiting-run';state.checkedAt=new Date().toISOString();
  await save(); // Persist before native Stop output; never resend automatically.
  return attempt.message;
 });
}
