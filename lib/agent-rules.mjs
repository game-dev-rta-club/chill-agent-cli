// The rules for what an agent is doing, whether the user is waiting for a reply,
// and when to hand comments to the agent. They are written once for every
// harness: a harness only reports what happened (`nextWork`) and carries out
// what these rules decide. Nothing here reads files, transcripts or agent output.

// What an agent is doing, kept per conversation:
//   phase       'idle' | 'working' | 'interrupted' | 'ended'
//   background  how many of its background tasks still run
//   goals       Goals it was handed comments on during the current work
//   lastGoal    the Goal it was last handed comments on or last spoke in
export const idleWork=Object.freeze({phase:'idle',background:0,goals:[],lastGoal:null});

// What a harness reports:
//   {type:'started'}            the agent began working: a prompt, a wake, a continued stop
//   {type:'handed',goals}       chill handed it comments on these Goals
//   {type:'commented',goalId}   it wrote a Comment or Letter
//   {type:'background',count}   how many of its background tasks still run
//   {type:'finished'}           its work ended and nothing continued it
//   {type:'interrupted'}        its work was stopped from its own side: Esc, a Desktop stop, an API error
//   {type:'ended'}              the conversation ended
export function nextWork(work,event) {
  switch(event.type){
    case 'started':return {...work,phase:'working'};
    case 'handed':return {...work,goals:[...new Set([...work.goals,...event.goals])],lastGoal:event.goals.at(-1)??work.lastGoal};
    case 'commented':return {...work,lastGoal:event.goalId};
    case 'background':return {...work,background:event.count};
    case 'finished':return {...work,phase:'idle',goals:[]};
    case 'interrupted':return {...work,phase:'interrupted',goals:[]};
    case 'ended':return {...work,phase:'ended',background:0,goals:[]};
  }
  throw new Error(`Unknown agent work event: ${event.type}`);
}

// The one status shown for an agent. A harness that cannot be read is unknown,
// never idle. Background tasks keep the agent Running after its own work ends.
export function agentStatus({linked=true,known=true,paused=false,work}) {
  if(!linked||work.phase==='ended')return 'unlinked';
  if(paused)return 'paused';
  if(!known)return 'unknown';
  if(work.phase==='working'||work.background>0)return 'running';
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

// Goals shown Running: while the agent runs, the Goals of its current work that
// still await a reply, the Goal it selected, and otherwise the Goal it last
// worked in. A parent runs while a child runs.
//   awaits(goalId)    whether the Goal awaits a reply
//   parentOf(goalId)  its parent's ID, or null for a Root
export function runningGoals({status,work,selected=null,awaits,parentOf}) {
  if(status!=='running')return [];
  const goals=new Set(work.goals.filter(awaits));
  if(selected)goals.add(selected);
  if(!goals.size&&work.lastGoal)goals.add(work.lastGoal);
  for(const id of [...goals])for(let parent=parentOf(id);parent&&!goals.has(parent);parent=parentOf(parent))goals.add(parent);
  return [...goals];
}

// When the agent's work ends, hold it once if a Goal it was handed comments on
// still awaits a reply and nothing of it keeps running to wake it later. A stop
// right after a hold always ends.
//   handedAwaiting  Goals with handed comments that still await a reply
//   held            whether its previous stop was held by this rule
export const quietGoals=({handedAwaiting,background,held})=>held||background>0?[]:handedAwaiting;
