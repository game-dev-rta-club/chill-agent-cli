// What agent-messages reads from new lines of a Codex chat's transcript (the
// rollout file its hooks name as transcript_path): the chat's tool calls and
// the Keep going requests chill queued as its next message. Tool input or
// output is never read.
const kind=/"type":"response_item","payload":\{"type":"([a-z_]+)"/;
export function codexMessageItems(lines,heading) {
  const items=[];
  for(const {line} of lines){
    // The record's type comes before its payload, which may be a long tool output.
    const type=kind.exec(line.subarray(0,300).toString('utf8'))?.[1];
    if(!type)continue;
    if(type.endsWith('_call')){items.push({type:'tool'});continue;}
    if(type!=='message')continue;
    let payload;try{payload=JSON.parse(line.toString('utf8')).payload;}catch{continue;}
    const parts=payload?.role==='user'&&Array.isArray(payload.content)?payload.content:[];
    if(parts.some(part=>part?.type==='input_text'&&typeof part.text==='string'&&part.text.trimStart().startsWith(heading)))items.push({type:'nudge'});
  }
  return items;
}
