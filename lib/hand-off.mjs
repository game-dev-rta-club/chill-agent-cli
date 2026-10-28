// Each Root's hand-off record (agent-rules): the last user comment handed to the
// agent that owns the Root, whether the user pressed Send now, and whether the
// agent's last stop was held. It belongs to the Root, so a conversation that
// takes the Root over receives what its earlier owner was never handed.
//
// Every harness hands comments, holds a stop and shows its comments through the
// functions here, over the Roots it owns; only how it carries them differs.
import {join} from 'node:path';
import {listGoals,readFeedback,workspaceDirectory} from './goal-store.mjs';
import {readJson,withStoreLock,writeJsonAtomically} from './storage.mjs';
import {commentMark,cursorAfter,handing,pendingComments,quietGoals,runningGoals,unanswered} from './agent-rules.mjs';

const location=rootId=>{const base=join(workspaceDirectory(),'hand-off');return {record:join(base,`${rootId}.json`),lock:join(base,'locks',String(rootId))};};

// A Root's Goals and their conversations. `goals` and `events` may be passed in
// when several Roots are read at once.
export async function rootConversation(rootId,{goals,events}={}) {
  goals??=await listGoals({includeArchived:true});
  const byId=new Map(goals.map(g=>[g.id,g]));
  const rootOf=id=>{let goal=byId.get(id);while(goal?.parentId)goal=byId.get(goal.parentId);return goal?.id;};
  const ids=new Set(goals.filter(g=>rootOf(g.id)===rootId).map(g=>g.id));
  events??=await readFeedback();
  return {goals:goals.filter(g=>ids.has(g.id)),events:events.filter(e=>ids.has(e.goalId))};
}
// The Root's Goals in which the user is waiting for a reply, with those comments.
export function awaitingGoals(events) {
  const byGoal=new Map();
  for(const event of events){if(!byGoal.has(event.goalId))byGoal.set(event.goalId,[]);byGoal.get(event.goalId).push(event);}
  return new Map([...byGoal].map(([goalId,list])=>[goalId,unanswered(list)]).filter(([,list])=>list.length));
}
// Goals with a handed comment that still awaits a reply.
export const handedAwaiting=(events,cursor)=>[...awaitingGoals(events)].filter(([,list])=>list.some(e=>e.id<=cursor)).map(([goalId])=>goalId);

