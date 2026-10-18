// What a Claude conversation is doing and which of its Goals that work is for,
// by the shared rules (agent-rules) over its own hooks' record and the Roots'
// hand-off records. Nothing here reads which comment the agent mentioned.
import {listGoals,readFeedback} from '../goal-store.mjs';
import {dataDirectory} from '../data-directory.mjs';
import {claudeEntryPaths} from '../claude-entry.mjs';
import {claudeConnectionStatus} from '../claude-status.mjs';
import {claudeSelection} from '../claude-work.mjs';
import {observedClaudeWork} from '../claude-agent-work.mjs';
import {agentStatus,handing,pendingComments,runningGoals} from '../agent-rules.mjs';
import {awaitingGoals,readHandOff,rootConversation,rootHeld} from '../hand-off.mjs';
import {readJson} from '../storage.mjs';
import {hidden} from '../hidden-failure.mjs';

const same=(a,b)=>a?.harnessId===b?.harnessId&&a?.sessionId===b?.sessionId&&a?.contextId===b?.contextId;
// Everything shown for one conversation, read once: its work, status, Roots,
// and per Root the cursor, what waits and why.
export async function claudeSnapshot(connection,{directory=dataDirectory(),now=Date.now}={}){
 const record=await readJson(claudeEntryPaths(directory,connection.sessionId).record).catch(hidden('claude-run.record'));
 const linked=!['unknown','context-changed'].includes(claudeConnectionStatus(record,connection,{now}).state);
 const {work,known}=linked?await observedClaudeWork(record,{now}):{work:null,known:false};
 const status=linked?agentStatus({paused:Boolean(record.pause),known,work}):'unlinked';
 const goals=await listGoals({includeArchived:true}),events=await readFeedback(),roots=[];
 for(const root of goals.filter(g=>!g.parentId&&!g.threadId&&same(g.connection,connection))){
  const conversation=await rootConversation(root.id,{goals,events});
  const handOff=await readHandOff(root.id,conversation.events);
  const pending=pendingComments(conversation.events,handOff.cursor);
  const {hold}=handing({pending,work:work??{phase:'ended'},linked,paused:status==='paused'||await rootHeld(conversation.goals),sendNow:handOff.sendNow});
  roots.push({root,...conversation,cursor:handOff.cursor,pending,hold,awaiting:awaitingGoals(conversation.events)});
 }
 const awaits=id=>roots.some(r=>r.awaiting.has(id)),parentOf=id=>goals.find(g=>g.id===id)?.parentId??null;
 const selected=linked?claudeSelection(record,work)?.goalId??null:null;
 const running=linked?runningGoals({status,work,selected,awaits,parentOf}):[];
 return {record,linked,work,status,goals,roots,running,selected,checkedAt:new Date(now()).toISOString()};
}
// The Goal the work is most directly about: one no other running Goal descends from.
const focus=snapshot=>snapshot.running.find(id=>!snapshot.running.some(other=>snapshot.goals.find(g=>g.id===other)?.parentId===id))??null;
// The newest comment of a Goal the conversation was handed.
export const handedIn=(snapshot,goalId)=>{for(const r of snapshot.roots){const last=r.events.filter(e=>e.author==='user'&&e.goalId===goalId&&e.id<=r.cursor).at(-1);if(last)return last.id;}return null;};

export async function observeClaude(connection,options){
 const snapshot=await claudeSnapshot(connection,options);
 if(!snapshot.linked)return {connected:false,status:'unlinked'};
 const shown={running:'working',interrupted:'idle'}[snapshot.status]??snapshot.status;
 const goalId=focus(snapshot),goal=snapshot.goals.find(g=>g.id===goalId),lastGoal=snapshot.goals.find(g=>g.id===snapshot.work.lastGoal);
 return {connected:true,status:shown,goalId:goal?.id||null,title:goal?.title||null,eventId:goal?handedIn(snapshot,goal.id):null,turnId:snapshot.status==='running'?snapshot.work.id:null,
  last:lastGoal?{goalId:lastGoal.id,title:lastGoal.title,eventId:handedIn(snapshot,lastGoal.id)}:null,running:snapshot.running,checkedAt:snapshot.checkedAt};
}
// Comments not handed to this conversation yet, in the same shape as Codex's
// native queue, so the Agent menu reads one Queue.
export async function claudeQueue(connection,{limit=50}={}){
 const snapshot=await claudeSnapshot(connection);
 const waiting=snapshot.roots.flatMap(r=>r.pending);
 return {truncated:waiting.length>limit,items:waiting.slice(0,limit).map(e=>{const g=snapshot.goals.find(g=>g.id===e.goalId);return {goalId:g?.id||null,title:g?.title||'Saved reply'};})};
}

