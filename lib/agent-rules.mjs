// The rules for what an agent is doing, whether the user is waiting for a reply,
// and when to hand comments to the agent. They are written once for every
// harness: a harness only reports what happened (`nextWork`) and carries out
// what these rules decide. Nothing here reads files, transcripts or agent output.

// What an agent is doing, kept per conversation:
//   phase       'idle' | 'working' | 'interrupted' | 'ended'
//   background  its background tasks still running: {id,type,name,description,since,activeAt}
// Which Goals it is about is not kept here: focusGoals reads it from the Roots'
// comments every time, the same for every harness.
export const idleWork=Object.freeze({phase:'idle',background:[]});

// What a harness reports:
//   {type:'started'}            the agent began working: a prompt, a wake, a continued stop
//   {type:'background',tasks,at} its background tasks still running, as listed when its response stopped
//   {type:'subagent',task,at}    a subagent started or used a tool
//   {type:'subagent-stopped',id} a subagent ended
//   {type:'finished'}           its work ended and nothing continued it
//   {type:'interrupted'}        its work was stopped from its own side: Esc, a Desktop stop, an API error
//   {type:'ended'}              the conversation ended
const activeEveryMs=60*1000;
export function nextWork(work,event) {
  switch(event.type){
    case 'started':return {...work,phase:'working'};
    case 'background':{
      const known=new Map(work.background.map(t=>[t.id,t]));
      return {...work,background:event.tasks.map(t=>({...t,since:known.get(t.id)?.since??event.at,activeAt:known.get(t.id)?.activeAt??null}))};
    }
    case 'subagent':{
      const known=work.background.find(t=>t.id===event.task.id);
      if(!known)return {...work,background:[...work.background,{...event.task,since:event.at,activeAt:event.at}]};
      // A busy subagent reports every tool; its activity is kept once a minute.
      if(Date.parse(event.at)-Date.parse(known.activeAt)<activeEveryMs)return work;
      return {...work,background:work.background.map(t=>t===known?{...t,activeAt:event.at}:t)};
    }
    case 'subagent-stopped':return {...work,background:work.background.filter(t=>t.id!==event.id)};
    case 'finished':return {...work,phase:'idle'};
    case 'interrupted':return {...work,phase:'interrupted'};
    case 'ended':return {...work,phase:'ended',background:[]};
  }
  throw new Error(`Unknown agent work event: ${event.type}`);
}

// The one status shown for an agent. A harness that cannot be read is unknown,
// never idle. Background tasks keep the agent Running after its own work ends.
export function agentStatus({linked=true,known=true,paused=false,work}) {
  if(!linked||work.phase==='ended')return 'unlinked';
  if(paused)return 'paused';
  if(!known)return 'unknown';
  if(work.phase==='working'||work.background.length>0)return 'running';
  return work.phase==='interrupted'?'interrupted':'idle';
}

// A Goal waits for a reply while the user spoke last in it. Which of the user's
// comments a reply answers is not tracked.
//   events  the Goal's conversation: {id,author,type,deletedAt}
export function unanswered(events) {
  const lastReply=events.reduce((last,e)=>e.author==='agent'&&!e.deletedAt?Math.max(last,e.id):last,0);
  return events.filter(e=>e.author==='user'&&e.type==='comment'&&!e.deletedAt&&e.id>lastReply);
}
export const awaitsReply=events=>unanswered(events).length>0;

// Each Root keeps one cursor: the last comment handed to its agent. A comment
// after it has not been handed yet. The cursor stays with the Root when another
// conversation takes it over.
export const pendingComments=(events,cursor)=>events.filter(e=>e.author==='user'&&e.type==='comment'&&!e.deletedAt&&e.id>cursor).sort((a,b)=>a.id-b.id);

// What to do now with the comments not handed yet. Comments saved while the
// agent's own work runs wait for its end; background tasks alone do not make
// them wait. The running work takes at its next step the comments saved before
// it started (they woke it) and those up to one the user sent now (`sendNow`,
// a comment ID). Only a leading run is handed, so the cursor only moves forward.
// Returns the comments to hand now and why the rest are held.
export function handing({pending,work,linked=true,paused=false,sendNow=0}) {
  if(!pending.length)return {hand:[],hold:null};
  if(!linked||work.phase==='ended')return {hand:[],hold:'unlinked'};
  if(paused)return {hand:[],hold:'paused'};
  if(work.phase!=='working')return {hand:pending,hold:null};
  const started=Date.parse(work.startedAt),now=e=>e.id<=sendNow||Date.parse(e.updatedAt)<started;
  const rest=pending.findIndex(e=>!now(e)),hand=rest===-1?pending:pending.slice(0,rest);
  return {hand,hold:hand.length<pending.length?'waiting':null};
}
export const cursorAfter=(cursor,handed)=>handed.reduce((max,e)=>Math.max(max,e.id),cursor);

// The small mark under a comment that still awaits a reply: where it is now.
// A handed comment shows the agent's Paused or Interrupted, like the agent does.
//   hold    the Root's current `handing(...).hold`
//   status  the agent's `agentStatus`
export function commentMark(comment,{cursor,hold,status}) {
  if(comment.id<=cursor)return ['paused','interrupted'].includes(status)?status:'handed';
  return hold==='unlinked'||!hold?'saved':hold;
}

// The Goals an agent is about, newest first: those it owes a reply in, the one
// it selected, and the one it last wrote in while nothing else is newer. Each
// item is {goalId,at}, `at` an ISO time:
//   owed      Goals with a handed comment still awaiting a reply, `at` its newest one
//   selected  the Goal it chose with goal work, `at` when, or null
//   written   the Goal of its newest Comment or Letter, or null
// Running, Paused and every place that names one Goal read this; one Goal is
// the first.
export function focusGoals({owed=[],selected=null,written=null}) {
  const items=[...owed,...(selected?[selected]:[])],time=item=>Date.parse(item.at);
  if(written&&items.every(item=>time(item)<=time(written)))items.push(written);
  return [...new Set(items.sort((a,b)=>time(b)-time(a)).map(item=>item.goalId))];
}
// Goals shown Running: while the agent runs, its focus and their parents.
//   parentOf(goalId)  its parent's ID, or null for a Root
export function runningGoals({status,focus,parentOf}) {
  if(status!=='running')return [];
  const goals=new Set(focus);
  for(const id of focus)for(let parent=parentOf(id);parent&&!goals.has(parent);parent=parentOf(parent))goals.add(parent);
  return [...goals];
}

// When the agent's work ends, hold it once if a Goal it was handed comments on
// still awaits a reply and nothing of it keeps running to wake it later. A stop
// right after a hold always ends.
//   handedAwaiting  Goals with handed comments that still await a reply
//   held            whether its previous stop was held by this rule
export const quietGoals=({handedAwaiting,background,held})=>held||background.length>0?[]:handedAwaiting;
