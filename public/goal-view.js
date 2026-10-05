import {letterState} from './letter-state.js';
import {ownGoalProgress,progressPercent} from './goal-progress.js';
import {executionState,goalState,isRunning} from './goal-state.js';
const icons = {
  pause:'<path d="M8 5v14M16 5v14"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  chevron:'<path d="m9 5 7 7-7 7"/>', arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>',
  message:'<path d="M20 14a3 3 0 0 1-3 3H9l-5 4V6a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3z"/>',
  letter:'<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/>',
  // Tabler Icons "mug" (MIT); attribution in licenses/tabler-icons.txt.
  coffee:'<path d="M4.083 5h10.834a1.08 1.08 0 0 1 1.083 1.077v8.615c0 2.38 -1.94 4.308 -4.333 4.308h-4.334c-2.393 0 -4.333 -1.929 -4.333 -4.308v-8.615a1.08 1.08 0 0 1 1.083 -1.077"/><path d="M16 8h2.5c1.38 0 2.5 1.045 2.5 2.333v2.334c0 1.288 -1.12 2.333 -2.5 2.333h-2.5"/>',
  branch:'<circle cx="6" cy="5" r="2"/><circle cx="18" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><path d="M6 7v10m12-10c0 5-12 4-12 9"/>',
  sun:'<path d="M3 17h18M6 21h12M7 17a5 5 0 0 1 10 0M12 2v3M3 7l3 3M21 7l-3 3"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.arrow}</svg>`;
export const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const href=(id,version)=>`#/goal/${id}${version?`/v${version}`:''}`;
export function createGoalView(goals, currentId, expanded) {
const historyByGoal=Object.fromEntries(Object.entries(goals).map(([id,g])=>[id,g.briefs]));
const collapsed={has:id=>!expanded.has(String(id))};
const latestVersion=id=>historyByGoal[id].at(-1)?.version||0;
const labels={done:'Done',waiting:'Waiting',working:'Running',paused:'Paused'};
function descendants(id){return [id,...goals[id].children.flatMap(descendants)];}
function ancestors(id){const result=[];while(id){result.unshift(id);id=goals[id].parentId;}return result;}
function brandTarget(){
  const root=currentId&&goals[currentId]?ancestors(currentId)[0]:null;
  return root&&root!==currentId?{href:href(root),label:`chill — Root Goal: ${goals[root].title}`}:{href:'#/goals',label:'chill — Goals'};
}
function state(id){return goalState(goals[id],goals[id].children.map(state));}
function status(id){
  const s=state(id);
  if(s==='idle')return '';
  const description=s==='waiting'?(goals[id].waitReason||'Waiting: all unfinished Split Goals need a prerequisite'):s==='working'&&!isRunning(executionState(goals[id]))?'Running in Split Goals':labels[s];
  const activity=goals[id].execution?.activity;
  const tag=s==='paused'&&activity?'a':'span';
  const link=tag==='a'?` href="#/goal/${activity.goalId}/activity/${activity.eventId}"`:'';
  return `<${tag}${link} class="status ${s}" title="${escapeHTML(description)}">${s==='done'?icon('check'):s==='waiting'?icon('coffee'):s==='paused'?icon('pause'):'<span class="dot" aria-hidden="true"></span>'}<span>${labels[s]}</span></${tag}>`;
}
function progress(id){
  const scores=descendants(id).filter(n=>!goals[n].children.length).map(n=>ownGoalProgress(goals[n]));
  const percent=progressPercent(scores,goals[id]);
  const description=`${percent}% · ${scores.filter(score=>score===1).length}/${scores.length} leaf Goals done · Open is capped at 99% · Brief and replies do not affect progress`;
  return `<span class="goal-progress" role="progressbar" aria-label="Progress of Goal ${id}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}" aria-valuetext="${escapeHTML(description)}" title="${escapeHTML(description)}"><svg class="progress-track" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true"><rect class="progress-fill" width="${percent}" height="10"/></svg><span class="progress-value" aria-hidden="true">${percent}%</span></span>`;
}
function pendingLetters(id){return goals[id].conversation.filter(e=>letterState(e,goals[id].conversation)?.status==='open');}
function letterCount(id){return descendants(id).reduce((total,n)=>total+pendingLetters(n).length,0);}
function lettersButton(id){
  const expanded=id!==currentId&&!collapsed.has(id);
  const count=expanded?pendingLetters(id).length:letterCount(id);
  return count?`<button type="button" class="letters-button" data-letters="${id}" aria-label="Letters: ${count} unanswered ${expanded?'in':'under'} ${escapeHTML(goals[id].title)}" title="Unanswered Letters · ${count}">${icon('letter')}<span>${count}</span></button>`:'';
}
function lettersList(id,showHeading=false){
  const letters=pendingLetters(id);
  if(!letters.length)return '';
  return `<section class="goal-letters" aria-label="Letters for ${escapeHTML(goals[id].title)}">${showHeading?'<h3>Letters</h3>':''}<ul class="letter-list">${letters.map(doc=>{
    return `<li class="letter-row pending" data-letter-goal="${id}"><span class="letter-marker" aria-hidden="true">${icon('letter')}</span><div class="letter-card"><a class="letter-title" href="${href(id)}/letter/${doc.id}" data-letter-link title="${escapeHTML(doc.title)}">${escapeHTML(doc.title)}</a></div></li>`;
  }).join('')}</ul></section>`;
}
function breadcrumb(id){
  const parents=ancestors(id).slice(0,-1);
  const rows=parents.map(n=>`<li><a class="crumb-link" href="${href(n)}" title="${escapeHTML(goals[n].title)}"><span class="crumb-name">${escapeHTML(goals[n].title)}</span></a><span class="crumb-separator" aria-hidden="true">/</span></li>`).join('');
  return `<nav class="breadcrumbs" aria-label="Breadcrumb"><div class="breadcrumb-current"><strong class="breadcrumb-label">Goals</strong><span aria-current="page">#${id}</span></div>${parents.length?`<ol class="breadcrumb-ancestors">${rows}</ol>`:''}</nav>`;
}
function treeNodes(ids){return `<ul>${ids.map(id=>{
  const goal=goals[id],canExpand=goal.children.length>0||pendingLetters(id).length>0,open=canExpand&&!collapsed.has(id);
  const contents=canExpand?(goal.children.length?treeNodes(goal.children):'')+lettersList(id):'';
  const toggle=canExpand?`<button type="button" class="tree-row-toggle" aria-expanded="${open}" aria-controls="goal-children-${id}" aria-label="${open?'Collapse':'Expand'} ${escapeHTML(goal.title)}" data-toggle="${id}"><span class="tree-chevron">${icon('chevron')}</span></button>`:`<span class="tree-row-label"><span class="tree-chevron tree-leaf-dot" aria-hidden="true">·</span></span>`;
  return `<li><div class="tree-row${canExpand?'':' tree-leaf'}"${canExpand?` data-row-toggle="${id}"`:''}><div class="tree-identity">${toggle}<a class="tree-name" href="${href(id)}" title="${escapeHTML(goal.title)}">${escapeHTML(goal.title)}</a></div><span class="row-summary">${status(id)}${progress(id)}<span class="letters-slot">${lettersButton(id)}</span></span></div>${canExpand?`<div class="goal-children" id="goal-children-${id}" ${open?'':'hidden'}>${contents}</div>`:''}</li>`;
}).join('')}</ul>`;}
function splitGoals(id){
  const children=goals[id].children;
  if(!children.length&&pendingLetters(id).length===0)return '';
  return `<div class="goal-splits">${children.length?`<section aria-labelledby="splits-heading"><div class="section-heading"><h2 id="splits-heading">Split Goals</h2></div><nav class="tree" aria-label="Split Goals">${treeNodes(children)}</nav></section>`:''}${lettersList(id,true)}</div>`;
}
function pager(id,version){
  const step=(direction,target)=>{
    const previous=direction==='previous',available=target>=1&&target<=latestVersion(id);
    const label=previous?'Previous Brief':'Next Brief';
    const arrow=`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${previous?'M11 3 4 8l7 5Z':'M5 3l7 5-7 5Z'}"/></svg>`;
    return available?`<a class="version-step" data-version-step="${direction}" href="${href(id,target)}" aria-label="${label} · v${target}" title="${label} · v${target}">${arrow}</a>`:`<span class="version-step" role="link" aria-disabled="true" aria-label="${label}">${arrow}</span>`;
  };
  return `<nav class="version-pager" aria-label="Brief history"><span class="history-label">History</span>${step('previous',version-1)}<span class="version-label" aria-label="Version ${version}">v${version}</span>${step('next',version+1)}</nav>`;
}
function brief(id){return `${breadcrumb(id)}<section class="surface goal-brief" aria-labelledby="goal-title"><header class="goal-heading"><h1 id="goal-title">${escapeHTML(goals[id].title)}</h1><div class="goal-topline"><div class="badges">${status(id)}${progress(id)}${lettersButton(id)}</div></div></header>${splitGoals(id)}</section>`;}
function index(){const roots=Object.keys(goals).filter(id=>!goals[id].parentId);return `<div class="goals-index"><h1>Goals</h1>${roots.length?roots.map(id=>`<section class="surface goal-brief"><header class="goal-heading"><h2><a class="goal-index-link" href="${href(id)}">${escapeHTML(goals[id].title)} ↗</a></h2><div class="badges">${status(id)}${progress(id)}<span class="letters-count${letterCount(id)?'':' is-empty'}" aria-label="${letterCount(id)} unanswered Letters under ${escapeHTML(goals[id].title)}" title="Unanswered Letters, including Split Goals">${icon('letter')}<span>${letterCount(id)}</span></span></div></header></section>`).join(''):'<p class="empty-state">No Goals yet. Create a Goal from the CLI to begin.</p>'}</div>`;}
return {brief,index,pager,brandTarget,descendants,letterCount,lettersButton,splitGoals};
}
