import {letterState,rootLetterSummary} from './letter-state.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const envelope='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/></svg>';
export function openLetters(goals,events,currentId){
 const root=rootLetterSummary(goals,events,currentId)?.rootId,byId=new Map(goals.map(g=>[g.id,g]));
 const belongs=id=>{const seen=new Set();while(id&&!seen.has(id)){if(id===root)return true;seen.add(id);id=byId.get(id)?.parentId;}return !root;};
 return events.filter(e=>byId.has(e.goalId)&&belongs(e.goalId)&&letterState(e,events)?.status==='open');
}
export function createLettersMenu({button,panel}){
 let signature='';
 const close=(restore=false)=>{panel.hidden=true;button.setAttribute('aria-expanded','false');if(restore)button.focus({preventScroll:true});};
 button.onclick=()=>{const opening=panel.hidden;panel.hidden=!opening;button.setAttribute('aria-expanded',String(opening));if(opening)panel.querySelector('a,button')?.focus();};
 panel.addEventListener('click',e=>{if(e.target.closest('[data-letters-close]'))close(true);else if(e.target.closest('a'))close();});
 document.addEventListener('pointerdown',e=>{if(!panel.contains(e.target)&&!button.contains(e.target))close();});
 document.addEventListener('focusin',e=>{if(!panel.contains(e.target)&&!button.contains(e.target))close();});
 document.addEventListener('keydown',e=>{if(!panel.hidden&&e.key==='Escape'){e.preventDefault();close(true);}});
 return {close,update(goals,events,currentId){
  const letters=openLetters(goals,events,currentId),count=letters.length;
  button.classList.toggle('is-on',count>0);button.setAttribute('aria-label',`Letters · ${count} unanswered · ${count?'On':'Off'}`);
  const markup=envelope+`<span class="header-letter-count">${count}</span>`;
  if(button.innerHTML!==markup)button.innerHTML=markup;
  const next=JSON.stringify([currentId,letters.map(l=>[l.id,l.title,l.goalId,goals.find(g=>g.id===l.goalId)?.title])]);
  if(next===signature)return;signature=next;
  panel.innerHTML=`<div class="agent-panel-heading"><h2>Letters <small>${count}</small></h2><button type="button" data-letters-close aria-label="Close Letters">×</button></div>${count?`<ul class="header-letter-list">${letters.map(l=>`<li><a href="#/goal/${l.goalId}/letter/${l.id}"><strong>${esc(l.title)}</strong><small>${esc(goals.find(g=>g.id===l.goalId)?.title)}</small></a></li>`).join('')}</ul>`:'<p class="agent-muted">No unanswered Letters.</p>'}`;
 }};
}
