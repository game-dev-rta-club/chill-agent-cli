// Native Read adds line-number gutters. Verify the complete returned guide,
// not just a requested path or a model's claim that it read the reference.
export function returnedDocument(messages,document) {
  const uses=new Map(messages.flatMap(m=>Array.isArray(m.message?.content)?m.message.content.filter(c=>c.type==='tool_use').map(c=>[c.id,c]):[]));
  return messages.some(m=>Array.isArray(m.message?.content)&&m.message.content.some(c=>{
    if(c.type!=='tool_result'||c.is_error)return false;
    let text=typeof c.content==='string'?c.content:(c.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');
    if(uses.get(c.tool_use_id)?.name==='Read')text=text.replace(/^[ \t]*\d+(?:→|\t)/gm,'');
    return text.includes(document.trim());
  }));
}