// Mark the Goals a Claude Root is working on, as Codex selection does, so the
// Goal list shows Running for either harness. A paused conversation marks the
// Goal it last worked on, as a Codex pause does.
export async function overlayClaudeExecutions(goals,executions,options){
 for(const root of goals.filter(g=>!g.parentId&&!g.threadId&&g.connection?.harnessId==='claude-code')){
  const snapshot=await claudeSnapshot(root.connection,options).catch(hidden('claude-run.overlay'));
  if(!snapshot?.linked)continue;
  // Parents show Running through their running Split Goals.
  const leaves=snapshot.running.filter(id=>!snapshot.running.some(other=>snapshot.goals.find(g=>g.id===other)?.parentId===id));
  const marks=snapshot.status==='running'?leaves.map(id=>[id,'working']):snapshot.status==='paused'&&snapshot.work.lastGoal?[[snapshot.work.lastGoal,'paused']]:[];
  for(const [goalId,status] of marks){
   if(executions.has(goalId)||!snapshot.roots.some(r=>r.goals.some(g=>g.id===goalId)))continue;
   executions.set(goalId,{goalId,rootId:root.id,threadId:null,turnId:snapshot.work.id,status,
    activity:{goalId,eventId:handedIn(snapshot,goalId)},checkedAt:snapshot.checkedAt,expiresAt:new Date(Date.parse(snapshot.checkedAt)+15000).toISOString()});
  }
 }
 return executions;
}

// The Web's per-comment view for Claude Roots, decided by the shared rules: a
// comment whose Goal has a reply after it is Done; one awaiting a reply shows
// where it is (agent-rules commentMark), Running while the work it was handed to
// runs. Think is the work's own public text, shown once on the newest comment
// the work was handed. Other deliveries pass through unchanged.
export async function claudeCommentStates(deliveries,{now=Date.now}={}){
 const snapshots=new Map();
 const snapshotFor=connection=>{const key=JSON.stringify([connection.sessionId,connection.contextId]);if(!snapshots.has(key))snapshots.set(key,claudeSnapshot(connection,{now}).catch(hidden('claude-run.comments')));return snapshots.get(key);};
 const {readGoalContext}=await import('../goal-store.mjs');
 return Promise.all(deliveries.map(async delivery=>{
  const {root}=await readGoalContext(delivery.goalId).catch(()=>({root:null}));
  if(root?.threadId||root?.connection?.harnessId!=='claude-code')return delivery;
  const snapshot=await snapshotFor(root.connection);
  const own=snapshot?.roots.find(r=>r.root.id===root.id);
  if(!own)return delivery;
  const view={eventId:delivery.eventId,goalId:delivery.goalId,threadId:null,connection:root.connection,updatedAt:delivery.updatedAt,history:delivery.history??[]};
  const waiting=own.awaiting.get(delivery.goalId)?.some(e=>e.id===delivery.eventId);
  if(!waiting)return {...view,status:'completed'};
  if(delivery.eventId>own.cursor)return {...view,status:own.hold==='unlinked'?'unlinked':own.hold??'saved',...(own.hold==='waiting'?{waitForIdle:true}:{}),...(delivery.sendNow?{sendNow:true}:{})};
  const working=snapshot.status==='running'&&snapshot.running.includes(delivery.goalId);
  const think=await thinkFor(snapshot,delivery);
  return {...view,status:working?'working':'received',...(think?{work:think}:{})};
 }));
}
async function thinkFor(snapshot,delivery){
 const {work,record}=snapshot;
 if(!work?.startedAt||handedIn(snapshot,delivery.goalId)!==delivery.eventId||!(work.goals.includes(delivery.goalId)||work.lastGoal===delivery.goalId))return null;
 const {claudeMessagesSince}=await import('../claude-transcript.mjs');
 const output=await claudeMessagesSince(record?.transcriptPath,work.startedAt);
 if(!output)return null;
 const running=snapshot.status==='running';
 return {source:'turn',turnId:`claude:${work.id}`,status:running?'working':'completed',background:work.background,settings:output.settings,
  startedAt:work.startedAt,endedAt:null,messages:output.messages,truncated:false};
}
