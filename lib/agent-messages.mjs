// The last message of each turn an agent takes is posted as an agent Comment
// on the conversation's current Goal at that moment; what it writes during the
// turn is not. A conversation has one current Goal: the Goal it was last handed
// feedback on, replied on, or woken for. Feedback from several Goals at once
// leaves none until the agent replies on one, so nothing is posted to a Goal
// the message may not be about.
//
// The last message comes with the end of the turn (Claude's Stop hook, Codex's
// turn end). A harness also reads the new part of its own transcript into items,
// only to tell whether that message answers a Keep going request, and keeps the
// state below in its own per-conversation record; what is posted, and where, is
// decided here once for every harness.
//   items  in transcript order: {type:'tool'} | {type:'nudge'}
//          'nudge' is a Keep going request chill sent to the conversation.
//   state  {path,offset}  how far the transcript was read
//          nudged         a Keep going request with no tool call since: the
//                         one-line "nothing to do" answer is not posted, the
//                         last message of a turn that runs a tool is
import {createHash} from 'node:crypto';
import {open,stat} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {appendPostedMessage} from './goal-store.mjs';
import {ownedRoots} from './hand-off.mjs';
import {hidden,recordHidden} from './hidden-failure.mjs';

// The first line of every Keep going request (continuation-monitor).
export const keepGoingHeading='=== chill-agent · Keep going ===';
// What every hook that names the current Goal tells the agent about it.
export const lastMessageNotice=goalId=>`The last message of each turn is posted to Goal #${goalId} as written; write it in the user's language.`;

// The current Goal after a hand-off of `events`: the one Goal they come from;
// none when they come from several; unchanged when nothing was handed.
export function currentAfterHandOff(current,events) {
  const goals=[...new Set(events.map(e=>e.goalId))];
  return goals.length===0?current??null:goals.length===1?goals[0]:null;
}

export const validTranscriptPath=value=>typeof value==='string'&&value.length<4096&&isAbsolute(value)&&value.endsWith('.jsonl')&&!/[\x00-\x1f]/.test(value);

// The complete lines written to `path` since `state` read it, each with its
// byte offset. A transcript seen for the first time (or replaced) is read from
// its current end: what was written before is not this connection's to post.
export async function readNewLines(state,path) {
  if(!validTranscriptPath(path))return {lines:[],position:state?.path?{path:state.path,offset:state.offset}:null};
  let file;
  try {
    const {size}=await stat(path);
    if(state?.path!==path||!Number.isSafeInteger(state.offset)||size<state.offset)return {lines:[],position:{path,offset:size}};
    if(size===state.offset)return {lines:[],position:{path,offset:size}};
    file=await open(path,'r');
    const buffer=Buffer.alloc(size-state.offset);
    const {bytesRead}=await file.read(buffer,0,buffer.length,state.offset);
    const data=buffer.subarray(0,bytesRead),lines=[];
    let start=0;
    for(let i=0;i<data.length;i++){
      if(data[i]!==10)continue;
      lines.push({at:state.offset+start,line:data.subarray(start,i)});start=i+1;
    }
    // An incomplete last line is read again once it is written.
    return {lines,position:{path,offset:state.offset+start}};
  } catch(error) {
    if(error.code!=='ENOENT')recordHidden('agent-messages.transcript',error);
    return {lines:[],position:state?.path?{path:state.path,offset:state.offset}:null};
  } finally {await file?.close();}
}

const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,40);

// Post the turn's last message to `current`, and return the next state.
//   owns     picks the conversation's Roots (hand-off ownedRoots)
//   key      names the harness and conversation, for the post's request ID
//   stop     at the end of a turn: {id,text}, its last message as the harness
//            reports it; the request ID keeps a repeated Stop's message single
//   position the transcript position after `items` (readNewLines)
// A Stop with no text posts nothing, even when the transcript shows text.
// Returns {state,current,posted}. A current Goal the conversation no longer
// owns is dropped.
export async function postMessages(owns,{current,state={},items,stop=null,key,position}) {
  let nudged=state.nudged===true,post=null;
  for(const item of items){
    if(item.type==='nudge')nudged=true;
    else if(item.type==='tool')nudged=false;
  }
  if(stop){
    const text=typeof stop.text==='string'?stop.text.trim():'';
    // A Keep going request answered without running a tool: that answer is not posted.
    if(text&&!nudged)post={id:`stop:${stop.id}:${digest(text)}`,text};
    nudged=false;
  }
  const next={...(position??{}),nudged};
  if(current==null||!post)return {state:next,current:current??null,posted:[]};
  const root=(await ownedRoots(owns)).roots.find(r=>r.goals.some(g=>g.id===current));
  if(!root)return {state:next,current:null,posted:[]};
  // The post answers the comments handed so far: one saved meanwhile still awaits its own reply.
  const event=await appendPostedMessage({goalId:current,text:post.text,requestId:`post-${digest([...key,post.id])}`,answers:root.state.cursor}).catch(hidden('agent-messages.post'));
  return {state:next,current,posted:event?[event]:[]};
}

// The new items of a transcript; `parse(lines,heading)` is the harness's reader.
export async function readMessages(state,path,parse) {
  const {lines,position}=await readNewLines(state,path);
  return {items:lines.length?parse(lines,keepGoingHeading):[],position};
}
