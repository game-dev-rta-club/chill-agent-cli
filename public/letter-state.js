// User answers and Agent receipt are explicit; ordinary comments leave Letters alone.
export function letterState(letter, conversation = []) {
  if (letter?.type !== 'letter' || letter.author !== 'agent') return null;
  // Compatibility: historical no-reply records must not become unanswered.
  if (letter.replyRequired === false) return {status: 'notice', lastAnswerId: null};
  const answer = conversation.findLast(entry => entry.goalId === letter.goalId && entry.author === 'user'
    && entry.annotations?.some(note => note.kind === 'letter' && note.source?.kind === 'comment' && note.source.eventId === letter.id));
  return {status: letter.receivedAt ? 'received' : letter.letterStatus?.status || (answer ? 'answered' : 'open'), lastAnswerId: Math.max(answer?.id || 0, letter.letterStatus?.lastAnswerId || 0) || null};
}

export function rootLetterSummary(goals,conversation,currentId){
  const byId=new Map(goals.map(goal=>[goal.id,goal]));
  let root=byId.get(currentId);
  if(!root)return null;
  while(root.parentId&&byId.has(root.parentId))root=byId.get(root.parentId);
  const children=new Map();
  for(const goal of goals){const list=children.get(goal.parentId)||[];list.push(goal.id);children.set(goal.parentId,list);}
  const ids=new Set(),visit=id=>{if(ids.has(id))return;ids.add(id);for(const child of children.get(id)||[])visit(child);};
  visit(root.id);
  const relevant=conversation.filter(event=>ids.has(event.goalId));
  return {rootId:root.id,title:root.title,count:relevant.filter(event=>letterState(event,relevant)?.status==='open').length};
}
export function letterTabTitle(summary){return summary?`${summary.count?`(${summary.count}) `:''}${summary.title} · chill`:'Goals · chill';}
