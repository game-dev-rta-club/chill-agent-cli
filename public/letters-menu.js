import {letterState,rootLetterSummary,unreadReply} from './letter-state.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const envelope='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/></svg>';
// Unanswered Letters and unread notified replies under the current Root (all Roots on the index).
export function waitingMessages(goals,events,currentId){
 const root=rootLetterSummary(goals,events,currentId)?.rootId,byId=new Map(goals.map(g=>[g.id,g]));
 const belongs=id=>{const seen=new Set();while(id&&!seen.has(id)){if(id===root)return true;seen.add(id);id=byId.get(id)?.parentId;}return !root;};
 const mine=events.filter(e=>byId.has(e.goalId)&&belongs(e.goalId));
 return {letters:mine.filter(e=>letterState(e,events)?.status==='open'),replies:mine.filter(e=>unreadReply(e,byId.get(e.goalId)))};
}
export function createLettersMenu({button,panel,readReplies}){
 let signature='',shownReplies=[];
 const close=(restore=false)=>{panel.hidden=true;button.setAttribute('aria-expanded','false');if(restore)button.focus({preventScroll:true});};
 button.onclick=()=>{const opening=panel.hidden;panel.hidden=!opening;button.setAttribute('aria-expanded',String(opening));if(opening)panel.querySelector('a,button')?.focus();};
 panel.addEventListener('click',e=>{if(e.target.closest('[data-replies-read]'))readReplies(shownReplies);else if(e.target.closest('[data-letters-close]'))close(true);else if(e.target.closest('a'))close();});
 document.addEventListener('pointerdown',e=>{if(!panel.contains(e.target)&&!button.contains(e.target))close();});
 document.addEventListener('focusin',e=>{if(!panel.contains(e.target)&&!button.contains(e.target))close();});
 document.addEventListener('keydown',e=>{if(!panel.hidden&&e.key==='Escape'){e.preventDefault();close(true);}});
 return {close,update(goals,events,currentId){
  const {letters,replies}=waitingMessages(goals,events,currentId),count=letters.length+replies.length;
  shownReplies=replies;
  button.classList.toggle('is-on',count>0);button.setAttribute('aria-label',`Letters · ${letters.length} unanswered, ${replies.length} unread replies · ${count?'On':'Off'}`);
  const markup=envelope+`<span class="header-letter-count">${count}</span>`;
  if(button.innerHTML!==markup)button.innerHTML=markup;
  const item=e=>[e.id,e.title,e.goalId,goals.find(g=>g.id===e.goalId)?.title];
  const next=JSON.stringify([currentId,letters.map(item),replies.map(item)]);
  if(next===signature)return;signature=next;
  const list=items=>`<ul class="header-letter-list">${items.map(e=>`<li><a href="#/goal/${e.goalId}/letter/${e.id}"><strong>${esc(e.title||goals.find(g=>g.id===e.goalId)?.title)}</strong><small>${esc(e.title?goals.find(g=>g.id===e.goalId)?.title:Array.from(e.text||'').slice(0,80).join(''))}</small></a></li>`).join('')}</ul>`;
  panel.innerHTML=`<div class="agent-panel-heading"><h2>Letters <small>${letters.length}</small></h2><button type="button" data-letters-close aria-label="Close Letters">×</button></div>${letters.length?list(letters):'<p class="agent-muted">No unanswered Letters.</p>'}`
   +(replies.length?`<div class="agent-panel-heading replies-heading"><h2>Replies <small>${replies.length}</small></h2><button type="button" class="replies-read" data-replies-read>Mark all read</button></div>${list(replies)}`:'');
 }};
}
