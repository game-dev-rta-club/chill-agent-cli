import {briefReadableText} from './brief.mjs';
const safe=value=>String(value??'').replace(/[\x00-\x08\x0b-\x1f\x7f]/g,'');
const line=value=>safe(value).replace(/\s+/g,' ').trim();
const stateLabel=state=>({idle:'Open',working:'Running',paused:'Paused',waiting:'Waiting',done:'Done'}[state]);
const status=goal=>`${stateLabel(goal.state)} · ${goal.progress}% · ${goal.letterCount} unanswered Letters`;
function treeLines(nodes,depth=0) {
  return nodes.flatMap(g=>{
    const pad='  '.repeat(depth),lines=[`${pad}#${g.id} ${line(g.title)} — ${status(g)}`];
    if(g.waitReason)lines.push(`${pad}  Waiting: ${line(g.waitReason)}`);
    if(g.execution?.status==='unknown')lines.push(`${pad}  Execution: unconfirmed`);
    return [...lines,...treeLines(g.children,depth+1)];
  });
}
export function renderGoalPage(page) {
  const {goal,root,brief,conversationInfo:info}=page;
  const path=[...page.ancestors,goal].map(g=>line(g.title)).join(' / ');
  const lines=[`Goal #${goal.id}: ${path}`,`${status(goal)}${goal.execution?.status==='unknown'?' · execution unconfirmed':''}`,`URL: ${page.url}`];
  if(goal.scope)lines.push(`Scope: ${safe(goal.scope)}`);
  if(goal.criteria)lines.push(`Success criteria: ${safe(goal.criteria)}`);
  if(goal.waitReason)lines.push(`Waiting: ${safe(goal.waitReason)}`);
  if(goal.execution)lines.push(`Execution: #${goal.execution.goalId} · ${goal.execution.status}${goal.execution.reason?` · ${line(goal.execution.reason)}`:''}`);
  if(root.id!==goal.id) {
    lines.push('',`Root agreement #${root.id}: ${line(root.title)}`);
    if(root.scope)lines.push(`Scope: ${safe(root.scope)}`);
    if(root.criteria)lines.push(`Success criteria: ${safe(root.criteria)}`);
    lines.push(`Root branches (current):`,...root.branches.map(g=>`  #${g.id} ${line(g.title)} — ${status(g)}${g.waitReason?` · ${line(g.waitReason)}`:''}`));
  }
  lines.push('', 'Split Goals (current)',...(page.splitGoals.length?treeLines(page.splitGoals):['None.']));
  lines.push('',`Letters (unanswered, including Split Goals): ${page.letters.length}`,
    ...page.letters.map(l=>`  #${l.goalId} Letter #${l.id}: ${line(l.title)}\n    ${l.url}`));
  lines.push('',`Brief${brief?` · v${brief.version}${brief.version===page.latestVersion?' (latest)':''}`:''}`,`Editable ${goal.briefPath.endsWith('.html')?'HTML':'Markdown'}: ${goal.briefPath}`);
  if(brief)lines.push('---',safe(briefReadableText(brief.body,brief.format)),'---');
  else lines.push('No Brief published yet. Conversation is available.');
  lines.push('',`Conversation · ${info.returned}/${info.total} messages${info.since?` · after #${info.since}`:''} · cursor ${info.cursor}`);
  for(const letter of page.answerTargets)lines.push(`Answer target · Letter #${letter.id}: ${line(letter.title)}`,safe(letter.text));
  if(!page.conversation.length)lines.push(info.total?'No newer messages.':'No messages yet.');
  for(const e of page.conversation) {
    lines.push('',`#${e.id} ${e.author} · ${e.type}${e.title?` · ${line(e.title)}`:''} · ${e.updatedAt}`,safe(e.text));
    for(const id of e.attachmentIds||[])lines.push(`Image: ${id}`);
    for(const n of e.annotations||[]) {
      if(n.kind==='letter')lines.push(`Answer to Letter #${n.source.eventId}:`);
      else if(n.kind==='text')lines.push(`Annotation · ${n.source.kind==='comment'?`${n.source.field==='title'?'Letter title':'Agent comment'} #${n.source.eventId}`:`Brief v${n.source.version}`} · [${n.anchor.start}, ${n.anchor.end})`,`Quote: ${safe(n.anchor.quote)}`);
      else lines.push(`Image annotation: ${n.imageName?`${line(n.imageName)} · `:''}${n.imageId} · ${JSON.stringify(n.rect)}`);
      lines.push(safe(n.text));
      for(const id of n.attachmentIds||[])lines.push(`Image: ${id}`);
    }
  }
  if(page.attachments.length)lines.push('', 'Attachments',...page.attachments.map(a=>`${a.id} (${a.mimeType})\n  ${a.path}`));
  return lines.join('\n');
}
