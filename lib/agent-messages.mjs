// Every message an agent writes in its conversation is posted, in order, as an
// agent Comment on the conversation's current Goal. A conversation has one
// current Goal: the Goal it was last handed feedback on, replied on, or woken
// for. Feedback from several Goals at once leaves none until the agent replies
// on one, so nothing is posted to a Goal the message may not be about.
//
// A harness reads the new part of its own transcript into items and keeps the
// state below in its own per-conversation record; what is posted, and where,
// is decided here once for every harness.
//   items  in transcript order: {type:'text',id,text} | {type:'tool'} | {type:'nudge'}
//          `id` is stable per text block, so a block read twice posts once;
//          'nudge' is a Keep going request chill sent to the conversation.
//   state  {path,offset}  how far the transcript was read
//          nudged, held   a Keep going request with no tool call since, and the
//                         text written after it: the one-line "nothing to do"
//                         answer is not posted, a reply that runs a tool is
//          last           the text of the last block read
//          unseen         a Stop's last message posted before the transcript showed it,
//                         skipped when it is the next block the transcript shows
import {createHash} from 'node:crypto';
import {open,stat} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import {appendPostedMessage} from './goal-store.mjs';
import {ownedRoots} from './hand-off.mjs';
import {hidden,recordHidden} from './hidden-failure.mjs';

// The first line of every Keep going request (continuation-monitor).
export const keepGoingHeading='=== chill-agent · Keep going ===';

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

// Post the messages in `items` to `current`, and return the next state.
//   owns     picks the conversation's Roots (hand-off ownedRoots)
//   key      names the harness and conversation, for each post's request ID
//   stop     at a Stop: {id,text}, the response's last message as the harness
//            reports it; posted when the transcript does not show it (yet)
//   position the transcript position after `items` (readNewLines)
// Returns {state,current,posted}. A current Goal the conversation no longer
// owns is dropped.
export async function postMessages(owns,{current,state={},items,stop=null,key,position}) {
  let {nudged=false,held=[],last=null,unseen=null}=state;
  const posts=[];
  for(const item of items){
    if(item.type==='nudge'){nudged=true;held=[];continue;}
    if(item.type==='tool'){if(nudged){posts.push(...held);held=[];nudged=false;}continue;}
    const text=typeof item.text==='string'?item.text.trim():'';
    if(!text)continue;
    last=text;
    // The next block after a Stop's posted last message is that message, when the transcript had not shown it.
    const shown=unseen===text;unseen=null;
    if(!shown)(nudged?held:posts).push({id:item.id,text});
  }
  if(stop){
    const text=typeof stop.text==='string'?stop.text.trim():'';
    // Without a transcript, the request ID keeps a repeated Stop's message single.
    if(text&&(!position||text!==last&&!(last&&text.endsWith(last)))){
      if(!nudged)posts.push({id:`stop:${stop.id}:${digest(text)}`,text});
      last=unseen=text;
    }
    // A Keep going request answered without running a tool: that answer is not posted.
    nudged=false;held=[];
  }
  const next={...(position??{}),nudged,held,last,unseen};
  if(current==null||!posts.length)return {state:next,current:current??null,posted:[]};
  const root=(await ownedRoots(owns)).roots.find(r=>r.goals.some(g=>g.id===current));
  if(!root)return {state:next,current:null,posted:[]};
  const posted=[];
  for(const post of posts){
    // The post answers the comments handed so far: one saved meanwhile still awaits its own reply.
    const event=await appendPostedMessage({goalId:current,text:post.text,requestId:`post-${digest([...key,post.id])}`,answers:root.state.cursor}).catch(hidden('agent-messages.post'));
    if(event)posted.push(event);
  }
  return {state:next,current,posted};
}

// The new items of a transcript; `parse(lines,heading)` is the harness's reader.
export async function readMessages(state,path,parse) {
  const {lines,position}=await readNewLines(state,path);
  return {items:lines.length?parse(lines,keepGoingHeading):[],position};
}
