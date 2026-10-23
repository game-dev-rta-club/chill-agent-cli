// What agent-messages posts from new lines of a Codex chat's transcript (the
// rollout file its hooks name as transcript_path): each public text part of the
// agent's messages, commentary and final answer alike, its tool calls, and the
// Keep going requests chill queued as the chat's next message. Reasoning and
// tool input or output are never read as text.
const kind=/"type":"response_item","payload":\{"type":"([a-z_]+)"/;
export function codexMessageItems(lines,heading) {
  const items=[];
  for(const {at,line} of lines){
    // The record's type comes before its payload, which may be a long tool output.
    const type=kind.exec(line.subarray(0,300).toString('utf8'))?.[1];
    if(!type)continue;
    if(type.endsWith('_call')){items.push({type:'tool'});continue;}
    if(type!=='message')continue;
    let payload;try{payload=JSON.parse(line.toString('utf8')).payload;}catch{continue;}
    const parts=Array.isArray(payload?.content)?payload.content:[];
    if(payload.role==='user'){
      if(parts.some(part=>part?.type==='input_text'&&typeof part.text==='string'&&part.text.trimStart().startsWith(heading)))items.push({type:'nudge'});
      continue;
    }
    if(payload.role!=='assistant')continue;
    parts.forEach((part,index)=>{if(part?.type==='output_text'&&typeof part.text==='string')items.push({type:'text',id:`${payload.id??`@${at}`}:${index}`,text:part.text});});
  }
  return items;
}