// A Root that never had a record counts the comments its agent already
// answered as handed; the ones still awaiting a reply are handed once.
const initial=events=>{
  const waiting=new Set([...awaitingGoals(events).values()].flat().map(e=>e.id));
  return {cursor:events.reduce((max,e)=>e.author==='user'&&!waiting.has(e.id)?Math.max(max,e.id):max,0),sendNow:0,held:false};
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
// Goals moved from one Root into another (`ids`, under `from` until `write`
// moves them). The destination keeps one cursor, so it stops before the first
// comment, in either tree, that its agent was not handed yet: no comment is
// skipped, and one handed before it lies after that comment is handed once more.
export async function moveComments({from,to,ids},write) {
  const goals=await listGoals({includeArchived:true}),events=await readFeedback();
  const source=await rootConversation(from,{goals,events}),target=await rootConversation(to,{goals,events});
  const fromCursor=(await readHandOff(from,source.events)).cursor;
  return withHandOff(to,async state=>{
    const waiting=[...pendingComments(target.events,state.cursor),...pendingComments(source.events.filter(e=>ids.has(e.goalId)),fromCursor)];
    const cursor=waiting.length?Math.min(...waiting.map(e=>e.id))-1:Math.max(state.cursor,fromCursor);
    await write();
    return {...state,cursor};
  },target.events);
}
// Send now: the running work takes the comments up to this one at its next step.
export const sendNow=(rootId,eventId)=>withHandOff(rootId,state=>state.sendNow>=eventId?null:{...state,sendNow:eventId});

// The Roots an agent owns, each with its conversation and hand-off state, read
// once. A poller passes its own cached `readEvents`.
export async function ownedRoots(owns,{readEvents=readFeedback}={}) {
  const goals=await listGoals({includeArchived:true}),events=await readEvents(),roots=[];
  for(const root of goals.filter(g=>!g.parentId&&owns(g))){
    const conversation=await rootConversation(root.id,{goals,events});
    roots.push({root,...conversation,state:await readHandOff(root.id,conversation.events)});
  }
  return {goals,roots};
}

// Hand what the rules say to hand now in every Root. `send(events)` carries
// the comments to the agent; the cursors move only after it returns, so a
// failed send leaves them waiting. The caller holds the agent's own lock, so
// two hand-offs never send the same comments.
// `startedAt` is when the running work started.
export async function handRoots(roots,{working,startedAt=null,paused=false},send=async()=>{}) {
  const handed=roots.map(r=>({r,hand:handing({pending:pendingComments(r.events,r.state.cursor),work:{phase:working?'working':'idle',startedAt},paused,sendNow:r.state.sendNow}).hand}));
  const events=handed.flatMap(h=>h.hand).sort((a,b)=>a.id-b.id);
  if(!events.length)return events;
  await send(events);
  for(const {r,hand} of handed)if(hand.length)await withHandOff(r.root.id,state=>{const cursor=cursorAfter(state.cursor,hand);return {...state,cursor,sendNow:state.sendNow>cursor?state.sendNow:0};},r.events);
  return events;
}
// Whether `handRoots` would hand anything now. Reading changes nothing.
export const wouldHand=(roots,{working,startedAt=null,paused=false})=>roots.some(r=>handing({pending:pendingComments(r.events,r.state.cursor),work:{phase:working?'working':'idle',startedAt},paused,sendNow:r.state.sendNow}).hand.length>0);

// Handed comments whose Goals still await a reply, oldest first.
export const handedAwaitingComments=roots=>roots.flatMap(r=>[...awaitingGoals(r.events).values()].flat().filter(e=>e.id<=r.state.cursor)).sort((a,b)=>a.id-b.id);

// When the agent's work ends: the Goals to hold its stop for (agent-rules
// quietGoals), recording in each Root whether this stop was held.
export async function quietStop(roots,{background=[]}={}) {
  const quiet=[];
  for(const r of roots)await withHandOff(r.root.id,state=>{
    const found=quietGoals({handedAwaiting:handedAwaiting(r.events,state.cursor),background,held:quiet.length>0||state.held});
    quiet.push(...found);
    return Boolean(state.held)===found.length>0?null:{...state,held:found.length>0};
  },r.events);
  return quiet;
}

// Everything shown for one agent: its status, and per Root the cursor, what
// waits and why. `work` is the agent's agent-rules work; `queued` says comments
// it was handed wait in its own app to start.
export function agentView({goals,roots,work,status,linked=true,paused=false,selected=null,queued=false,checkedAt=new Date(Date.now()).toISOString()}) {
  const views=roots.map(r=>{
    const pending=pendingComments(r.events,r.state.cursor);
    const {hand,hold}=handing({pending,work:work??{phase:'ended'},linked,paused,sendNow:r.state.sendNow});
    return {...r,cursor:r.state.cursor,pending,next:new Set(hand.map(e=>e.id)),hold,awaiting:awaitingGoals(r.events)};
  });
  const awaits=id=>views.some(r=>r.awaiting.has(id)),parentOf=id=>goals.find(g=>g.id===id)?.parentId??null;
  const running=linked&&work?runningGoals({status,work,selected,awaits,parentOf}):[];
  return {work,status,linked,goals,roots:views,running,selected,queued,checkedAt};
}
// The Goal the work is most directly about: one no other running Goal descends from.
export const focusGoal=view=>view.running.find(id=>!view.running.some(other=>view.goals.find(g=>g.id===other)?.parentId===id))??null;
// The newest comment of a Goal the agent was handed.
export const handedIn=(view,goalId)=>{for(const r of view.roots){const last=r.events.filter(e=>e.author==='user'&&e.goalId===goalId&&e.id<=r.cursor).at(-1);if(last)return last.id;}return null;};

// The small mark under each of a Goal's comments (agent-rules commentMark).
// A comment the Goal has a reply after shows none.
export function commentMarks(view,goalId) {
  const own=view.roots.find(r=>r.goals.some(g=>g.id===goalId));
  if(!own)return [];
  const waiting=new Set((own.awaiting.get(goalId)??[]).map(e=>e.id));
  // Comments waiting in the agent's app to start are on their way, whatever stopped the last work.
  const status=view.queued&&view.status!=='paused'?'queued':view.status;
  return own.events.filter(e=>e.goalId===goalId&&e.author==='user'&&e.type==='comment'&&!e.deletedAt).map(e=>{
    // A comment the running work takes at its next step is not held.
    const mark=waiting.has(e.id)?commentMark(e,{cursor:own.cursor,hold:own.next.has(e.id)?null:own.hold,status}):null;
    return {eventId:e.id,goalId,mark,...(mark==='saved'&&e.id<=own.state.sendNow?{sendNow:true}:{})};
  });
}
// The agent as one Goal shows it after its conversation: Running while it works
// on the Goal, Paused or Interrupted where it stopped, and otherwise its last
// work where it last worked. null while the agent is about other Goals.
export function goalActivity(view,goalId) {
  const last=view.work?.lastGoal===goalId||view.running.includes(goalId);
  if(view.status==='running')return view.running.includes(goalId)?'running':null;
  if(view.status==='paused')return last||view.roots.some(r=>r.pending.some(e=>e.goalId===goalId))?'paused':null;
  if(view.queued&&view.roots.some(r=>handedAwaiting(r.events,r.cursor).includes(goalId)))return 'queued';
  return last?view.status:null;
}
// A running parent's page points to the Split Goal the work is in, instead of
// showing that work itself: the running Goal under `goalId` nothing else runs under.
export function runningIn(view,goalId) {
  if(view.status!=='running')return null;
  const parentOf=id=>view.goals.find(g=>g.id===id)?.parentId??null;
  const under=id=>{for(let p=parentOf(id);p;p=parentOf(p))if(p===goalId)return true;return false;};
  return view.running.find(id=>under(id)&&!view.running.some(other=>parentOf(other)===id))??null;
}
// Comments not handed yet, as the Agent menu lists its Queue.
export const queueOf=(view,{limit=50,label='Saved reply'}={})=>{
  const waiting=view.roots.flatMap(r=>r.pending);
  return {truncated:waiting.length>limit,items:waiting.slice(0,limit).map(e=>{const g=view.goals.find(g=>g.id===e.goalId);return {goalId:g?.id||null,title:g?.title||label};})};
};
// The Goal list's Running, Paused and Interrupted marks for one agent's Roots.
// Parents show Running through their running Split Goals; a paused or
// interrupted agent marks the Goal it last worked on.
export function executionMarks(view,{threadId=null}={}) {
  const leaves=view.running.filter(id=>!view.running.some(other=>view.goals.find(g=>g.id===other)?.parentId===id));
  // Comments handed to an agent whose app has yet to start on them show it busy there.
  const queued=view.queued?[...new Set(view.roots.flatMap(r=>handedAwaiting(r.events,r.cursor)))]:[];
  const marks=view.status==='running'?leaves.map(id=>[id,'working']):['paused','interrupted'].includes(view.status)&&view.work?.lastGoal?[[view.work.lastGoal,view.status]]:queued.map(id=>[id,'queued']);
  return marks.flatMap(([goalId,status])=>{
    const own=view.roots.find(r=>r.goals.some(g=>g.id===goalId));
    return own?[{goalId,rootId:own.root.id,threadId,turnId:view.work.id,status,activity:{goalId,eventId:handedIn(view,goalId)},checkedAt:view.checkedAt,expiresAt:new Date(Date.parse(view.checkedAt)+15000).toISOString()}]:[];
  });
}
