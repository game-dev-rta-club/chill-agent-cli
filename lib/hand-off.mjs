// Each Root's hand-off record (agent-rules): the last user comment handed to the
// agent that owns the Root, whether the user pressed Send now, and whether the
// agent's last stop was held. It belongs to the Root, so a conversation that
// takes the Root over receives what its earlier owner was never handed.
import {join} from 'node:path';
import {listGoals,readFeedback,workspaceDirectory} from './goal-store.mjs';
import {readJson,withStoreLock,writeJsonAtomically} from './storage.mjs';
import {unanswered} from './agent-rules.mjs';
import {feedbackHeld,readFeedbackHold} from './feedback-hold.mjs';

const location=rootId=>{const base=join(workspaceDirectory(),'hand-off');return {record:join(base,`${rootId}.json`),lock:join(base,'locks',String(rootId))};};

// A Root's Goals and their conversations. `goals` and `events` may be passed in
// when several Roots are read at once.
export async function rootConversation(rootId,{goals,events}={}) {
  goals??=await listGoals({includeArchived:true});
  const byId=new Map(goals.map(g=>[g.id,g]));
  const rootOf=id=>{let goal=byId.get(id);while(goal?.parentId)goal=byId.get(goal.parentId);return goal?.id;};
  const ids=new Set(goals.filter(g=>rootOf(g.id)===rootId).map(g=>g.id));
  events??=await readFeedback();
  return {goals:goals.filter(g=>ids.has(g.id)),events:events.filter(e=>ids.has(e.goalId)),parentOf:id=>byId.get(id)?.parentId??null};
}
// The Root's Goals in which the user is waiting for a reply, with those comments.
export function awaitingGoals(events) {
  const byGoal=new Map();
  for(const event of events)if(!byGoal.has(event.goalId))byGoal.set(event.goalId,[]);
  for(const event of events)byGoal.get(event.goalId).push(event);
  return new Map([...byGoal].map(([goalId,list])=>[goalId,unanswered(list)]).filter(([,list])=>list.length));
}
// Goals with a handed comment that still awaits a reply.
export const handedAwaiting=(events,cursor)=>[...awaitingGoals(events)].filter(([,list])=>list.some(e=>e.id<=cursor)).map(([goalId])=>goalId);

// A Root that never had a record counts the comments its agent already
// answered as handed; the ones still awaiting a reply are handed once.
const initial=events=>{
  const waiting=new Set([...awaitingGoals(events).values()].flat().map(e=>e.id));
  return {cursor:events.reduce((max,e)=>e.author==='user'&&!waiting.has(e.id)?Math.max(max,e.id):max,0),sendNow:false,held:false};
};
export async function readHandOff(rootId,events) {
  return await readJson(location(rootId).record)??initial(events??(await rootConversation(rootId)).events);
}
// `change(state)` returns the next state, or null to keep it.
export async function withHandOff(rootId,change,events) {
  const where=location(rootId);
  return withStoreLock(where.lock,async()=>{
    const state=await readJson(where.record)??initial(events??(await rootConversation(rootId)).events);
    const next=await change(state);
    if(next)await writeJsonAtomically(where.record,next);
    return next??state;
  });
}
export const sendNow=rootId=>withHandOff(rootId,state=>state.sendNow?null:{...state,sendNow:true});
// A Codex pause holds the comments of a Goal path; nothing under it is handed.
export async function rootHeld(goals) {
  for(const goal of goals)if(feedbackHeld(await readFeedbackHold(goal.id)))return true;
  return false;
}
