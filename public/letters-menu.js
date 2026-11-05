import {letterState,rootLetterSummary,unreadReply,counted,rootOf} from './letter-state.js';
import {browserClientId} from './browser-context.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const envelope='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/></svg>';
const bell='<svg class="header-letter-bell" viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Z"/><path d="M10 21h4"/></svg>';
// Unanswered Letters and unread replies under the current Root (all Roots on the
// index). Letters always list, as they wait for an answer; count is what this
// browser chose to count, per Root.
export function waitingMessages(goals,events,currentId){
 const root=rootLetterSummary(goals,events,currentId)?.rootId,byId=new Map(goals.map(g=>[g.id,g]));
 const belongs=id=>{const seen=new Set();while(id&&!seen.has(id)){if(id===root)return true;seen.add(id);id=byId.get(id)?.parentId;}return !root;};
 const mine=events.filter(e=>byId.has(e.goalId)&&belongs(e.goalId));
 const letters=mine.filter(e=>letterState(e,events)?.status==='open');
 const replies=mine.filter(e=>unreadReply(e,byId.get(e.goalId))&&counted(rootOf(byId,e.goalId),'replies'));
 return {letters,replies,count:replies.length+letters.filter(e=>counted(rootOf(byId,e.goalId),'letters')).length};
}
export function createLettersMenu({button,panel,readReplies,countsChanged}){
 const body=document.createElement('div'),foot=document.createElement('div'),status=document.createElement('p');
 foot.className='letters-foot';foot.hidden=true;status.className='extension-message';status.setAttribute('role','status');panel.append(body,status,foot);
 let signature='',shownReplies=[],latest=null,control=null,rootId=null,counts=null,notify=null;
 const close=(restore=false)=>{panel.hidden=true;button.setAttribute('aria-expanded','false');if(restore)button.focus({preventScroll:true});};
 button.onclick=()=>{const opening=panel.hidden;panel.hidden=!opening;button.setAttribute('aria-expanded',String(opening));if(opening)panel.querySelector('a,button')?.focus();};
 panel.addEventListener('click',e=>{if(e.target.closest('[data-replies-read]'))readReplies(shownReplies);else if(e.target.closest('[data-letters-close]'))close(true);else if(e.target.closest('a'))close();});
 document.addEventListener('pointerdown',e=>{if(!panel.contains(e.target)&&!button.contains(e.target))close();});
 document.addEventListener('focusin',e=>{if(!panel.contains(e.target)&&!button.contains(e.target))close();});
 document.addEventListener('keydown',e=>{if(!panel.hidden&&e.key==='Escape'){e.preventDefault();close(true);}});
 const api=signal=>async(path,payload)=>{
  const response=await fetch(`/api/extensions/${control.id}/${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),cache:'no-store',signal:AbortSignal.any([signal,AbortSignal.timeout(60000)])});
  const result=await response.json();if(!response.ok)throw Error(result.error||'Could not save.');return result;
 };
 const changed=()=>window.dispatchEvent(new CustomEvent('chill-extensions-changed'));
 body.addEventListener('change',async e=>{
  const kind=e.target.dataset.count;if(!kind)return;
  const before=counts,root=rootId,next={...counts,[kind]:e.target.checked};
  status.textContent='';countsChanged(root,next);
  try{await api(AbortSignal.timeout(60000))('kinds',{goalId:latest.currentId,rootId:root,deviceId:browserClientId(),...next});countsChanged(root,next);changed();}
  catch(error){countsChanged(root,before);status.textContent=error.message;}
 });
 // The last row belongs to the extension, and lasts while the Goal stays open.
 async function showNotify(goalId){
  const key=control&&goalId;
  if(notify?.key===key){notify?.view?.update(control);return;}
  notify?.abort.abort();notify=null;foot.replaceChildren();foot.hidden=!key;
  if(!key)return;
  const mine=notify={key,abort:new AbortController()},{signal}=mine.abort;
  try{
   const module=await import(control.panelModule);if(signal.aborted)return;
   mine.view=await module.mount({element:foot,control,goalId,clientId:browserClientId(),api:api(signal),changed,signal});
  }catch(error){if(!signal.aborted)foot.textContent=error.message;}
 }
 function update(goals,events,currentId){
  latest={goals,events,currentId};
  const {letters,replies,count}=waitingMessages(goals,events,currentId),root=rootOf(new Map(goals.map(g=>[g.id,g])),currentId),notifying=Boolean(control?.enabled);
  shownReplies=replies;rootId=root?.id??null;counts={letters:counted(root,'letters'),replies:counted(root,'replies')};
  button.classList.toggle('is-on',count>0);button.setAttribute('aria-label',`Letters · ${letters.length} unanswered, ${replies.length} unread replies · ${count?'On':'Off'} · Notification ${notifying?'on':'off'}`);
  const markup=envelope+(notifying?bell:'')+`<span class="header-letter-count">${count}</span>`;
  if(button.innerHTML!==markup)button.innerHTML=markup;
  const switches=Boolean(control&&rootId&&browserClientId());
  const item=e=>[e.id,e.title,e.goalId,goals.find(g=>g.id===e.goalId)?.title];
  const next=JSON.stringify([currentId,letters.map(item),replies.map(item),switches,counts]);
  if(next!==signature){
   signature=next;
   const list=items=>`<ul class="header-letter-list">${items.map(e=>`<li><a href="#/goal/${e.goalId}/letter/${e.id}"><strong>${esc(e.title||goals.find(g=>g.id===e.goalId)?.title)}</strong><small>${esc(e.title?goals.find(g=>g.id===e.goalId)?.title:Array.from(e.text||'').slice(0,80).join(''))}</small></a></li>`).join('')}</ul>`;
   const toggle=(kind,label)=>switches?`<label class="agent-extension letters-switch"><input type="checkbox" role="switch" data-count="${kind}" aria-label="Count ${label} in the tab title"${counts[kind]?' checked':''}></label>`:'';
   const showReplies=counts.replies||!rootId,focused=document.activeElement?.dataset?.count;
   body.innerHTML=`<div class="agent-panel-heading"><h2>Letters <small>${letters.length}</small></h2><div class="letters-tools">${toggle('letters','Letters')}<button type="button" data-letters-close aria-label="Close Letters">×</button></div></div>${letters.length?list(letters):'<p class="agent-muted">No unanswered Letters.</p>'}`
    +`<div class="agent-panel-heading replies-heading"><h2>Replies${showReplies?` <small>${replies.length}</small>`:''}</h2><div class="letters-tools is-aligned">${replies.length?'<button type="button" class="replies-read" data-replies-read>Mark all read</button>':''}${toggle('replies','Replies')}</div></div>${showReplies?replies.length?list(replies):'<p class="agent-muted">No unread replies.</p>':''}`;
   if(focused)body.querySelector(`[data-count="${focused}"]`)?.focus();
  }
  void showNotify(rootId&&currentId);
 }
 return {close,update,controlsChanged(controls){
  control=controls.find(c=>c.placement==='letters')||null;
  if(latest)update(latest.goals,latest.events,latest.currentId);
 }};
}
