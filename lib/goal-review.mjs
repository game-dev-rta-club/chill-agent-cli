export const stateLabels={idle:'Open',working:'Running',paused:'Paused',waiting:'Waiting',done:'Done'};
export const reviewStates=['all','unfinished','open','running','paused','waiting','done'];
export const oneLine=value=>String(value??'').replace(/[\x00-\x1f\x7f\s]+/g,' ').trim();
const short=value=>{const text=oneLine(value);return text.length>180?text.slice(0,179)+'…':text;};

function flatten(roots) {
 const rows=[];
 const visit=(goal,ancestors)=>{rows.push({goal,ancestors,index:rows.length});for(const child of goal.children||[])visit(child,[...ancestors,goal.id]);};
 for(const root of roots)visit(root,[]);
 return rows;
}
export function summarizeGoals(roots) {
 const goals=flatten(roots).map(r=>r.goal),counts={open:0,running:0,paused:0,waiting:0,done:0};
 for(const g of goals)counts[stateLabels[g.state].toLowerCase()]++;
 return {total:goals.length,unfinished:goals.filter(g=>g.state!=='done').length,letters:goals.reduce((n,g)=>n+(g.letters?.length||0),0),...counts};
}
export function reviewGoals(roots,{state='all',letters=false,after,limit=50}={}) {
 if(!reviewStates.includes(state))throw Error('Unknown review state.');
 if(!Number.isSafeInteger(limit)||limit<1||limit>200)throw Error('--limit must be an integer from 1 to 200.');
 const all=flatten(roots),cursor=after===undefined?-1:all.findIndex(r=>r.goal.id===after);
 if(after!==undefined&&cursor===-1)throw Error('Cursor Goal is no longer in this subtree. Run review again without --after.');
 const matches=all.filter(r=>(state==='all'||(state==='unfinished'?r.goal.state!=='done':stateLabels[r.goal.state].toLowerCase()===state))&&(!letters||r.goal.letters?.length));
 const remaining=matches.filter(r=>r.index>cursor),page=remaining.slice(0,limit),selected=new Set(page.map(r=>r.goal.id));
 const visible=new Set(page.flatMap(r=>[...r.ancestors,r.goal.id]));
 return {rootId:roots[0]?.id,state,letters,limit,after,summary:summarizeGoals(roots),matched:matches.length,returned:page.length,
  remaining:remaining.length-page.length,next:remaining.length>page.length?page.at(-1).goal.id:null,
  rows:all.filter(r=>visible.has(r.goal.id)).map(r=>({...r,context:!selected.has(r.goal.id)}))};
}
export function renderGoalReview(review) {
 const {rootId,state,letters,summary,matched,returned,remaining,next,rows}=review;
 const base=`chill goal review --id ${rootId}`,filter=`${state==='all'?'':` --state ${state}`}${letters?' --letters':''}`;
 const counts=Object.keys(summary).filter(k=>['open','running','paused','waiting','done'].includes(k)&&summary[k]).map(k=>`${summary[k]} ${k[0].toUpperCase()+k.slice(1)}`).join(' · ');
 const lines=[`Goals under #${rootId} · ${returned} shown / ${matched} matching / ${summary.total} total`,counts];
 if(!returned)lines.push('',matched?'No more matching Goals.':`No ${state==='all'?'':state+' '}Goals${letters?' with unanswered Letters':''}.`);
 for(const {goal:g,ancestors,context} of rows) {
  const extras=[];
  if(context)extras.push('context');
  if(g.letters?.length)extras.push(`${g.letters.length} Letter${g.letters.length===1?'':'s'}`);
  if(g.waitReason)extras.push(short(g.waitReason));
  if(g.execution?.status==='unknown')extras.push('execution unconfirmed');
  lines.push(`${'  '.repeat(ancestors.length)}#${g.id} [${stateLabels[g.state]} · ${g.progress}%] ${oneLine(g.title)}${extras.length?' | '+extras.join(' · '):''}`);
 }
 if(rows.some(r=>r.context))lines.push('Context rows preserve ancestry; they are not counted in this page.');
 if(next)lines.push('',`${remaining} more matching Goals: ${base}${filter} --limit ${review.limit} --after ${next}`);
 lines.push('','Read a Goal: chill goal show --id <ID> --format text');
 if(state!=='all'||letters)lines.push(`All: ${base}`);
 if(summary.unfinished&&state!=='unfinished')lines.push(`Unfinished: ${base} --state unfinished`);
 for(const key of ['open','waiting'])if(summary[key]&&state!==key)lines.push(`${key==='open'?'Open':'Waiting'}: ${base} --state ${key}`);
 if(summary.letters&&!letters)lines.push(`Letters: ${base} --letters`);
 return lines.join('\n');
}
